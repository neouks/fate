import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ModelRuntime,type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import type {Database} from '../db/index.js';
import {AgentRunner} from '../pi/runner.js';
import {prepareToolLoading,toolLoadout} from './tool-loading.js';
import {parseToolLoadingOverrides,readToolLoadingOverrides,toolLoadingSettingKey} from './tool-loading-preferences.js';

const definition=(name:string):ToolDefinition=>({name,label:name,description:'Local '+name,parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'fixture receipt'}],details:{}})});
function fixture() {
  const settings=new Map<string,string>(),disabled=new Set<string>(),unbound=new Set<string>();
  const row=(key:string)=>({key,enabled:!disabled.has(key),agents:unbound.has(key)?[]:['worker','planner','mainagent']});
  const db={query:async(sql:string,args?:unknown[])=>({rows:sql.includes('FROM settings')?settings.has(String(args?.[0]))?[{value:settings.get(String(args?.[0]))}]:[]:
    sql.includes('WHERE key=$1')?[row(String(args?.[0]))]:['tool_search','context_get','asset_get'].map(row)})} as unknown as Database;
  return {db,settings,disabled,unbound};
}
test('configuration validates modes, prototype names and bounded maps',()=>{
  assert.deepEqual(parseToolLoadingOverrides({asset_get:'resident',context_get:'deferred'}),{asset_get:'resident',context_get:'deferred'});
  for(const value of [null,[],true,{asset_get:'unknown'},JSON.parse('{"__proto__":"resident"}'),Object.fromEntries(Array.from({length:257},(_,i)=>['tool_'+i,'resident']))])assert.throws(()=>parseToolLoadingOverrides(value));
});
test('per-role overrides preserve defaults and cannot grant disabled or unbound tools',async()=>{
  const f=fixture(),options={customTools:[definition('context_get'),definition('asset_get')],toolAllowlist:['context_get','asset_get']};
  const before=await prepareToolLoading(f.db,'worker',options,false);
  assert.deepEqual(before.toolLoading.initialActive,['context_get']);
  f.settings.set(toolLoadingSettingKey('worker'),JSON.stringify({context_get:'deferred',asset_get:'resident',bash:'resident'}));
  const after=await prepareToolLoading(f.db,'worker',options,false);
  assert.deepEqual(after.toolLoading.initialActive,['asset_get']);assert.deepEqual(after.toolLoading.deferred,['context_get']);
  assert(!after.toolAllowlist.includes('bash'));
  assert.deepEqual((await prepareToolLoading(f.db,'planner',options,false)).toolLoading.initialActive,['context_get']);
  for(const set of [f.disabled,f.unbound]){
    set.add('asset_get');assert(!(await prepareToolLoading(f.db,'worker',options,false)).toolAllowlist.includes('asset_get'));set.clear();
  }
  f.settings.set(toolLoadingSettingKey('worker'),'{}');assert.deepEqual(await readToolLoadingOverrides(f.db,'worker'),{});
  assert.deepEqual((await prepareToolLoading(f.db,'worker',options,false)).toolLoading.initialActive,['context_get']);
});
test('explicit overrides supersede direct defaults but unavailable search forces direct loading',async()=>{
  const f=fixture(),options={customTools:[definition('context_get'),{...definition('asset_get'),exposure:'deferred' as const}],toolAllowlist:['context_get','asset_get']};
  f.settings.set(toolLoadingSettingKey('worker'),JSON.stringify({context_get:'deferred',asset_get:'resident'}));
  const selected=await prepareToolLoading(f.db,'worker',options,true);
  assert.deepEqual(selected.toolLoading.deferred,['context_get']);assert.equal(selected.toolLoading.idleToolRequests,2);
  assert.equal(selected.customTools.find(t=>t.name==='asset_get')?.exposure,'direct');
  f.disabled.add('tool_search');assert.deepEqual((await prepareToolLoading(f.db,'worker',options,true)).toolLoading.deferred,[]);
  const fixed=toolLoadout('worker',{toolAllowlist:['tool_search','mcp__example__read','node_detail'],customTools:[]},{legacy:true,overrides:{tool_search:'deferred',node_detail:'deferred'}});
  assert.deepEqual(fixed.toolLoading.deferred,[]);
});
for(const role of ['planner','worker','mainagent'])test(`${role}: custom residency survives idle and changed defaults apply on restored runner`,async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fate-tool-preference-')),f=fixture();
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
  const faux=fauxProvider({provider:'preference-'+role});await runtime.registerNativeProvider(faux.provider);
  const options={customTools:[definition('context_get'),definition('asset_get')],toolAllowlist:['context_get','asset_get']};
  f.settings.set(toolLoadingSettingKey(role),JSON.stringify({context_get:'deferred',asset_get:'resident'}));
  let runner:AgentRunner|undefined;
  const base={cwd:dir,agentDir:dir,resumeSessionPath:join(dir,'session.jsonl'),modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Local fixture only.'};
  try{
    runner=await AgentRunner.create({...base,...await prepareToolLoading(f.db,role,options,false)});
    assert(runner.activeToolNames.includes('asset_get'));assert(!runner.activeToolNames.includes('context_get'));
    faux.setResponses([fauxAssistantMessage([fauxToolCall('tool_search',{query:'context_get',mode:'exact'})]),fauxAssistantMessage([fauxToolCall('context_get',{})]),fauxAssistantMessage('read')]);
    await runner.prompt('Read fixture');
    for(let i=0;i<3;i++){faux.setResponses([fauxAssistantMessage('idle')]);await runner.prompt('Idle');}
    assert(runner.activeToolNames.includes('asset_get'));assert(!runner.activeToolNames.includes('context_get'));
    f.settings.set(toolLoadingSettingKey(role),JSON.stringify({context_get:'resident',asset_get:'deferred'}));
    assert(runner.activeToolNames.includes('asset_get'),'saving does not mutate an active runner');
    await runner.dispose();runner=await AgentRunner.create({...base,...await prepareToolLoading(f.db,role,options,false)});
    faux.setResponses([context=>{assert(runner!.activeToolNames.includes('context_get'));assert(!runner!.activeToolNames.includes('asset_get'));return fauxAssistantMessage('restored');}]);
    await runner.prompt('Check new loadout');
  }finally{await runner?.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
