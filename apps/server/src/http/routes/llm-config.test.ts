import assert from 'node:assert/strict';
import {test} from 'node:test';
import Fastify from 'fastify';
import {registerConfigRoutes} from './config.js';
import {registerLLMManagementRoutes} from './llm-management.js';

test('model management HTTP: save/preview/validation/pool controls/retired fields',async()=>{
 const settings=new Map<string,string>();const profiles=new Map<number,any>();let seq=0;
 const platform={workers:async()=>3,getSetting:async(k:string)=>settings.get(k)??null,setSetting:async(k:string,v:string)=>settings.set(k,v),getBool:async(k:string,d:boolean)=>settings.has(k)?settings.get(k)==='true':d,
  listProfiles:async()=>[...profiles.values()],profileByID:async(id:number)=>profiles.get(id)??null,
  saveProfile:async(p:any)=>{const id=p.id||++seq;profiles.set(id,{...p,id});return id;}};
 const db:any={pool:{},platform:()=>platform,transaction:async(fn:any)=>fn(db),query:async()=>({rows:[],rowCount:0})};
 const app=Fastify();app.decorate('db',db);registerConfigRoutes(app);registerLLMManagementRoutes(app);
 try{
  const post=(url:string,payload:object)=>app.inject({method:'POST',url,payload});
  const input={name:'fixture',model:'deepseek-flash',format:'anthropic',base_url:'http://127.0.0.1',thinking_type:'enabled',reasoning_effort:'max',context_window_k:258,max_tokens:0,retry:{connect:{attempts:2,interval_ms:15000}}};
  let r=await post('/api/llm/profiles',input);assert.equal(r.statusCode,200,r.body);const id=r.json().id;
  assert.equal(r.json().effective.effort,'max');assert.equal(r.json().effective.outputLimit,null);
  r=await post('/api/llm/preview',{...input,rate_per_second:2,rate_per_minute:30});assert.equal(r.statusCode,200);assert.equal(r.json().minRequestIntervalMs,2000);assert.equal(r.json().contextWindow,258000);
  assert.equal((await post('/api/llm/profiles',{...input,context_window_k:-1})).statusCode,400);
  assert.equal((await post('/api/llm/profiles',{...input,retry:{connect:{attempts:21}}})).statusCode,400);
  assert.equal((await post('/api/llm/profiles',{...input,retry:{empty:{attempts:2}}})).statusCode,400);
  profiles.get(id).retry.empty={attempts:3,interval_ms:500};
  assert.equal((await post('/api/llm/profiles',{...input,priority:1.5})).statusCode,400);
  assert.equal((await post('/api/llm/profiles',{...input,id,retry:{empty:{interval_ms:500,attempts:3}}})).statusCode,200);
  r=await post('/api/llm/profiles',{...input,id});assert.equal(r.statusCode,200);assert.equal(profiles.get(id).retry.empty.attempts,3);
  for(const key of ['llm_pool_enabled','llm_pool_bind_fallback']){
   for(const flag of [true,false]){r=await post('/api/settings',{[key]:flag});assert.equal(r.statusCode,200,r.body);assert.equal(settings.get(key),String(flag));}
   assert.equal((await post('/api/settings',{[key]:'true'})).statusCode,400);
  }
  settings.set('llm_retry_policy',JSON.stringify({empty:{attempts:2,interval_ms:0}}));
  r=await post('/api/llm/retry-policy',{connect:{attempts:-1,interval_ms:60000},breaker:{attempts:5,interval_ms:180000}});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().empty.attempts,2);
  assert.equal((await post('/api/llm/retry-policy',{intent:{attempts:3}})).statusCode,400);
  assert.equal((await post('/api/llm/retry-policy',{connect:{attempts:1.5}})).statusCode,400);
  r=await app.inject('/api/llm/retry-policy');assert.deepEqual(r.json().active_layers,['connect','breaker']);
 }finally{await app.close();}
});
