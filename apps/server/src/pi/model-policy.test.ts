import assert from 'node:assert/strict';
import {test} from 'node:test';
import {resolveModelProfiles,makeModelResolver,reserveRequest} from './modelResolver.js';
import {buildModelSource} from './providerFromProfile.js';
const profile=(id:number,extra={})=>({id,name:`p${id}`,model:'deepseek-flash',format:'openai',baseURL:'http://127.0.0.1:1',apiKey:'synthetic',contextWindowK:128,maxTokens:0,priority:0,poolExclude:false,streaming:id===1,ratePerSecond:0,ratePerMinute:0,retry:{connect:{attempts:-1,interval_ms:0}},...extra});
function database(){
 const profiles=[profile(1),profile(2)];let cooled:number[]=[];
 const platform={getBool:async()=>true,activeProfile:async()=>profiles[0],listProfiles:async()=>profiles,profileByID:async(id:number)=>profiles.find(p=>p.id===id),getSetting:async()=>null};
 const db:any={tasks:()=>({getTask:async()=>({id:1})}),platform:()=>platform,query:async(sql:string,args:any[])=>{
  if(sql.startsWith('SELECT profile_id FROM llm_profile_health'))return {rows:cooled.filter(n=>args[0].includes(n)).map(profile_id=>({profile_id}))};
  if(sql.startsWith('SELECT llm_profile_id'))return {rows:[{id:null,enabled:true}]};
  if(sql.startsWith('SELECT fails'))return {rows:[{fails:0,trips:0}]};
  return {rows:[],rowCount:0};}};
 return {db,profiles,setCooled:(v:number[])=>{cooled=v;}};
}
test('cooldowns respected for primary, all candidates and explicit conversation',async()=>{
 const {db,setCooled}=database();
 assert.deepEqual((await resolveModelProfiles(db,1,'worker')).profiles.map(p=>p.id),[1,2]);
 setCooled([1]);assert.deepEqual((await resolveModelProfiles(db,1,'worker')).profiles.map(p=>p.id),[2]);
 assert.equal((await resolveModelProfiles(db,1,'worker',{profileID:1})).resolution.available,false);
 setCooled([1,2]);assert.equal((await resolveModelProfiles(db,1,'worker')).resolution.available,false);
});
test('fallback changes streaming and bad arguments are not retried',async()=>{
 const {db}=database();const source=await makeModelResolver(db,buildModelSource)(1,'worker');const policy=source.modelPolicy!;
 assert.equal(policy.isStreaming?.(),true);
 await policy.onResponse({provider:'series-p1',stopReason:'error',errorMessage:'400: Invalid arguments'});
 assert.equal(await policy.retry(),false);assert.equal(policy.isStreaming?.(),true);
 await policy.onResponse({provider:'series-p1',stopReason:'error',errorMessage:'503: overloaded'});
 assert.equal(await policy.retry(),true);assert.equal(policy.isStreaming?.(),false);
});
test('limiter uses stricter spacing and cancellation cannot reserve another slot',async()=>{
 const updates:number[]=[];let wait=0;const db:any={transaction:async(fn:any)=>fn({query:async(sql:string,args:any[])=>{
  if(sql.startsWith('UPDATE'))updates.push(args[1]);return {rows:[{wait}]};}})};
 await reserveRequest(db,profile(1,{ratePerSecond:4,ratePerMinute:30}) as never);assert.equal(updates[0],2000);
 wait=10000;await assert.rejects(reserveRequest(db,profile(1,{ratePerSecond:1}) as never,AbortSignal.abort()),{name:'AbortError'});assert.equal(updates.length,1);
});
test('session override failures do not exhaust the task fallback chain',async()=>{
 const {db}=database();const query=db.query,updates:string[]=[];
 db.query=async(sql:string,args:any[])=>{
  if(sql.startsWith('SELECT profile_id FROM task_session_profiles'))return {rows:[{profile_id:2}]};
  if(sql.startsWith('UPDATE task_llm_profiles'))updates.push(sql);
  return query(sql,args);
 };
 const source=await makeModelResolver(db,buildModelSource)(1,'worker',{sessionKey:'intent:99'});
 await source.modelPolicy!.onResponse({provider:'series-p2',stopReason:'error',errorMessage:'401: invalid API key'});
 assert.equal(await source.modelPolicy!.retry(),false);
 assert.deepEqual(updates,[]);
});
