import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRuntime,type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {AgentRunner,type RunnerActivity,type AgentRunnerOptions} from '../pi/runner.js';
import {roleAllowsTool} from './planner-capabilities.js';
import {applyToolBindings} from './tool-bindings.js';
import {assertToolBinding} from './tool-registry.js';
import {toolLoadout,prepareToolLoading} from './tool-loading.js';
import {plannerTools,workerTools,runContext} from '../tools/index.js';
import {validatePlatformRunner} from '../pi/platform-policy.js';
import type {Database} from '../db/index.js';
const forbidden=['http_request','bash','write','edit','shell_open','shell_send','shell_read','shell_list','shell_close','mcp__*','mcp__fixture__request','custom_request'];
const planning=['read','context_get','context_search','asset_search','add_intent','steer_work','prove_goal','todo_write'];
const db={query:async()=>({rows:forbidden.concat(planning).map(key=>({key,agents:['planner','worker'],enabled:true}))})} as unknown as Database;

test('Planner ceiling overrides catalog bindings and direct/deferred/legacy/custom loading',async()=>{
 const candidates=[...forbidden,...planning];
 assert.deepEqual((await applyToolBindings(db,'planner',candidates.map(name=>({name})))).map(t=>t.name),planning);
 for(const name of forbidden){assert.equal(roleAllowsTool('planner',name),false);await assert.rejects(()=>assertToolBinding(db,'planner',name),/下发给 Worker/);}
 for(const direct of [true,false])for(const legacy of [true,false])assert.deepEqual(toolLoadout('planner',{toolAllowlist:candidates},{direct,legacy,referenced:candidates,custom:candidates}).toolAllowlist,planning);
 const ctx=runContext(db,1,1,'planner');
 assert.ok(!plannerTools(ctx).some(t=>t.name==='http_request'));
 assert.ok(workerTools({...ctx,role:'worker'}).some(t=>t.name==='http_request'));
 assert.throws(()=>validatePlatformRunner('planner',{cwd:'/tmp/fixture',systemPrompt:'fixture',toolAllowlist:['http_request']},1),/下发给 Worker/);
});
test('Planner safe tool disable remains effective; Worker bindings unchanged',async()=>{
 const disabled={query:async()=>({rows:[{key:'asset_get',enabled:false,agents:['planner']}]})} as unknown as Database;
 const loadout=await prepareToolLoading(disabled,'planner',{toolAllowlist:['http_request','asset_get','context_get'],systemPrompt:'http_request asset_get'},false);
 assert.deepEqual(loadout.toolAllowlist,['context_get']);
 assert.deepEqual((await applyToolBindings(db,'worker',forbidden.map(name=>({name})))).map(t=>t.name),forbidden);
});
for(const deferred of [true,false])test(`native Planner denies execution/search after old session restore (${deferred?'deferred':'direct'})`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fate-planner-capability-'));
 const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
 const faux=fauxProvider({provider:'planner-boundary-local'});runtime.registerNativeProvider(faux.provider);
 let executed=0,dispatched=0,reads=0,extensionExecuted=0;
 const tool=(name:string,execute:()=>void):ToolDefinition=>({name,label:name,description:name,parameters:{type:'object',properties:{}},execute:async()=>{execute();return {content:[{type:'text',text:'local saved'}],details:{}};}});
 const bad=tool('http_request',()=>executed++),add=tool('add_intent',()=>dispatched++),read=tool('asset_get',()=>reads++);
 const options:AgentRunnerOptions={cwd:dir,agentDir:dir,resumeSessionPath:join(dir,'session.jsonl'),modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Custom old prompt: do three HTTP probes.',toolAllowlist:['http_request','add_intent','asset_get'],customTools:[bad,add,read]};
 let runner:AgentRunner|undefined;
 try{
  faux.setResponses([fauxAssistantMessage([fauxToolCall('http_request',{})]),fauxAssistantMessage('old done')]);
  runner=await AgentRunner.create(options);await runner.prompt('old local fixture');await runner.dispose();runner=undefined;
  assert.equal(executed,1);executed=0;
  const activities:RunnerActivity[]=[];
  faux.setResponses([
   ctx=>{assert.match(JSON.stringify(ctx.messages.filter(m=>m.role==='system')),/禁止直接执行目标请求/);return fauxAssistantMessage([fauxToolCall('http_request',{})]);},
   ...(deferred?[fauxAssistantMessage([fauxToolCall('tool_search',{query:'http_request'})]),fauxAssistantMessage([fauxToolCall('tool_search',{query:'asset_get'})])]:[]),
   fauxAssistantMessage([fauxToolCall('asset_get',{})]),fauxAssistantMessage([fauxToolCall('bash',{command:'must not execute'})]),
   fauxAssistantMessage([fauxToolCall('custom_request',{})]),fauxAssistantMessage([fauxToolCall('add_intent',{})]),fauxAssistantMessage('delegated'),
  ]);
  runner=await AgentRunner.create({...options,toolAllowlist:[...options.toolAllowlist!,...forbidden],
   platform:{role:'planner',taskID:1,policy:{version:'domain-v1',compaction:'native',mcpLoading:'deferred'}},
   toolLoading:deferred?{version:'lean-tools-v1',initialActive:['add_intent'],deferred:['http_request','asset_get'],compatibility:[]}:undefined,
   extensionFactories:[pi=>{pi.registerTool(tool('custom_request',()=>extensionExecuted++));}],
   mcpEntries:[{name:'must-not-connect',config:{transport:'stdio',command:'/does/not/exist',exposure:'deferred'}}],onActivity:a=>{activities.push(a);}});
  for(const name of forbidden)assert.ok(!runner.activeToolNames.includes(name));
  await runner.prompt('new local fixture');
  assert.equal(executed,0);assert.equal(extensionExecuted,0);assert.equal(dispatched,1);assert.equal(reads,1);
  const failures=activities.filter((a):a is Extract<RunnerActivity,{kind:'tool_end'}>=>a.kind==='tool_end'&&a.isError);
  for(const name of ['http_request','bash','custom_request'])assert.ok(failures.some(a=>a.toolName===name&&a.text?.includes('下发给 Worker')),JSON.stringify(failures));
  if(deferred)assert.ok(failures.some(a=>a.toolName==='tool_search'&&a.text?.includes('Planner 不提供 http_request')));
  assert.ok(!activities.some(a=>a.kind==='tool_end'&&a.text?.includes('尚未在当前声明中激活')));
 }finally{await runner?.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
