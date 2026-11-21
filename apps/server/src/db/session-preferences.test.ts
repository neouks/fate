import assert from 'node:assert/strict';
import {test} from 'node:test';
import {applySessionTools,preferencePatch,readSessionPreferences,saveSessionPreferences,sessionProfile,thinkingOptions,DEFAULT_SESSION_PREFERENCES} from './session-preferences.js';
import {buildModelSource} from '../pi/providerFromProfile.js';
import {profilePolicy} from '../pi/profile-policy.js';
import {ConversationService} from '../engine/conversations.js';

test('session configuration rejects unsupported values instead of silently using defaults',()=>{
 for(const v of [null,[],{}, {thinking_level:'ultra'},{tool_preset:'sudo'}])assert.throws(()=>preferencePatch(v));
 assert.deepEqual(preferencePatch({session:'plan',thinking_level:'off'}),{thinking_level:'off'});
});
test('explicit tool presets remove MCP, discovery, extensions and unselected tools',()=>{
 const options:any={toolAllowlist:['read','grep','find','ls','bash','edit','write','mcp__*','tool_search','add_intent'],customTools:[{name:'add_intent'},{name:'read'}],mcpEntries:[{}],extensionFactories:[()=>{}],allowedSkills:['test'],settlementTools:['add_intent']};
 assert.equal(applySessionTools(options,'configured'),options);
 assert.deepEqual(applySessionTools(options,'none').toolAllowlist,[]);
 assert.deepEqual(applySessionTools(options,'read-only').toolAllowlist,['read','grep','find','ls']);
 assert.deepEqual(applySessionTools({...options,toolAllowlist:['read']},'full').toolAllowlist,['read']);
 for(const p of ['none','read-only','default','full'] as const){const next=applySessionTools(options,p);assert.deepEqual(next.mcpEntries,[]);assert.deepEqual(next.extensionFactories,[]);assert.ok(!next.customTools?.some(t=>t.name==='add_intent'));}
});
test('session reasoning overrides are resolved by the real provider adapter and preserve global profile',async()=>{
 const profile={id:1,name:'fixture',model:'deepseek-flash',format:'openai',baseURL:'http://127.0.0.1:1',apiKey:'synthetic',contextWindowK:1000,maxTokens:2048,thinkingType:'enabled',reasoningEffort:'high'};
 for(const [selection,expected] of [['auto','high'],['off','off'],['minimal','low'],['low','low'],['medium','high'],['xhigh','xhigh']] as const){
  const override=sessionProfile(profile,{...DEFAULT_SESSION_PREFERENCES,thinking_level:selection});
  const source=await buildModelSource(override);assert.equal(source.thinkingLevel,expected);
 }
 assert.equal(profile.reasoningEffort,'high');assert.equal(profilePolicy(profile).level,'high');
 assert.equal(thinkingOptions(profile).find(o=>o.value==='minimal')?.label,'low');
 assert.equal(thinkingOptions(profile).find(o=>o.value==='xhigh')?.label,'max');
 const gpt={...profile,model:'gpt-5.5'};
 assert.equal(sessionProfile(gpt,{...DEFAULT_SESSION_PREFERENCES,thinking_level:'minimal'}).reasoningEffort,'low');
 assert.deepEqual(thinkingOptions({...profile,model:'gpt-4.1'}).map(o=>o.value),['auto','off']);
});
test('partial updates preserve the other setting and isolate conversations and task roles',async()=>{
 const rows=new Map<string,any>();
 const db:any={query:async(sql:string,p:any[])=>{
  const conversation=sql.includes('conversations'),key=conversation?`c:${p[0]}`:`t:${p[0]}:${p[1]}`;
  if(sql.startsWith('UPDATE')||sql.startsWith('INSERT')){
   const n=conversation?1:2,old=rows.get(key)??{...DEFAULT_SESSION_PREFERENCES};
   rows.set(key,{thinking_level:p[n]??old.thinking_level,tool_preset:p[n+1]??old.tool_preset});
  }
  return {rows:rows.has(key)?[rows.get(key)]:[]};
 }};
 const a={taskID:1,sessionKey:'main:0'},b={taskID:1,sessionKey:'plan'},c={conversationID:1};
 await saveSessionPreferences(db,a,{thinking_level:'low'});await saveSessionPreferences(db,a,{tool_preset:'none'});
 await saveSessionPreferences(db,c,{thinking_level:'off'});
 assert.deepEqual(await readSessionPreferences(db,a),{thinking_level:'low',tool_preset:'none'});
 assert.deepEqual(await readSessionPreferences(db,b),DEFAULT_SESSION_PREFERENCES);
 assert.deepEqual(await readSessionPreferences(db,c),{thinking_level:'off',tool_preset:'configured'});
});
test('sending during manual compaction fails before queuing messages or changing history',async()=>{
 const calls:string[]=[];
 const db:any={transaction:async(fn:any)=>fn(db),query:async(sql:string,params:unknown[])=>{
  calls.push(sql);
  if(sql.includes('runtime_session_leases')){assert.equal(params[0],'compact:conversation:99');return {rowCount:1,rows:[{key:params[0]}]};}
  if(sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:1};
  throw new Error('No write should occur');
 }};
 const service=new ConversationService(db,undefined as never,'/tmp/unused',undefined as never);
 await assert.rejects(service.enqueue(99,'must not be queued'),{statusCode:409});
 assert.ok(calls.every(sql=>sql.startsWith('SELECT')));
});
