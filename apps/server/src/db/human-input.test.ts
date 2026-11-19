import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import Fastify from 'fastify';
import {openDatabase} from './index.js';
import {waitForHumanInput,listHumanInputs,respondHumanInput,reconcileHumanInputs,pendingHumanInputSources,type HumanInputScope} from './human-input.js';
import {registerHumanInputRoutes} from '../http/routes/human-input.js';
import {requireJWT,signJWT} from '../http/auth.js';
import {recoverExpiredRuntimes,createTrackedRunner} from '../engine/runtime-config.js';
import {serveActivityStream,registerActivityStreamShutdown} from '../http/activity-stream.js';
import type {HumanPrompt,HumanReply} from '../pi/human-input.js';
import {askUserTool} from '../pi/human-input.js';
import {persistedWorkerAbortCause} from '../engine/worker-outcome.js';
import {Engine} from '../engine/engine.js';

const dsn=process.env.TEST_HUMAN_INPUT_DSN;
test('durable human input routing, ownership, deadlines and stream recovery',{skip:!dsn&&'isolated PostgreSQL required',timeout:180000},async t=>{
 assert.match(new URL(dsn!).pathname,/^\/test_human_input_[a-z0-9_]+$/);process.env.SERIES_PG_DSN=dsn;
 const db=await openDatabase(),app=Fastify({forceCloseConnections:true});app.decorate('db',db);
 const secret='local-human-input-fixture-secret',headers={authorization:`Bearer ${signJWT(secret)}`};
 app.addHook('preHandler',requireJWT(secret));registerHumanInputRoutes(app);registerActivityStreamShutdown(app);
 let streamExp=0;app.get('/fixture-stream',(req,reply)=>serveActivityStream(db,req,reply,'task',streamExp));
 const controllers:AbortController[]=[],runs:Promise<HumanReply>[]=[];
 t.after(async()=>{controllers.forEach(c=>c.abort());await Promise.allSettled(runs);app.server.closeAllConnections();await app.close();await db.close();});
 async function setup(role='worker'){
  const exp=await db.createExploration('本地人工问答测试','local fixture');
  const taskID=Number((await db.query("INSERT INTO tasks(exploration_id,description,goal,status,paused,queued) VALUES($1,'fixture','fixture','running',false,false) RETURNING id",[exp])).rows[0]!.id);
  const intentID=role==='worker'?Number((await db.query("INSERT INTO exploration_nodes(exploration_id,kind,state,owner) VALUES($1,'intent','running','work#fixture') RETURNING id",[exp])).rows[0]!.id):undefined;
  const runtimeID=randomUUID(),token=randomUUID(),turnID=randomUUID();
  await db.query("INSERT INTO runtime_role_configs(id,task_id,role,configured,effective,expires_at) VALUES($1,$2,$3,'{}',$4,now()+interval '5 minutes')",[runtimeID,taskID,role,JSON.stringify({usage_scope:{intentID,turnID,mainSegment:2}})]);
  if(role==='mainagent')await db.query("INSERT INTO runtime_session_leases(key,token,expires_at) VALUES($1,$2,now()+interval '5 minutes')",[`main:${taskID}:2`,token]);
  else await db.query("INSERT INTO engine_task_leases(task_id,owner,token,expires_at) VALUES($1,'fixture',$2,now()+interval '5 minutes')",[taskID,token]);
  const scope:HumanInputScope={taskID,runtimeID,role,turnID,intentID,mainSegment:2};
  return {...scope,exp,token};
 }
 async function start(scope:HumanInputScope,p:HumanPrompt={question:'需要协助',kind:'input'}){
  const controller=new AbortController();controllers.push(controller);
  const done=waitForHumanInput(db,scope,p,controller.signal);runs.push(done);void done.catch(()=>{});
  let id:string|undefined;
  for(let n=0;n<200;n++){id=(await db.query('SELECT id FROM human_input_requests WHERE runtime_id=$1 ORDER BY created_at DESC LIMIT 1',[scope.runtimeID])).rows[0]?.id as string|undefined;if(id)break;await delay(10);}
  assert.ok(id,'question must be durable before display');return {id,done,controller};
 }
 await t.test('three roles deliver text, select, false confirm, cancellation and editor independently',async()=>{
  for(const role of ['worker','planner','mainagent'])for(const [kind,answer] of [['input','001234'],['select','B'],['confirm',false],['editor','多行\n内容']] as const){
   const scope=await setup(role),q=await start(scope,{kind,question:'本地问题',options:kind==='select'?['A','B']:undefined,sensitive:kind==='input'});
   const result=await respondHumanInput(db,scope.taskID,q.id,{action:'answer',answer});
   assert.equal(result.answer,kind==='input'?undefined:answer);assert.equal((await q.done).answer,answer);
   assert.equal((await listHumanInputs(db,scope.taskID)).length,1);
  }
  for(const role of ['worker','planner','mainagent']){
   const scope=await setup(role),q=await start(scope,{kind:'confirm',question:'选择是否继续'});
   await respondHumanInput(db,scope.taskID,q.id,{action:'cancel'});assert.equal((await q.done).status,'cancelled');
  }
 });
 await t.test('authenticated answers validate task, type and choice; retries are idempotent',async()=>{
  const scope=await setup(),q=await start(scope,{kind:'select',question:'请选择',options:['A','B']});
  const url=`/api/tasks/${scope.taskID}/input-requests/${q.id}/respond`;
  assert.equal((await app.inject({method:'POST',url,payload:{action:'answer',answer:'A'}})).statusCode,401);
  for(const answer of [null,{},'C'])assert.equal((await app.inject({method:'POST',url,headers,payload:{action:'answer',answer}})).statusCode,400);
  const other=await setup();assert.equal((await app.inject({method:'POST',url:url.replace(String(scope.taskID),String(other.taskID)),headers,payload:{action:'answer',answer:'A'}})).statusCode,404);
  const responses=await Promise.all(['A','A'].map(answer=>app.inject({method:'POST',url,headers,payload:{action:'answer',answer}})));
  assert.deepEqual(responses.map(r=>r.statusCode),[200,200]);assert.equal((await q.done).answer,'A');
  assert.equal((await app.inject({method:'POST',url,headers,payload:{action:'answer',answer:'B'}})).statusCode,409);
 });
 await t.test('reply deadlines use database time at the write, including the fractional second',async t=>{
  const scope=await setup(),q=await start(scope);
  const {rows}=await db.query(`UPDATE human_input_requests
   SET expires_at=date_trunc('second',clock_timestamp())+interval '10.950 seconds'
   WHERE id=$1 RETURNING expires_at`,[q.id]);
  const deadline=(rows[0]!.expires_at as Date).getTime();
  // Freeze the application's clock inside the final fraction which used to be discarded.
  const clock=t.mock.method(Date,'now',()=>deadline-1);
  const answer={action:'answer',answer:'有效回答'};
  assert.equal((await respondHumanInput(db,scope.taskID,q.id,answer)).status,'answered');
  assert.equal((await q.done).answer,answer.answer);
  await db.query("UPDATE human_input_requests SET expires_at=clock_timestamp() WHERE id=$1",[q.id]);
  assert.equal((await respondHumanInput(db,scope.taskID,q.id,answer)).status,'answered');

  const expiredScope=await setup(),expired=await start(expiredScope);
  clock.mock.mockImplementation(()=>deadline-86_400_000);
  await db.query("UPDATE human_input_requests SET expires_at=clock_timestamp() WHERE id=$1",[expired.id]);
  for(const body of [answer,{action:'cancel'}]){
   await assert.rejects(respondHumanInput(db,expiredScope.taskID,expired.id,body),{statusCode:409});
  }
  assert.equal((await expired.done).status,'expired');
 });
 await t.test('only one pending question per execution and other executors remain live',async()=>{
  const a=await setup(),b=await setup(),qa=await start(a),qb=await start(b);
  const markers=await pendingHumanInputSources(db,a.taskID);assert.equal(markers.length,1);assert.equal(Number(markers[0]!.intent_id),a.intentID);assert.equal(markers[0]!.question,undefined);assert.equal(markers[0]!.answer,undefined);
  await assert.rejects(waitForHumanInput(db,a,{kind:'input',question:'重复'},new AbortController().signal),/unique|duplicate/i);
  await respondHumanInput(db,b.taskID,qb.id,{action:'answer',answer:'B'});assert.equal((await qb.done).answer,'B');
  assert.equal((await listHumanInputs(db,a.taskID))[0]!.status,'pending');qa.controller.abort();await assert.rejects(qa.done);
 });
 await t.test('timeout, task deadline, pause, kill, lease loss and runtime recovery invalidate old replies',async()=>{
  for(const cause of ['expiry','deadline','pause','kill','lease','runtime','main-stop']){
   const scope=await setup(cause==='main-stop'?'mainagent':'worker'),q=await start(scope,{kind:'input',question:'旧问题',timeout_ms:cause==='expiry'?100:undefined});
   if(cause==='expiry')await delay(150);
   else if(cause==='deadline')await db.query("UPDATE tasks SET deadline_at=now()-interval '1 second' WHERE id=$1",[scope.taskID]);
   else if(cause==='pause')await db.query("INSERT INTO runtime_task_commands(task_id,command) VALUES($1,'pause')",[scope.taskID]);
   else if(cause==='kill')await db.query("UPDATE exploration_nodes SET state='stopped' WHERE id=$1",[scope.intentID]);
   else if(cause==='lease')await db.query('UPDATE engine_task_leases SET token=$2 WHERE task_id=$1',[scope.taskID,randomUUID()]);
   else if(cause==='main-stop')await db.query('UPDATE runtime_session_leases SET stop_requested=true WHERE key=$1',[`main:${scope.taskID}:2`]);
   else {await db.query("UPDATE runtime_role_configs SET expires_at=now()-interval '1 second' WHERE id=$1",[scope.runtimeID]);await recoverExpiredRuntimes(db);}
   await reconcileHumanInputs(db,scope.taskID);assert.equal((await q.done).status,cause==='expiry'?'expired':'interrupted');
   await assert.rejects(respondHumanInput(db,scope.taskID,q.id,{action:'answer',answer:'late'}),{statusCode:409});
   // Resuming/replacing ownership never resurrects the old question.
   await db.query("UPDATE tasks SET paused=false,status='running',deadline_at=NULL WHERE id=$1",[scope.taskID]);
   assert.notEqual((await listHumanInputs(db,scope.taskID))[0]!.status,'pending');
  }
 });
 await t.test('stopping after answer before consumption cannot hand it to the old execution',async()=>{
  const scope=await setup(),q=await start(scope);
  await respondHumanInput(db,scope.taskID,q.id,{action:'answer',answer:'already submitted'});
  await db.query("UPDATE exploration_nodes SET state='stopped' WHERE id=$1",[scope.intentID]);
  assert.equal((await q.done).status,'interrupted');
  assert.equal((await db.query('SELECT answer,delivered_at FROM human_input_requests WHERE id=$1',[q.id])).rows[0]!.answer,null);
 });
 await t.test('durable pause and deadline keep their stop cause before the engine observes them',async()=>{
  const scope=await setup(),q=await start(scope);
  assert.equal(await persistedWorkerAbortCause(db,scope.taskID),undefined);
  await db.query("INSERT INTO runtime_task_commands(task_id,command) VALUES($1,'pause')",[scope.taskID]);
  assert.equal((await q.done).status,'interrupted');
  assert.equal(await persistedWorkerAbortCause(db,scope.taskID),'pause');
  await db.query("UPDATE runtime_task_commands SET status='acknowledged' WHERE task_id=$1",[scope.taskID]);
  await db.query('UPDATE tasks SET paused=true WHERE id=$1',[scope.taskID]);
  assert.equal(await persistedWorkerAbortCause(db,scope.taskID),'pause');
  // Exercise the real finalizer with no in-memory abort cause and no model calls.
  const rt={taskID:scope.taskID,expID:scope.exp,lease:scope.token,work:new Map(),activityTail:Promise.resolve()};
  const engine=Object.assign(Object.create(Engine.prototype),{db,bus:new EventEmitter(),
   beginActivityTurn:()=>({turnID:scope.turnID,metadata:{turn_id:scope.turnID},onActivity:()=>{},finish:async()=>{}}),
   emitActivity:()=>{},modelFor:async()=>undefined,coordinator:{assert:async()=>{}}});
  await engine.runOneIntent(rt,{id:scope.intentID},'work#fixture');
  const intent=await db.exploration(scope.exp).getNode(scope.intentID!);
  assert.equal(intent!.state,'open');assert.equal(intent!.payload.resume_requested,true);
  assert.equal((intent!.payload.execution_stop as {reason:string}).reason,'task_paused');
  await db.query("UPDATE tasks SET paused=false,deadline_at=now()-interval '1 second' WHERE id=$1",[scope.taskID]);
  assert.equal(await persistedWorkerAbortCause(db,scope.taskID),'task-timeout');
  await db.query("UPDATE tasks SET status='failed' WHERE id=$1",[scope.taskID]);
  assert.equal(await persistedWorkerAbortCause(db,scope.taskID),'task-ended');
 });
 await t.test('tracked PI sessions register a live UI for every role, including native session_start prompts',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'human-tracked-'));
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth'),modelsPath:join(dir,'models'),refreshOnCreate:false});
  const faux=fauxProvider({provider:'human-tracked-fixture'});await runtime.registerNativeProvider(faux.provider);
  try{
   for(const role of ['worker','planner','mainagent']){
    const scope=await setup(role);let originalAnswer:string|undefined;
    const prefill='核对第一行\n修改第二行';
    const expected=role==='mainagent'?'':'native-init';
    const creating=createTrackedRunner(db,scope.taskID,role,{cwd:dir,agentDir:dir,inMemory:true,modelRuntime:runtime,model:faux.getModel(),
     systemPrompt:'Local test',toolAllowlist:['ask_user'],customTools:[askUserTool()],intentID:scope.intentID,turnID:scope.turnID,mainSegment:scope.mainSegment,
     extensionFactories:[pi=>{pi.on('session_start',async(_e,ctx)=>{
      originalAnswer=role==='mainagent'?await ctx.ui.editor('核对正文',prefill):await ctx.ui.input('初始化需要的信息');
     });}]});
    let q:Awaited<ReturnType<typeof listHumanInputs>>[number]|undefined;
    for(let n=0;n<200;n++){q=(await listHumanInputs(db,scope.taskID)).find(r=>r.status==='pending');if(q)break;await delay(20);}
    assert.ok(q);
    if(role==='mainagent'){
     assert.equal(q.prefill,prefill);
     assert.equal(q.placeholder,undefined);
    }
    await respondHumanInput(db,scope.taskID,q.id,{action:'answer',answer:expected});
    const runner=await creating;
    try{
     assert.equal(originalAnswer,expected);assert.ok(runner.activeToolNames.includes('ask_user'));
     faux.setResponses([fauxAssistantMessage([fauxToolCall('ask_user',{kind:'input',question:'运行中的问题'})]),context=>{
      assert.match(JSON.stringify(context.messages),/scoped-answer/);return fauxAssistantMessage('结束');
     }]);
     const running=runner.prompt('测试');
     for(let n=0;n<200;n++){q=(await listHumanInputs(db,scope.taskID)).find(r=>r.status==='pending');if(q)break;await delay(20);}
     assert.ok(q);assert.equal(q.role,role);await respondHumanInput(db,scope.taskID,q.id,{action:'answer',answer:'scoped-answer'});await running;
    }finally{await runner.abort();await runner.dispose();}
    assert.equal((await listHumanInputs(db,scope.taskID)).filter(r=>r.status==='pending').length,0);
   }
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 await t.test('SSE and reload expose a pending request and its answer without secret values',async()=>{
  const scope=await setup('mainagent'),q=await start(scope,{kind:'input',question:'验证码',sensitive:true});
  streamExp=scope.exp;
  const address=await app.listen({host:'127.0.0.1',port:0});
  const cancel=new AbortController();
  try{
   const response=await fetch(`${address}/fixture-stream?task=${scope.taskID}`,{headers,signal:cancel.signal});assert.equal(response.status,200);
   const reader=response.body!.getReader(),decoder=new TextDecoder();let body='';
   while(!body.includes('event: human_inputs')){const part=await reader.read();assert.equal(part.done,false);body+=decoder.decode(part.value);}
   assert.match(body,new RegExp(q.id));assert.match(body,/pending/);
   const url=`/api/tasks/${scope.taskID}/input-requests`;
   assert.equal((await app.inject({url,headers})).json().items[0].status,'pending');
   await respondHumanInput(db,scope.taskID,q.id,{action:'answer',answer:'secret-value-001234'});await q.done;
   const restored=(await app.inject({url,headers})).json();assert.equal(restored.items[0].status,'answered');assert.equal(restored.items[0].answer,undefined);
   assert.doesNotMatch(JSON.stringify(restored),/secret-value/);
   assert.equal((await db.query('SELECT main_seg FROM activity WHERE metadata->>\'human_input_id\'=$1',[q.id])).rows[0]!.main_seg,2);
   const activities=await db.query('SELECT summary,detail,metadata FROM activity WHERE exploration_id=$1',[scope.exp]);assert.doesNotMatch(JSON.stringify(activities.rows),/secret-value/);
  }finally{cancel.abort();}
 });
});
