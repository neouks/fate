import assert from 'node:assert/strict';
import {test} from 'node:test';
import Fastify from 'fastify';
import {Engine} from './engine.js';
import {registerTaskRoutes} from '../http/routes/tasks.js';
import {requireJWT,signJWT} from '../http/auth.js';

// No database, server listener or real Worker is started by these fixtures.
function fixture(disposition:'queued'|'handled'='queued') {
  const messages:string[]=[],activities:any[]=[];
  const runner={steer:async(text:string)=>{messages.push(text);return disposition;}};
  const handle={turnID:'worker-turn',runner:Promise.resolve(runner),readyRunner:runner,
    done:new Promise<void>(()=>{}),settled:false,cause:undefined as string|undefined};
  const node={kind:'intent',state:'running',owner:'work#1'};
  const rt={expID:10,lease:'lease',work:new Map([[201,handle]]),paused:false,stopped:false};
  const task={id:1,exploration_id:10,status:'running',paused:false,queued:false};
  const db={tasks:()=>({getTask:async(id:number)=>id===1?task:null}),
    exploration:(exp:number)=>({getNode:async(id:number)=>exp===10&&id===201?node:null,
      appendActivity:async(row:any)=>{activities.push(row);}})};
  const engine=Object.assign(Object.create(Engine.prototype),{tasks:new Map([[1,rt]]),db,coordinator:{assert:async()=>{}}}) as Engine;
  return {engine,db,task,node,rt,handle,runner,messages,activities};
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
