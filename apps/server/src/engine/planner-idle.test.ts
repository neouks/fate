import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {openDatabase} from '../db/index.js';
import {blackboardRevision} from '../db/worker-drafts.js';
import {Engine,defaultEngineConfig,type EngineActivity} from './engine.js';
import {configureAgentEnv,runPlannerRound} from '../agent/roles.js';
import {TodoStore} from '../tools/context.js';
import {plannerDispatchReminder} from '../agent/worker-assignment.js';
import previous from '../agent/fixtures/pre-planner-continuation.json' with {type:'json'};
import {PLANNER_PROMPT,PLANNER_WRAPUP} from '../agent/prompts.js';
import {migratePlannerContinuation,PLANNER_CONTINUATION_MIGRATION} from '../agent/planner-continuation-migration.js';

const dsn=process.env.TEST_PLANNER_IDLE_DSN;
test('isolated 4898 idle reproduction, native model rounds, recovery and controls',{skip:!dsn&&'isolated PostgreSQL required',timeout:120_000},async t=>{
  assert.match(new URL(dsn!).pathname,/^\/test_[a-z0-9_]+$/);process.env.SERIES_PG_DSN=dsn;
  const db=await openDatabase(),dir=await mkdtemp(join(tmpdir(),'fate-planner-idle-'));
  await mkdir(join(dir,'skills'));configureAgentEnv({skillsDir:join(dir,'skills')});
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
  const faux=fauxProvider({provider:'planner-idle-fixture'});await runtime.registerNativeProvider(faux.provider);
  const model={modelRuntime:runtime,model:faux.getModel()};
  const engines:Engine[]=[];let resolutions=0,failNext=false;const resolutionTimes:number[]=[];
  const makeEngine=(context:TestContext)=>{
    const engine=new Engine(db,{...defaultEngineConfig(),debounceMs:5,heartbeatMs:1000},async sub=>{
      resolutions++;resolutionTimes.push(Date.now());if(failNext){failNext=false;throw new Error('synthetic model unavailable');}return model;
    },dir);engines.push(engine);context.after(()=>engine.shutdown());return engine;
  };
  t.after(async()=>{for(const e of engines)await e.shutdown();await db.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const until=async(check:()=>boolean|Promise<boolean>,timeout=12_000)=>{
    const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await wait(25);}assert.fail('fixture did not reach expected state');
  };
  const fixture=async()=>{
    const exp=await db.createExploration('4898 isolated shape','核验合成结果');
    const task=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,status,plan_heartbeat_seconds) VALUES('local fixture','核验合成结果',$1,'running',1) RETURNING id",[exp])).rows[0]!.id);
    const graph=db.exploration(exp),goal=await graph.addGoal({text:'核验合成结果'},'user');return {exp,task,graph,goal};
  };
  const idleResponses=()=>faux.setResponses(Array.from({length:100},()=>fauxAssistantMessage('未实际派单：缺少用户提供的合成输入，等待补充后核验。')));
  const results=(engine:Engine,task:number)=>{
    const rows:EngineActivity[]=[];engine.bus.on('activity',a=>{if(a.taskID===task&&a.worker==='planner'&&a.kind==='result')rows.push(a);});return rows;
  };
  const settled=(engine:Engine,task:number)=>!(engine as any).rt(task)?.plannerReserved;

  await t.test('zero dispatch with historical work remains running and reviews unchanged blackboard on heartbeat',async sub=>{
    const f=await fixture();
    await f.graph.addNode('intent',{summary:'历史已结束工作'},0,'done','fixture',[]);
    await f.graph.addNode('intent',{summary:'人工暂停方向'},0,'paused','fixture',[]);
    assert.match((await plannerDispatchReminder(db,f.task,f.exp))!,/至少用 add_intent/);
    idleResponses();let engine=makeEngine(sub);const rounds=results(engine,f.task);
    await engine.run(f.task);await until(()=>rounds.length>=1&&settled(engine,f.task));
    assert.equal((await db.tasks().getTask(f.task))!.status,'running');
    assert.match(rounds[0]!.summary!,/提交意图 0 条/);assert.match(rounds[0]!.summary!,/未完成目标 1 个/);assert.match(rounds[0]!.summary!,/等待空闲重评/);
    const revision=await blackboardRevision(db,f.exp),before=resolutions;
    await until(()=>rounds.length>=2&&settled(engine,f.task));
    assert.equal(await blackboardRevision(db,f.exp),revision,'heartbeat itself does not mutate the blackboard');
    assert.equal(resolutions,before+1,'no new event is needed for another round');
    assert.equal((await db.query("SELECT count(*) FROM exploration_nodes WHERE exploration_id=$1 AND kind='intent'",[f.exp])).rows[0]!.count,'2');
    const idleCount=resolutions;
    for(let i=0;i<30;i++)engine.notify(f.task);
    await wait(250);assert.equal(resolutions,idleCount,'local hints cannot bypass the idle heartbeat');
    for(let i=0;i<30;i++)engine.notify(f.task,'重复控制通知');
    await until(async()=>{
      const inbox=(await db.query("SELECT count(*) FILTER(WHERE acknowledged_at IS NULL) pending,count(*) FILTER(WHERE kind='control_changed') controls FROM blackboard_wakeups WHERE exploration_id=$1",[f.exp])).rows[0]!;
      return Number(inbox.controls)===30&&Number(inbox.pending)===0&&settled(engine,f.task);
    });
    assert.ok(resolutions-idleCount<=3,'control arrivals coalesce into bounded batches');
    const after=resolutions;await wait(250);assert.equal(resolutions,after,'drained notifications cannot spin');
    await engine.shutdown();assert.equal((await db.tasks().getTask(f.task))!.status,'running');
    engine=makeEngine(sub);const restored=results(engine,f.task);engine.startScheduler();
    await until(()=>restored.length>=1&&settled(engine,f.task));
    assert.equal((await db.tasks().getTask(f.task))!.status,'running');
    await db.tasks().applyTaskPause(f.task);await engine.pause(f.task);
    const paused=resolutions;for(let i=0;i<10;i++)engine.notify(f.task);await wait(1300);
    assert.equal(resolutions,paused);assert.equal((await db.tasks().getTask(f.task))!.paused,true);
    await engine.shutdown();
  });

  await t.test('repeated native dispatch reuses one intent and receipts count only new submissions',async sub=>{
    const f=await fixture();
    const run=()=>runPlannerRound({db,taskID:f.task,expID:f.exp,goal:'核验合成结果',model,dataDir:dir,hooks:{},maxTurns:8,todos:new TodoStore(db),triggersText:'合成派单',onActivity:()=>{}});
    for(const expected of [1,0]){
      faux.setResponses([fauxAssistantMessage([fauxToolCall('add_intent',{intents:[{summary:'核验用户提供的合成文本'}]})]),fauxAssistantMessage('已核对回执')]);
      const result=await run();assert.match(result.lastAssistantText!,new RegExp(`提交意图 ${expected} 条`));
    }
    assert.equal((await db.query("SELECT count(*) FROM exploration_nodes WHERE exploration_id=$1 AND kind='intent'",[f.exp])).rows[0]!.count,'1');
    await db.tasks().applyTaskPause(f.task);
  });

  await t.test('manual mode, explicit stop and timeout suppress further execution',async sub=>{
    idleResponses();const engine=makeEngine(sub);
    const manual=await fixture();await db.query("UPDATE tasks SET execution_mode='manual' WHERE id=$1",[manual.task]);
    const paused=await fixture();await db.tasks().applyTaskPause(paused.task);
    const before=resolutions;await engine.run(manual.task);await engine.run(paused.task);await wait(1300);assert.equal(resolutions,before);
    const stopped=await fixture(),rounds=results(engine,stopped.task);await engine.run(stopped.task);await until(()=>rounds.length>=1&&settled(engine,stopped.task));
    await engine.stop(stopped.task);await db.tasks().finishManually(stopped.task);
    const stopCount=resolutions;engine.notify(stopped.task);await engine.run(stopped.task);await wait(1300);assert.equal(resolutions,stopCount);
    const timed=await fixture();await db.query("UPDATE tasks SET first_run_at=now()-interval '2 seconds',deadline_at=now()-interval '1 second',timeout_seconds=1 WHERE id=$1",[timed.task]);
    faux.setResponses([fauxAssistantMessage([fauxToolCall('add_intent',{intents:[{summary:'超时后不得执行'}]})]),fauxAssistantMessage('超时，仅核对现有证据；目标尚未达成。')]);
    await engine.run(timed.task);await until(async()=>(await db.tasks().getTask(timed.task))!.status==='timeout');
    assert.equal((await db.query("SELECT count(*) FROM exploration_nodes WHERE exploration_id=$1 AND kind='intent'",[timed.exp])).rows[0]!.count,'0');
    const timeoutCount=resolutions;engine.notify(timed.task);await engine.run(timed.task);await wait(1300);assert.equal(resolutions,timeoutCount);
    assert.equal(await plannerDispatchReminder(db,timed.task,timed.exp),undefined);
    await engine.shutdown();
  });

  await t.test('goalless task enters attention even with its bootstrap wakeup pending',async sub=>{
    const f=await fixture();await f.graph.deleteGoal(f.goal);const before=resolutions,engine=makeEngine(sub);
    await engine.run(f.task);await until(async()=>(await db.tasks().getTask(f.task))!.status==='needs_attention');
    assert.equal(resolutions,before);await engine.shutdown();
  });

  await t.test('native proof uses evidence and ends only after all current goals are met',async sub=>{
    const f=await fixture(),second=await f.graph.addGoal({text:'第二项结果'},'user');
    const fact=await f.graph.addNode('fact',{summary:'合成结果',evidence:'isolated confirmed observation'},0,'confirmed','fixture',[]);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('prove_goal',{goal_id:f.goal,evidence_node_id:fact})]),
      async()=>{assert.equal(await db.tasks().setTaskStatusGuarded(f.task,'done'),false);return fauxAssistantMessage([fauxToolCall('prove_goal',{goal_id:second,evidence_node_id:fact})]);},
      fauxAssistantMessage('两项目标已通过证据验收。'),
    ]);
    const engine=makeEngine(sub);await engine.run(f.task);await until(async()=>(await db.tasks().getTask(f.task))!.status==='done');
    assert.equal((await f.graph.executionCounts()).met,2);await engine.shutdown();
  });

  await t.test('SQL migration upgrades exact defaults once and retains previous prompt version',async sub=>{
    const agent=(await db.platform().getAgentByKey('planner'))!;
    const old=(await db.query("INSERT INTO agent_prompts(agent_id,version,template_text) SELECT $1,COALESCE(max(version),0)+1,$2 FROM agent_prompts WHERE agent_id=$1 RETURNING id",[agent.id,previous.planner])).rows[0]!;
    await db.query('UPDATE agents SET current_prompt_id=$2,wrapup_prompt=$3 WHERE id=$1',[agent.id,old.id,previous.wrapup]);
    await db.query('DELETE FROM settings WHERE key=$1',[PLANNER_CONTINUATION_MIGRATION]);
    const migrated=await migratePlannerContinuation(db);assert.equal(migrated.prompt_updated,true);assert.equal(migrated.wrapup_updated,true);
    assert.equal(await db.platform().currentPrompt(agent.id),PLANNER_PROMPT);
    assert.equal((await db.query('SELECT wrapup_prompt FROM agents WHERE id=$1',[agent.id])).rows[0]!.wrapup_prompt,PLANNER_WRAPUP);
    assert.equal((await db.query('SELECT template_text FROM agent_prompts WHERE id=$1',[old.id])).rows[0]!.template_text,previous.planner);
    assert.deepEqual(await migratePlannerContinuation(db),migrated);
  });

  await t.test('failure backoff survives repeated notifications then resumes idle planning',{timeout:75_000},async sub=>{
    idleResponses();const f=await fixture(),engine=makeEngine(sub),rounds=results(engine,f.task),before=resolutions;
    failNext=true;await engine.run(f.task);await until(()=>resolutions>before&&settled(engine,f.task));
    const failedAt=resolutionTimes.at(-1)!;
    for(let i=0;i<30;i++)engine.notify(f.task,'失败期间重复通知');
    await wait(1500);assert.equal(resolutions,before+1,'notification cannot bypass failure backoff');
    await until(()=>rounds.length>=2&&settled(engine,f.task),65_000);
    assert.ok(resolutionTimes[resolutionTimes.length-1]!-failedAt>=60_000,'same 60 second retry backoff');
    assert.equal((await db.tasks().getTask(f.task))!.status,'running');
    await engine.stop(f.task);await engine.shutdown();
  });
});
