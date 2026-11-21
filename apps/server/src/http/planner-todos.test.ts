import assert from 'node:assert/strict';
import {test} from 'node:test';
import Fastify from 'fastify';
import type {Database} from '../db/index.js';
import {TodoStore,runContext,type TodoItem} from '../tools/context.js';
import {todoWriteTool} from '../tools/intents.js';
import {streamChanges} from '../engine/stream-changes.js';
import {registerActivityStreamShutdown,serveActivityStream} from './activity-stream.js';

test('committed Planner todos stream as current task snapshots, including clearing and reconnect', {timeout:15000}, async t=>{
  const saved=new Map<number,TodoItem[]>([[11,[]],[22,[{content:'other task',status:'pending'}]]]);
  let failCommit=false;
  const db={
    async query(sql:string,args:unknown[]=[]){
      if(sql.startsWith('SELECT planner_todos'))return {rows:[{planner_todos:structuredClone(saved.get(Number(args[0])))}]};
      if(sql.startsWith('SELECT 1 FROM explorations'))return {rows:[{}],rowCount:1};
      if(sql.includes('FROM agent_stream_snapshots')||sql.includes('FROM runtime_role_configs')||sql.includes("SELECT metadata->>'turn_id'")||sql.startsWith('WITH page AS MATERIALIZED'))return {rows:[]};
      throw new Error(`Unexpected fixture query: ${sql}`);
    },
    async transaction(run:(tx:Database)=>Promise<void>){
      let update:{exp:number;todos:TodoItem[]}|undefined;
      const tx={query:async(sql:string,args:unknown[])=>{
        assert.match(sql,/^UPDATE explorations SET planner_todos/);
        update={exp:Number(args[0]),todos:JSON.parse(String(args[1]))};
        return {rows:[]};
      }} as unknown as Database;
      await run(tx);
      if(failCommit)throw new Error('commit failed');
      if(update)saved.set(update.exp,update.todos);
    },
  } as unknown as Database;
  const app=Fastify({forceCloseConnections:true});
  registerActivityStreamShutdown(app);
  app.get<{Params:{id:string}}>('/stream/:id',(req,reply)=>serveActivityStream(db,req,reply,'task',Number(req.params.id)));
  const origin=await app.listen({host:'127.0.0.1',port:0});
  const controllers:AbortController[]=[];
  t.after(async()=>{controllers.forEach(c=>c.abort());app.server.closeAllConnections();await app.close();});
  async function connect(exp:number){
    const controller=new AbortController();controllers.push(controller);
    // The latest snapshot must arrive even when there are no new activity rows.
    const response=await fetch(`${origin}/stream/${exp}?since=999`,{signal:controller.signal});
    const reader=response.body!.getReader(),decoder=new TextDecoder();let buffer='';
    return {
      close:()=>controller.abort(),
      async next(){
        for(;;){
          const end=buffer.indexOf('\n\n');
          if(end>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
            if(frame.startsWith('event: planner_todos\n'))return JSON.parse(frame.split('\ndata: ')[1]!).items as TodoItem[];
            continue;
          }
          const result=await reader.read();assert.equal(result.done,false,'stream closed before todo snapshot');buffer+=decoder.decode(result.value,{stream:true});
        }
      },
    };
  }
  const stream=await connect(11);
  assert.deepEqual(await stream.next(),[],'initial empty state is delivered');
  const cache=new TodoStore(),ctx=runContext(db,1,11,'planner',{todos:cache});
  const notifications:number[]=[];
  const changed=(scope:string,id:number)=>{if(scope==='task')notifications.push(id);};
  streamChanges.on('change',changed);t.after(()=>streamChanges.off('change',changed));
  async function write(todos:TodoItem[]){
    const result=await todoWriteTool(ctx).execute('todo',{todos});
    assert(!result.isError,JSON.stringify(result));
    assert.deepEqual(cache.get(11),todos);
    assert.deepEqual(await stream.next(),todos);
  }
  await write([{content:'check login',status:'pending'},{content:'check upload',status:'pending'}]);
  await write([{content:'check login',status:'in_progress'},{content:'check upload',status:'pending'}]);
  await write([{content:'check login',status:'completed'}]);
  failCommit=true;
  const before=notifications.length;
  const failure=await todoWriteTool(ctx).execute('failed',{todos:[]});
  assert(failure.isError);
  assert.equal(notifications.length,before,'failed writes do not publish');
  assert.deepEqual(cache.get(11),saved.get(11),'failed writes do not replace committed cache');
  const reconnect=await connect(11);
  assert.deepEqual(await reconnect.next(),saved.get(11),'reconnect recovers saved list, not attempted arguments');reconnect.close();
  const other=await connect(22);
  assert.deepEqual(await other.next(),saved.get(22),'task lists remain isolated');other.close();
  failCommit=false;
  await write([]);
  assert.deepEqual(notifications,[11,11,11,11]);
});
