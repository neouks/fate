import assert from 'node:assert/strict';
import {test} from 'node:test';
import Fastify from 'fastify';
import {Engine} from './engine.js';
import {registerTaskRoutes} from '../http/routes/tasks.js';
import {requireJWT,signJWT} from '../http/auth.js';
import {correctionIdentity} from '../agent/worker-correction.js';
import {normalizeContract} from '../agent/intent-contract.js';

// No database, server listener or real Worker is started by these fixtures.
function fixture(disposition:'queued'|'handled'='queued') {
  const messages:string[]=[],activities:any[]=[];
  const runner={phase:'running' as 'running'|'closing'|'completed',steer:async(text:string)=>{messages.push(text);return disposition;}};
  const handle={turnID:'worker-turn',runner:Promise.resolve(runner),readyRunner:runner,
    done:new Promise<void>(()=>{}),settled:false,cause:undefined as string|undefined};
  const node={id:201,kind:'intent',state:'running',owner:'work#1',payload:{summary:'本地样本',contract:normalizeContract({acceptance:['检查 A','检查 B']},'本地样本')} as Record<string,any>};
  const saved=[{id:301,kind:'fact',state:'confirmed',payload:{summary:'已有事实'}},{id:302,kind:'finding',state:'confirmed',payload:{summary:'已有 finding'}}];
  const rt={expID:10,lease:'lease',work:new Map([[201,handle]]),paused:false,stopped:false};
  const task={id:1,exploration_id:10,status:'running',paused:false,queued:false};
  const db:any={tasks:()=>({getTask:async(id:number)=>id===1?task:null}),
    transaction:async(fn:any)=>fn(db),query:async(sql:string,values?:any[])=>{
      assert.doesNotMatch(sql,/\bDELETE\b|\bTRUNCATE\b/);
      if(sql.includes('SELECT id FROM exploration_nodes'))return {rows:saved.filter(n=>values![1].includes(n.id))};
      if(sql.includes('SELECT metadata#>'))return {rows:activities.filter(a=>a.metadata.steering?.correction?.kind==='stop_criteria').map(a=>({indices:a.metadata.steering.correction.criterion_indices}))};
      if(sql.includes("AND (metadata#>'{steering,correction}') - 'reason'=$3"))return {rows:activities.filter(a=>JSON.stringify(correctionIdentity(a.metadata.steering.correction))===values![2]).map(()=>({exists:1}))};
      if(sql.includes('SELECT DISTINCT n.id'))return {rows:saved.map(n=>({id:n.id,content_version:0}))};
      if(sql.includes("jsonb_build_object('execution_stop'"))node.payload.execution_stop=JSON.parse(values![1]);
      return {rows:[]};
    },
    exploration:(exp:number)=>({getNode:async(id:number)=>exp!==10?null:id===201?node:saved.find(n=>n.id===id)??null,
      setIntentState:async(_id:number,state:string)=>{node.state=state;},
      appendActivity:async(row:any)=>{activities.push(row);}})};
  const engine=Object.assign(Object.create(Engine.prototype),{tasks:new Map([[1,rt]]),steeringQueues:new Map(),db,coordinator:{assert:async()=>{}}}) as Engine;
  return {engine,db,task,node,rt,handle,runner,messages,activities,saved};
}

test('direct Worker message is unchanged, scoped and reports native disposition',async()=>{
  for(const status of ['queued','handled'] as const){
    const f=fixture(status),message='/skill:fixture 保留原文\n不要重新执行 A';
    const receipt=await f.engine.steerWork(1,201,message,'user');
    assert.deepEqual(f.messages,[message]);
    assert.equal(receipt.status,status);assert.equal(receipt.turn_id,'worker-turn');
    assert.equal(f.activities.length,1);
    assert.equal(f.activities[0].node_id,201);
    assert.equal(f.activities[0].metadata.steering.source,'user');
    assert.equal(f.activities[0].metadata.steering.status,status==='handled'?'handled':'submitted');
    assert.equal(f.activities[0].detail,message);
  }
});

test('stopped, foreign, missing and initializing Workers reject input without enqueueing',async()=>{
  const changes=[(f:ReturnType<typeof fixture>)=>{f.rt.paused=true;},
    (f:ReturnType<typeof fixture>)=>{f.handle.cause='pause';},
    (f:ReturnType<typeof fixture>)=>{f.handle.settled=true;},
    (f:ReturnType<typeof fixture>)=>{f.runner.phase='closing';},
    (f:ReturnType<typeof fixture>)=>{f.runner.phase='completed';},
    (f:ReturnType<typeof fixture>)=>{f.node.state='done';},
    (f:ReturnType<typeof fixture>)=>{f.rt.work.clear();},
    (f:ReturnType<typeof fixture>)=>{delete (f.handle as any).readyRunner;}];
  for(const change of changes){const f=fixture();change(f);
    await assert.rejects(f.engine.steerWork(1,201,'校正','user'),{statusCode:409});
    assert.deepEqual(f.messages,[]);assert.deepEqual(f.activities,[]);
  }
  const f=fixture();
  await assert.rejects(f.engine.steerWork(2,201,'校正','user'),{statusCode:409});
  await assert.rejects(f.engine.steerWork(1,202,'校正','user'),{statusCode:409});
  for(const message of ['  ','字'.repeat(4001)])await assert.rejects(f.engine.steerWork(1,201,message,'user'),{statusCode:400});
  assert.deepEqual(f.messages,[]);
});

test('automatic input rejects new instructions and invalid evidence before native enqueue',async()=>{
  const f=fixture();
  await assert.rejects(f.engine.steerWork(1,201,'换一个问题继续做','planner'),{statusCode:400});
  await assert.rejects(f.engine.steerWork(1,201,{kind:'reuse_evidence',criterion_indices:[0],fact_ids:[999]},'planner'),{statusCode:400});
  await assert.rejects(f.engine.steerWork(1,201,{kind:'stop_criteria',criterion_indices:[0,1]},'planner'),/kill_work/);
  assert.deepEqual(f.messages,[]);
  const original=JSON.stringify(f.node.payload.contract);
  await f.engine.steerWork(1,201,{kind:'reuse_evidence',criterion_indices:[0],fact_ids:[301,302]},'planner');
  assert.match(f.messages[0],/node:301, node:302/);
  assert.equal(f.activities[0].metadata.steering.scope_version,1);
  assert.equal(JSON.stringify(f.node.payload.contract),original);
  await assert.rejects(f.engine.steerWork(1,201,{kind:'reuse_evidence',criterion_indices:[0],fact_ids:[302,301]},'planner'),/不重复/);
  assert.equal(f.messages.length,1);
  f.runner.phase='closing';
  await assert.rejects(f.engine.steerWork(1,201,{kind:'stop_criteria',criterion_indices:[0]},'planner'),{statusCode:409});
  assert.equal(f.messages.length,1);
});

test('kill stops redundant work without model calls and retains persisted facts and findings',async()=>{
  for(const state of ['open','running']){
    const f=fixture();f.node.state=state;
    const saved=JSON.stringify(f.saved);let kills=0;
    const handle=Object.assign(f.handle,{done:Promise.resolve(),abort:async(cause:string)=>{assert.equal(cause,'kill');kills++;f.node.state='stopped';}});
    if(state==='open')f.rt.work.clear();else f.rt.work.set(201,handle);
    await f.engine.killWork(1,201,'已确认重复','planner');
    assert.equal(f.node.state,'stopped');assert.equal(kills,state==='running'?1:0);
    assert.deepEqual(f.messages,[]);assert.equal(JSON.stringify(f.saved),saved);
    if(state==='open')assert.deepEqual(f.node.payload.execution_stop.fact_refs.map((r:any)=>r.node_id),[301,302]);
  }
});

test('late kill waits for a completed Worker without changing its outcome',async()=>{
  for(const terminal of [false,true]){
    const f=fixture();f.node.state=terminal?'done':'running';
    f.runner.phase='completed';let kills=0,finish!:()=>void;
    Object.assign(f.handle,{done:new Promise<void>(r=>{finish=r;}),abort:async()=>{kills++;}});
    let settled=false;const stopping=f.engine.killWork(1,201,'迟到的终止').then(()=>{settled=true;});
    await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.equal(kills,0);
    f.node.state='done';finish();await stopping;
    assert.equal(f.node.state,'done');assert.equal(kills,0);
  }
});

test('pause or replacement during asynchronous lease check cannot steer the old Worker',async()=>{
  for(const replace of [false,true]){
    const f=fixture();
    (f.engine as any).coordinator.assert=async()=>{if(replace)f.rt.work.delete(201);else f.handle.cause='pause';};
    await assert.rejects(f.engine.steerWork(1,201,'校正','user'),{statusCode:409});
    assert.deepEqual(f.messages,[]);
  }
});

test('PI rejection is returned without a false submission receipt',async()=>{
  const f=fixture();f.runner.steer=async()=>{throw new Error('PI extension command cannot be queued');};
  await assert.rejects(f.engine.steerWork(1,201,'/extension','user'),/cannot be queued/);
  assert.deepEqual(f.activities,[]);
});

test('authenticated messages API validates task ownership and never resumes a task',async t=>{
  const f=fixture(),app=Fastify(),secret='worker-steering-isolated-fixture';
  app.decorate('db',f.db as any);app.decorate('engine',f.engine);
  app.addHook('preHandler',requireJWT(secret));registerTaskRoutes(app);
  t.after(()=>app.close());
  const headers={authorization:`Bearer ${signJWT(secret)}`};
  const url='/api/tasks/1/intents/201/messages';
  const send=(message:unknown,path=url)=>app.inject({method:'POST',url:path,headers,payload:{message}});
  assert.equal((await app.inject({method:'POST',url,payload:{message:'hello'}})).statusCode,401);
  for(const message of [null,0,{},'','字'.repeat(4001)])assert.equal((await send(message)).statusCode,400);
  assert.equal((await send('hello','/api/tasks/NaN/intents/201/messages')).statusCode,400);
  assert.equal((await send('hello','/api/tasks/2/intents/201/messages')).statusCode,404);
  assert.equal((await send('hello','/api/tasks/1/intents/999/messages')).statusCode,404);
  for(const status of ['paused','done']){f.task.status=status;assert.equal((await send('hello')).statusCode,409);}
  f.task.status='running';f.task.queued=true;assert.equal((await send('hello')).statusCode,409);f.task.queued=false;
  f.task.paused=true;assert.equal((await send('hello')).statusCode,409);f.task.paused=false;
  assert.deepEqual(f.messages,[]);
  const result=await send('直接校正');assert.equal(result.statusCode,202,result.body);
  assert.equal(result.json().status,'queued');assert.deepEqual(f.messages,['直接校正']);
});

const methodCorrection={kind:'adjust_method' as const,criterion_indices:[0],method:'以分号分列后检查 A，保持只读',reason:'逗号分列失败'};
test('method advice uses native steering, keeps contract, and deduplicates concurrent and restored calls',async()=>{
 for(const status of ['queued','handled'] as const){
  const f=fixture(status),original=JSON.stringify(f.node.payload.contract);
  const results=await Promise.allSettled([f.engine.steerWork(1,201,methodCorrection),f.engine.steerWork(1,201,{...methodCorrection,reason:'同一错误的另一个说明'})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.match((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.message,/不重复/);
  assert.equal(f.messages.length,1);assert.match(f.messages[0],/宿主方法纠偏/);
  assert.equal(JSON.stringify(f.node.payload.contract),original);
  assert.equal((f.engine as any).steeringQueues.size,0);
  // A fresh queue still consults durable receipts.
  (f.engine as any).steeringQueues=new Map();
  await assert.rejects(f.engine.steerWork(1,201,{...methodCorrection,method:'  '+methodCorrection.method+'  '}),/不重复/);
  await f.engine.steerWork(1,201,{...methodCorrection,method:'换成逐行读取后以分号分列检查 A'});
  assert.equal(f.messages.length,2);
 }
});
test('method advice cannot reopen stopped criteria, closing or completed Workers, or bypass pause',async()=>{
 const f=fixture();
 await f.engine.steerWork(1,201,{kind:'stop_criteria',criterion_indices:[0]});
 await assert.rejects(f.engine.steerWork(1,201,methodCorrection),/不能.*重新开启/);
 for(const change of [(g:ReturnType<typeof fixture>)=>{g.runner.phase='closing';},
  (g:ReturnType<typeof fixture>)=>{g.runner.phase='completed';},(g:ReturnType<typeof fixture>)=>{g.rt.paused=true;},
  (g:ReturnType<typeof fixture>)=>{g.handle.cause='timeout';},(g:ReturnType<typeof fixture>)=>{g.rt.stopped=true;}]){
  const g=fixture();change(g);await assert.rejects(g.engine.steerWork(1,201,methodCorrection),{statusCode:409});assert.equal(g.messages.length,0);
 }
});
test('failed method delivery does not poison duplicate checking or keep the queue locked',async()=>{
 const f=fixture(),steer=f.runner.steer;f.runner.steer=async()=>{throw Error('enqueue failed');};
 await assert.rejects(f.engine.steerWork(1,201,methodCorrection),/enqueue failed/);
 assert.equal(f.activities.length,0);assert.equal((f.engine as any).steeringQueues.size,0);
 f.runner.steer=steer;await f.engine.steerWork(1,201,methodCorrection);assert.equal(f.messages.length,1);
});
