import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {AgentRunner,type RunnerActivity} from '../pi/runner.js';
import {workerMandate,plannerDispatchReminder} from './worker-assignment.js';
import {normalizeContract} from './intent-contract.js';
import {CONTEXT_LAYOUT_VERSION} from './prompt-context.js';
import {openDatabase} from '../db/index.js';
import {TodoStore} from '../tools/context.js';
import {runWorkerIntent,runPlannerRound,configureAgentEnv} from './roles.js';

for(const legacy of [false,true])test(`mandate survives native compaction, retry and session restoration: legacy=${legacy}`,async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'autonomy-context-'));
 const runtime=await ModelRuntime.create({authPath:dir+'/auth.json',modelsPath:dir+'/models.json',refreshOnCreate:false});const faux=fauxProvider({provider:'mandate'});await runtime.registerNativeProvider(faux.provider);
 const contract=normalizeContract({objective:'比较目录字段',out_of_scope:['禁止财务模块'],acceptance:['遵守用户明确指定顺序'],allowed_tools:['read']},'目录');
 const taskContext=workerMandate(4,{summary:'目录',...(!legacy?{autonomy_policy:'direction-autonomy-v2'}:{})},contract,'[]');
 const options={cwd:dir,agentDir:dir,resumeSessionPath:dir+'/session.jsonl',modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Local fixture',toolAllowlist:[],contextLayout:CONTEXT_LAYOUT_VERSION,taskContext,platform:{role:'worker',taskID:1,policy:{version:'domain-v1' as const,compaction:'native' as const,mcpLoading:'direct' as const}},compactionSettings:{keepRecentTokens:128,reserveTokens:512}};
 let runner:AgentRunner|undefined;
 const inspect=(ctx:any)=>{const text=JSON.stringify(ctx.messages);assert.doesNotMatch(text,/direction-autonomy-v2|自主探索策略|方向级派单/);for(const part of ['禁止财务模块','遵守用户明确指定顺序','执行要求'])assert.ok(text.includes(part));return fauxAssistantMessage('context preserved');};
 try{
  runner=await AgentRunner.create(options);faux.setResponses([fauxAssistantMessage('record one '.repeat(1200)),fauxAssistantMessage('record two '.repeat(1200)),fauxAssistantMessage('compacted'),fauxAssistantMessage('prefix')]);await runner.prompt('one');await runner.prompt('two');const ids=runner.sessionEntries.filter(e=>e.type==='message').map(e=>e.id);
  await runner.compact();assert.equal(runner.compactionDiagnostics.completed,1);faux.setResponses([inspect]);await runner.prompt('check after compaction');await runner.dispose();
  let retries=0;runner=await AgentRunner.create({...options,modelPolicy:{onResponse:async()=>{},retry:async()=>++retries===1}});assert.deepEqual(runner.sessionEntries.filter(e=>e.type==='message').slice(0,ids.length).map(e=>e.id),ids);
  faux.setResponses([fauxAssistantMessage('',{stopReason:'error',errorMessage:'503 fixture'}),inspect]);await runner.prompt('check after restore and retry');assert.equal(retries,1);
 }finally{await runner?.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

const dsn=process.env.TEST_AUTONOMY_RUNTIME_DSN;
test('full Worker entry enforces authority and lifecycle for v2 intents',{skip:!dsn&&'isolated PostgreSQL required'},async t=>{
 assert.match(new URL(dsn!).pathname,/^\/test_/);process.env.SERIES_PG_DSN=dsn;
 const db=await openDatabase(),dir=await mkdtemp(path.join(tmpdir(),'autonomy-guards-'));await mkdir(dir+'/skills');configureAgentEnv({skillsDir:dir+'/skills'});
 const runtime=await ModelRuntime.create({authPath:dir+'/auth.json',modelsPath:dir+'/models.json',refreshOnCreate:false});const faux=fauxProvider({provider:'autonomy-guards'});await runtime.registerNativeProvider(faux.provider);
 let requests=0;const server=http.createServer((_req,res)=>{requests++;res.writeHead(200,{'Content-Type':'application/json'}).end('{"ok":true}');});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+(server.address() as {port:number}).port+'/fixture';
 t.after(async()=>{server.closeAllConnections();server.close();await db.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 await t.test('Planner uses one native reminder for missing receipt and may still stop with no work',async()=>{
  for(const create of [true,false]){
   const goal='本地目录只读验证',expID=await db.createExploration(goal,goal),taskID=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,status,paused) VALUES($1,$1,$2,'running',false) RETURNING id",[goal,expID])).rows[0]!.id);await db.exploration(expID).addGoal({text:goal},'user');let reminded=0;
   faux.setResponses([fauxAssistantMessage('已下发一个方向'),ctx=>{assert.match(JSON.stringify(ctx.messages),/宿主回执核对/);assert.ok(!JSON.stringify(ctx.messages).includes('已进入收尾阶段，停止新探索'));reminded++;return create?fauxAssistantMessage([fauxToolCall('add_intent',{intents:[{summary:'目录数据一致性验证'}]})]):fauxAssistantMessage('尚缺必需的授权资料，等待补充；未实际派单');},fauxAssistantMessage('已核对回执')]);
   await runPlannerRound({db,taskID,expID,goal,model:{modelRuntime:runtime,model:faux.getModel()},dataDir:dir,hooks:{},maxTurns:8,todos:new TodoStore(db),triggersText:'按范围派单',onActivity:()=>{}});
   assert.equal(reminded,1);assert.equal(Number((await db.query("SELECT count(*) FROM exploration_nodes WHERE exploration_id=$1 AND kind='intent'",[expID])).rows[0]!.count),create?1:0);
   if(create)assert.equal(await plannerDispatchReminder(db,taskID,expID),undefined);
   else {await db.query('UPDATE tasks SET paused=true WHERE id=$1',[taskID]);assert.equal(await plannerDispatchReminder(db,taskID,expID),undefined);await db.query("UPDATE tasks SET paused=false,execution_mode='manual' WHERE id=$1",[taskID]);assert.equal(await plannerDispatchReminder(db,taskID,expID),undefined);}
  }
  const goal='budget receipt fixture',expID=await db.createExploration(goal,goal),taskID=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,status,paused) VALUES($1,$1,$2,'running',false) RETURNING id",[goal,expID])).rows[0]!.id);await db.exploration(expID).addGoal({text:goal},'user');
  await db.query("UPDATE agents SET max_turns=1 WHERE key='planner'");let requests=0;
  try{faux.setResponses([()=>{requests++;return fauxAssistantMessage('当前预算内未派单');},()=>{requests++;return fauxAssistantMessage('must not run');}]);await runPlannerRound({db,taskID,expID,goal,model:{modelRuntime:runtime,model:faux.getModel()},dataDir:dir,hooks:{},maxTurns:8,todos:new TodoStore(db),triggersText:'按范围派单',onActivity:()=>{}});assert.equal(requests,1,'receipt reminder cannot extend configured request budget');}
  finally{await db.query("UPDATE agents SET max_turns=0 WHERE key='planner'");}
 });
 for(const change of ['allowed-tools','paused','cancelled','owner','basis','unbind','disabled','task-pause','foreign-asset'])await t.test(change,async()=>{
  await db.query("UPDATE tools SET enabled=true,agents='[\"worker\",\"planner\"]' WHERE key='http_request'");
  const expID=await db.createExploration('guard fixture','read fixture'),taskID=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,status,paused) VALUES('guard','guard',$1,'running',false) RETURNING id",[expID])).rows[0]!.id);
  const basis=await db.exploration(expID).addNode('fact',{summary:'origin fixture',evidence:'synthetic verified origin'},0,'confirmed','fixture',[]);
  const intentID=await db.exploration(expID).addNode('intent',{summary:'Read fixture',autonomy_policy:'direction-autonomy-v2',contract:{objective:'Read fixture',basis:[{node_id:basis,version:0}],...(change==='allowed-tools'?{allowed_tools:['read']}:{})}},0,'running','fixture',[]);
  await db.query("UPDATE exploration_nodes SET owner='work#guard' WHERE id=$1",[intentID]);
  const controller=new AbortController(),events:RunnerActivity[]=[],before=requests;
  const foreignExp=await db.createExploration('foreign','foreign'),foreignTask=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,status,paused) VALUES('foreign','foreign',$1,'created',false) RETURNING id",[foreignExp])).rows[0]!.id);
  const asset=await db.assets().upsertEndpoint({url:url+'?foreign='+foreignTask,method:'GET',taskID:foreignTask});
  faux.setResponses([async()=>{
   if(change==='paused')await db.query("UPDATE exploration_nodes SET state='paused' WHERE id=$1",[intentID]);
   if(change==='cancelled')await db.query("UPDATE exploration_nodes SET payload=payload||'{\"cancelled_by_user\":true}'::jsonb WHERE id=$1",[intentID]);
   if(change==='owner')await db.query("UPDATE exploration_nodes SET owner='work#other' WHERE id=$1",[intentID]);
   if(change==='basis')await db.query('UPDATE exploration_nodes SET content_version=content_version+1 WHERE id=$1',[basis]);
   if(change==='unbind')await db.query("UPDATE tools SET agents='[\"planner\"]' WHERE key='http_request'");
   if(change==='disabled')await db.query("UPDATE tools SET enabled=false WHERE key='http_request'");
   if(change==='task-pause'){await db.query('UPDATE tasks SET paused=true WHERE id=$1',[taskID]);controller.abort();}
   return fauxAssistantMessage([change==='foreign-asset'?fauxToolCall('record_fact',{summary:'foreign result',evidence:'fixture',asset_ids:[asset]}):fauxToolCall('http_request',{url,method:'GET'})]);
  },fauxAssistantMessage('blocked; no further execution')]);
  const result=await runWorkerIntent({db,taskID,expID,intent:(await db.exploration(expID).getNode(intentID))!,workerName:'work#guard',model:{modelRuntime:runtime,model:faux.getModel()},dataDir:dir,hooks:{},maxTurns:5,maxDurationMs:10000,signal:controller.signal,onActivity:a=>{events.push(a);}});
  assert.equal(requests,before,'no prohibited network request reaches fixture');
  if(change==='task-pause')assert.ok(result.aborted);else assert.ok(events.some(e=>e.kind==='tool_end'&&e.isError),JSON.stringify(events));
  if(change==='foreign-asset')assert.equal((await db.query("SELECT count(*) FROM exploration_nodes WHERE exploration_id=$1 AND kind='fact'",[expID])).rows[0]!.count,'1');
 });
});
