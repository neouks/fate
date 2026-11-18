import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {setTimeout as wait} from 'node:timers/promises';
import {openDatabase} from '../db/index.js';
import {proposeGoalAcceptance} from '../db/goal-integrity.js';
import {runContext} from '../tools/context.js';
import {proveGoalTool} from '../tools/findings.js';
import {defaultEngineConfig,Engine} from './engine.js';

const dsn = process.env.TEST_TASK_GOALS_DSN;

test('managed tasks stay active until all current goals are proven', {
  skip: !dsn && 'set TEST_TASK_GOALS_DSN to an isolated PostgreSQL database',
}, async () => {
  assert.ok(dsn);
  assert.match(new URL(dsn).pathname, /^\/test_[a-z0-9_]+$/);
  const previous = process.env.SERIES_PG_DSN;
  process.env.SERIES_PG_DSN = dsn;
  const db = await openDatabase();
  const dir = await mkdtemp(join(tmpdir(),'fate-task-goals-'));
  let plannerResolutions = 0;
  const engine = new Engine(db,{...defaultEngineConfig(),debounceMs:5,heartbeatMs:50},async (_id,role)=>{
    if (role === 'planner') plannerResolutions++;
    throw new Error('此回归不发起模型请求');
  },dir);
  try {
    const create = async (goal: string) => {
      const row = (await db.query<{id:string;exploration_id:string}>(`
        WITH e AS (INSERT INTO explorations(goal) VALUES ($1) RETURNING id)
        INSERT INTO tasks(description,goal,exploration_id) SELECT 'fixture',$1,id FROM e
        RETURNING id,exploration_id`,[goal])).rows[0]!;
      return {id:Number(row.id), expID:Number(row.exploration_id), graph:db.exploration(Number(row.exploration_id))};
    };
    const task = await create('两项独立交付');
    const first = await task.graph.addGoal({text:'第一项交付'},'goals');
    const second = await task.graph.addGoal({text:'第二项交付'},'goals');
    await db.query(`INSERT INTO goals_bootstrap(task_id,goal,description,phase,goal_ids)
      VALUES($1,'两项独立交付','fixture','completed',$2)`,[task.id,[first,second]]);
    const firstFact = await task.graph.addNode('fact',{evidence:'第一项合成观察'},0,'confirmed','worker',[]);
    const secondFact = await task.graph.addNode('fact',{evidence:'第二项合成观察'},0,'confirmed','worker',[]);
    const tool = proveGoalTool(runContext(db,task.id,task.expID,'planner',{
      hooks:{notifyGoalMet:()=>engine.notify(task.id)},
    }));
    const prove = async (goalID:number, evidenceID:number) => {
      const result = await tool.execute('proof',{goal_id:goalID,evidence_node_id:evidenceID},undefined,undefined,{} as never);
      assert.notEqual(result.isError,true,(result.content[0] as {text:string}).text);
      return JSON.parse((result.content[0] as {text:string}).text);
    };
    const until = async (condition:()=>Promise<boolean>) => {
      for (let i=0;i<160;i++) {
        if (await condition()) return;
        await wait(50);
      }
      assert.fail('任务未在回归等待时间内进入预期状态');
    };
    const firstProposal=await prove(first,firstFact);
    assert.equal(firstProposal.verification,'evidence_verified');
    assert.equal(firstProposal.met,true);
    assert.equal(firstProposal.met_count,1);
    assert.equal((await task.graph.executionCounts()).met,1);
    assert.equal(await db.tasks().setTaskStatusGuarded(task.id,'done'),false);
    assert.equal(await engine.admitTask(task.id),true);
    await until(async()=>plannerResolutions>0);
    const active = await db.tasks().getTask(task.id);
    assert.equal(active?.status,'running');
    assert.equal(active?.completed_at,null);
    const secondProposal=await prove(second,secondFact);
    assert.equal(secondProposal.verification,'evidence_verified');
    assert.equal(secondProposal.all_goals_met,true);
    assert.equal(secondProposal.met_count,2);
    engine.notify(task.id);
    await until(async()=>(await db.tasks().getTask(task.id))?.status==='done');
    assert.ok((await db.tasks().getTask(task.id))?.completed_at);

    const changed = await create('可编辑及可撤回的目标');
    const edited = await changed.graph.addGoal({text:'旧目标'},'goals');
    const removed = await changed.graph.addGoal({text:'要删除的目标'},'goals');
    await db.query(`INSERT INTO goals_bootstrap(task_id,goal,description,phase,goal_ids)
      VALUES($1,'可编辑及可撤回的目标','fixture','completed',$2)`,[changed.id,[edited,removed]]);
    const evidence = await changed.graph.addNode('fact',{evidence:'旧目标观察'},0,'confirmed','worker',[]);
    await proposeGoalAcceptance(db,changed.id,edited,evidence,'合成证据');
    await changed.graph.deleteGoal(removed);
    assert.deepEqual(await changed.graph.executionCounts(),{running:0,goals:1,met:1,goalsReady:true});
    await changed.graph.updateGoalPayload(edited,'新目标','');
    assert.equal((await changed.graph.getNode(edited))?.state,'open');
    assert.equal((await db.query("SELECT 1 FROM exploration_edges WHERE dst_id=$1 AND rel='proves'",[edited])).rowCount,0);
    assert.equal(await db.tasks().finishManually(changed.id),'needs_attention');

    const empty = await create('存在原始目标，但当前无可验收节点');
    assert.equal(await db.tasks().setTaskStatusGuarded(empty.id,'done',true),false);
  } finally {
    await engine.shutdown();
    await db.close();
    await rm(dir,{recursive:true,force:true});
    if (previous === undefined) delete process.env.SERIES_PG_DSN;
    else process.env.SERIES_PG_DSN = previous;
  }
});
