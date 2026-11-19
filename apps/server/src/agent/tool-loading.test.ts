import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Database} from '../db/index.js';
import {workerTools,runContext} from '../tools/index.js';
import {toolLoadout,prepareToolLoading} from './tool-loading.js';
import {NATIVE_TOOLS} from './tool-registry.js';
import {WORKER_PROMPT} from './prompts.js';
import {AgentRunner} from '../pi/runner.js';
import {ModelRuntime,type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';

const tool=(name:string):ToolDefinition=>({name,label:name,description:'本地合成 '+name,parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'saved'}],details:{}})});

test('Worker declarations stay small even when prompt/Skill mentions writes and custom commands',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'fate-loadout-'));
 try{
  await mkdir(path.join(dir,'fixture'));await writeFile(path.join(dir,'fixture','SKILL.md'),'Use insert_assets, report_finding, record_fact, custom_probe and node_detail.');
  const names=[...NATIVE_TOOLS,'context_get','context_search','ask_user','insert_assets','record_fact','report_finding','http_request','web_search','custom_probe'];
  const db={platform:()=>({getBool:async()=>true,getSetting:async()=>null,getAgentByKey:async()=>({webSearch:true})}),query:async(sql:string)=>({rows:names.concat('node_detail').map(key=>({key,kind:key==='custom_probe'?'custom':'builtin',enabled:key!=='http_request',agents:['worker']})).filter(r=>!sql.includes("kind='builtin'")||r.kind==='builtin')})} as unknown as Database;
  const customTools=names.filter(n=>!NATIVE_TOOLS.includes(n)).map(tool);
  const loaded=await prepareToolLoading(db,'worker',{toolAllowlist:names,customTools,legacyTools:[tool('node_detail')],systemPrompt:WORKER_PROMPT,skillsDir:dir,allowedSkills:['fixture']},false);
  assert.deepEqual(loaded.toolLoading.initialActive,[...NATIVE_TOOLS,'context_get','context_search','ask_user','record_fact','node_detail']);
  assert.ok(!loaded.toolAllowlist.includes('http_request'));
  for(const name of ['insert_assets','report_finding','web_search','custom_probe']){
   assert.ok(loaded.toolLoading.deferred.includes(name));
   assert.equal(loaded.customTools.find(t=>t.name===name)?.exposure,'deferred');
  }
  for(const name of ['context_get','record_fact']){
   assert.ok(!loaded.toolLoading.deferred.includes(name));
   assert.notEqual(loaded.customTools.find(t=>t.name===name)?.exposure,'deferred');
  }
  assert.deepEqual(loaded.toolLoading.referencedActive,['node_detail']);
  const direct=await prepareToolLoading(db,'worker',{toolAllowlist:names,customTools},true);
  assert.deepEqual(direct.toolLoading.deferred,[]);assert.ok(!direct.toolAllowlist.includes('http_request'));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('Worker keeps read/writeback contracts resident while other large schemas remain deferred',()=>{
 const tools=workerTools(runContext({} as Database,1,1,'worker'));
 const loaded=toolLoadout('worker',{customTools:tools,toolAllowlist:[...NATIVE_TOOLS,...tools.map(t=>t.name)]},{referenced:tools.map(t=>t.name),custom:tools.map(t=>t.name)});
 for(const name of ['insert_assets','report_finding','http_request','web_search']){
  const original=tools.find(t=>t.name===name)!;
  assert.ok(original);assert.ok(!loaded.toolLoading.initialActive.includes(name));
  assert.deepEqual(loaded.customTools.find(t=>t.name===name)?.parameters,original.parameters);
 }
 for(const name of ['context_get','record_fact']){
  assert.ok(loaded.toolLoading.initialActive.includes(name));
  assert.deepEqual(loaded.customTools.find(t=>t.name===name)?.parameters,tools.find(t=>t.name===name)!.parameters);
 }
 const bytes=(ts:ToolDefinition[])=>Buffer.byteLength(JSON.stringify(ts.map(t=>({name:t.name,description:t.description,parameters:t.parameters}))));
 const initial=loaded.customTools.filter(t=>loaded.toolLoading.initialActive.includes(t.name));
 assert.ok(bytes(initial)<bytes(tools)*0.5,'resident read/writeback schemas should still leave more than half of domain declarations deferred');
});

for(const role of ['worker','mainagent','auto','pentest','reporter'])test(role+' residency does not restore disabled or unbound tools',async()=>{
 const names=['context_get','record_fact'];
 for(const denied of names)for(const mode of ['disabled','unbound']){
  const rows=names.map(key=>({key,kind:'builtin',enabled:key!==denied||mode!=='disabled',agents:key===denied&&mode==='unbound'?['goals']:[role]}));
  const db={query:async()=>({rows})} as unknown as Database;
  const loaded=await prepareToolLoading(db,role,{toolAllowlist:names,customTools:names.map(tool)},false);
  assert.ok(!loaded.toolAllowlist.includes(denied));
  assert.ok(!loaded.toolLoading.initialActive.includes(denied));
  assert.ok(!loaded.customTools.some(t=>t.name===denied));
  assert.ok(loaded.toolLoading.initialActive.includes(names.find(name=>name!==denied)!));
 }
});

test('PI discovers deferred platform/custom tools, executes them and restores only loaded declarations',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'fate-loadout-native-'));
 const runtime=await ModelRuntime.create({authPath:path.join(dir,'auth.json'),modelsPath:path.join(dir,'models.json'),refreshOnCreate:false});
 const faux=fauxProvider({provider:'loadout-local'});await runtime.registerNativeProvider(faux.provider);
 let calls=0;const assets={...tool('insert_assets'),execute:async()=>{calls++;return {content:[{type:'text' as const,text:'saved'}],details:{}};}};
 const loadout=toolLoadout('worker',{customTools:[tool('record_fact'),assets,tool('custom_probe')],toolAllowlist:[...NATIVE_TOOLS,'record_fact','insert_assets','custom_probe']});
 const options={cwd:dir,agentDir:dir,resumeSessionPath:path.join(dir,'session.jsonl'),modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Local fixture.',...loadout};
 let runner:AgentRunner|undefined;
 try{
  runner=await AgentRunner.create(options);
  for(const name of NATIVE_TOOLS)assert.ok(runner.activeToolNames.includes(name));
  assert.ok(runner.activeToolNames.includes('record_fact'));
  assert.ok(!runner.activeToolNames.includes('insert_assets'));
  faux.setResponses([fauxAssistantMessage([fauxToolCall('tool_search',{query:'insert_assets',limit:1})]),fauxAssistantMessage([fauxToolCall('insert_assets',{})]),fauxAssistantMessage('done')]);
  await runner.prompt('Save the local fixture');assert.equal(calls,1);
  assert.ok(runner.activeToolNames.includes('record_fact'));assert.ok(runner.activeToolNames.includes('insert_assets'));
  await runner.dispose();runner=await AgentRunner.create(options);
  assert.ok(runner.activeToolNames.includes('record_fact'));assert.ok(!runner.activeToolNames.includes('custom_probe'));
  faux.setResponses([fauxAssistantMessage([fauxToolCall('tool_search',{query:'custom_probe',limit:1})]),fauxAssistantMessage([fauxToolCall('custom_probe',{})]),fauxAssistantMessage('done')]);
  await runner.prompt('Use the local custom fixture');assert.ok(runner.activeToolNames.includes('custom_probe'));
 }finally{await runner?.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
