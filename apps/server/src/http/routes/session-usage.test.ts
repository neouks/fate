import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {usageSnapshot,registerConversationRoutes} from './conversations.js';

async function fixture(readable=true,quality='complete') {
  const calls:{sql:string;params:unknown[]}[]=[];
  const app=Fastify();
  app.decorate('engine',{} as never);
  app.decorate('db',{
    tasks:()=>({getTask:async(id:number)=>id===10?{id}:null}),
    query:async(sql:string,params:unknown[]=[])=>{
      calls.push({sql,params});
      if(sql.startsWith('SELECT 1 FROM conversations'))return {rowCount:readable?1:0,rows:[]};
      if(sql.includes('SELECT model,profile_id,usage,quality'))return {rows:[{model:'test-model',profile_id:2,quality,status:'completed',usage:{input:100,cacheRead:200,cacheWrite:10,output:50},created_at:'2026-11-21T00:00:00Z'}]};
      if(sql.startsWith('WITH ledger'))return {rows:[{model:'test-model',input_tokens:3100,uncached_input_tokens:1000,output_tokens:500,cache_read_tokens:2000,cache_write_tokens:100,input_complete:true,usage_complete:true}]};
      throw new Error(`unexpected query: ${sql.slice(0,70)}`);
    }
  } as never);
  registerConversationRoutes(app);
  await app.ready();
  return {app,calls};
}
test('session usage reads whole ledger and separates latest request context',async()=>{
  const {app,calls}=await fixture();
  try {
    const result=await app.inject('/api/conversations/7/usage');assert.equal(result.statusCode,200);
    const data=result.json();assert.equal(data.total.input_tokens,3100);assert.equal(data.context.tokens,360);
    assert.equal(data.context.profile_id,2);assert.equal(data.models[0].input_semantics,'inclusive_cache');
    assert.ok(calls.every(c=>c.params[0]===7));
  }finally{await app.close();}
});
test('unknown latest usage remains unknown, even when earlier totals exist',async()=>{
  const {app}=await fixture(true,'partial');
  try{assert.equal((await app.inject('/api/conversations/7/usage')).json().context.tokens,null);}finally{await app.close();}
});
test('unreadable and invalid conversations never expose retained ledger data',async()=>{
  const {app,calls}=await fixture(false);
  try{assert.equal((await app.inject('/api/conversations/7/usage')).statusCode,404);assert.equal(calls.length,1);assert.equal((await app.inject('/api/conversations/no/usage')).statusCode,404);assert.equal(calls.length,1);}finally{await app.close();}
});
test('task main segment is scoped and invalid/deleted tasks rejected',async()=>{
  const {app,calls}=await fixture();
  try{
    assert.equal((await app.inject('/api/tasks/10/session-usage?segment=3')).statusCode,200);
    assert.ok(calls.every(c=>c.params[0]===10&&c.params[1]===3));
    assert.ok(calls.filter(c=>c.sql.startsWith('WITH ledger')).every(c=>c.sql.includes('main_seg=$2')));
    assert.equal((await app.inject('/api/tasks/10/session-usage?segment=-1')).statusCode,400);
    assert.equal((await app.inject('/api/tasks/11/session-usage')).statusCode,404);
  }finally{await app.close();}
});

test('compaction and running requests never expose a stale conversation context',()=>{
 const last={model:'real',profile_id:3,quality:'complete',status:'completed',purpose:'compaction',usage:{input:1400,cacheRead:100,cacheWrite:0,output:225,_context_window:1000000}};
 assert.equal(usageSnapshot({},[],last).context.tokens,null);
 assert.equal(usageSnapshot({},[],last).context.state,'compacted');
 assert.equal(usageSnapshot({},[],{...last,purpose:'conversation',status:'running'}).context.state,'pending');
 assert.equal(usageSnapshot({},[],{...last,purpose:'conversation',status:'failed'}).context.tokens,null);
 assert.equal(usageSnapshot({},[],{...last,purpose:'conversation'}).context.tokens,1725);
 assert.equal(usageSnapshot({},[],last).context.capacity,1000000);
});
test('known inclusive input can calibrate context without inventing missing cache counts',()=>{
 const last={status:'completed',quality:'partial',input_semantics:'exclusive_cache',usage:{input:0,output:20,inputTotal:500,_input_total_known:true,_known_fields:['output'],_context_window:128000}};
 assert.equal(usageSnapshot({},[],last).context.tokens,520);
 assert.equal(usageSnapshot({},[],{...last,usage:{input:0,output:20}}).context.tokens,null);
 assert.equal(usageSnapshot({},[],{...last,quality:'complete',usage:{input:-1,output:20,cacheRead:0,cacheWrite:0}}).context.tokens,null);
 assert.equal(usageSnapshot({},[],{...last,quality:'complete',input_semantics:'unknown',usage:{input:500,output:20,cacheRead:100,cacheWrite:0}}).context.tokens,null);
});
