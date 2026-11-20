import { roleExecutionGuard } from './roles.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRuntime,type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import { AgentRunner,type AgentRunnerOptions } from '../pi/runner.js';
import {applyToolBindings} from './tool-bindings.js';
import { assertToolBinding,ACTIVE_ROLES,TOOL_ALIASES } from './tool-registry.js';
import {toolLoadout,prepareToolLoading} from './tool-loading.js';
import { availableDomainTools,runContext } from '../tools/index.js';
import {validatePlatformRunner} from '../pi/platform-policy.js';
import type {Database} from '../db/index.js';

for(const role of [...ACTIVE_ROLES,'custom_assistant'])test(`${role}: user binding controls direct/deferred execution, revocation and restore`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fate-user-tool-policy-'));
 const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
 const faux=fauxProvider({provider:'user-tool-policy-local'});runtime.registerNativeProvider(faux.provider);
 let enabled=true,executed=0;
 const db={query:async(sql:string)=>({rows:sql.includes('FROM settings')?[]:[{key:'http_request',enabled,agents:[role]}]})} as unknown as Database;
 const http:ToolDefinition={name:'http_request',label:'http_request',description:'Synthetic counter; no network access',parameters:{type:'object',properties:{}},execute:async()=>{executed++;return{content:[{type:'text',text:'fixture result'}],details:{}};}};
 const options:AgentRunnerOptions={cwd:dir,agentDir:dir,resumeSessionPath:join(dir,'session.jsonl'),modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Use only configured tools.',
  platform:{role,taskID:1,policy:{version:'domain-v1',compaction:'native',mcpLoading:'deferred'}},discoveryGuard:name=>assertToolBinding(db,role,name)};
 let runner:AgentRunner|undefined;
 try{
  assert.doesNotThrow(()=>validatePlatformRunner(role,{cwd:dir,systemPrompt:'configured',toolAllowlist:['bash','http_request','mcp__*']},1));
  const candidates=availableDomainTools(runContext(db,1,1,role as never));
  assert(candidates.some(t=>t.name==='http_request'));
  assert(!candidates.some(t=>t.name in TOOL_ALIASES));
  for(const direct of [true,false]){
   const bound=await applyToolBindings(db,role,[http]);assert.equal(bound.length,1);
   const loadout=await prepareToolLoading(db,role,{customTools:bound,toolAllowlist:['http_request']},direct);
   runner=await AgentRunner.create({...options,...loadout});
   faux.setResponses([...(direct?[]:[fauxAssistantMessage([fauxToolCall('tool_search',{mode:'exact',query:'http_request'})])]),fauxAssistantMessage([fauxToolCall('http_request',{})]),fauxAssistantMessage('done')]);
   await runner.prompt('Use the configured fixture');assert.equal(executed,direct?1:2);
   enabled=false;
   faux.setResponses([fauxAssistantMessage([fauxToolCall('http_request',{})]),fauxAssistantMessage('disabled')]);
   await runner.prompt('Try after revocation');assert.equal(executed,direct?1:2);
   assert.equal((await applyToolBindings(db,role,[http])).length,0);
   await runner.dispose();runner=undefined;enabled=true;
  }
  enabled=false;
  runner=await AgentRunner.create({...options,...await prepareToolLoading(db,role,{customTools:[http],toolAllowlist:['http_request']},false)});
  assert(!runner.session.getAllTools().some(t=>t.name==='http_request'),'old session cannot restore a revoked tool');
 }finally{await runner?.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('retired tools cannot be resurrected by old prompts, compatibility or loading overrides',()=>{
 const names=['context_get','node_detail','complete_intent'];
 for(const legacy of [true,false])assert.deepEqual(toolLoadout('planner',{toolAllowlist:names},{legacy,referenced:names,overrides:{node_detail:'resident'}}).toolAllowlist,['context_get']);
});

test('configured execution still honors pause, stop, queue and timeout controls',async()=>{
 for(const role of [...ACTIVE_ROLES,'custom_assistant'])for(const task of [{status:'running',paused:true},{status:'running',queued:true},{status:'stopped'},{status:'timeout'},{status:'done'}]){
  const db={tasks:()=>({getTask:async()=>task})} as unknown as Database;
  const guard=roleExecutionGuard(runContext(db,1,1,role as never));
  for(const toolName of ['bash','http_request','shell_send'])assert((await guard({toolName,args:{},toolCallId:'fixture'}))?.block,role+' '+toolName);
 }
});
