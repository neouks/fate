import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ModelRuntime,createFindToolDefinition,createAgentSession,SessionManager,DefaultResourceLoader,SettingsManager,type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {AgentRunner,type RunnerActivity} from '../pi/runner.js';
import {toolLoadout,prepareToolLoading} from './tool-loading.js';
import {nativeToolNames,nativeToolDefinitions,SDK_NATIVE_TOOLS} from './native-tools.js';
import {applyToolBindings} from './tool-bindings.js';
import {effectiveToolState} from './tool-catalog.js';
import {seedBuiltinTools} from '../db/platform.js';
import type {Database} from '../db/index.js';

const searches=['grep','find','ls'];
const core=(name:string):ToolDefinition=>({name,label:name,description:'Synthetic resident tool',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'ok'}],details:undefined})});

test('native directory, role ceilings, bindings and effective explanations agree',async()=>{
  assert(SDK_NATIVE_TOOLS.includes('powershell'));
  const rows=SDK_NATIVE_TOOLS.map(key=>({key,kind:'builtin',enabled:true,agents:['worker','mainagent','pentest','planner','goals','reporter','auto']}));
  rows.find(t=>t.key==='grep')!.enabled=false;
  rows.find(t=>t.key==='find')!.agents=['mainagent'];
  const db={query:async()=>({rows})} as unknown as Database;
  const tools=nativeToolDefinitions('/tmp/fixture');
  for(const role of ['worker','mainagent','pentest','planner','goals','reporter','auto']){
    const loaded=await prepareToolLoading(db,role,{toolAllowlist:SDK_NATIVE_TOOLS.slice(),customTools:tools},false);
    const expected=(await applyToolBindings(db,role,tools.filter(t=>nativeToolNames(role).includes(t.name)))).map(t=>t.name);
    assert.deepEqual([...loaded.toolAllowlist].sort(),expected.sort());
    assert(!loaded.toolAllowlist.includes('powershell'));
    for(const name of searches.filter(n=>loaded.toolAllowlist.includes(n)))assert(loaded.toolLoading.deferred.includes(name));
  }
  assert.deepEqual(nativeToolNames('pentest',false),nativeToolNames('worker'));
  const planner={role:'planner',scope:'task_bound',resident:['read','bash'],deferred:[],enabled:true,interactive_shell:true};
  assert.equal(effectiveToolState(rows.find(t=>t.key==='bash')!,planner).status,'resident');
  const worker={...planner,role:'worker',resident:['read'],deferred:['ls']};
  assert.deepEqual(effectiveToolState(rows.find(t=>t.key==='ls')!,worker),{configured_bound:true,status:'deferred'});
  assert.match(effectiveToolState(rows.find(t=>t.key==='grep')!,worker).reason!,/禁用/);
  assert.match(effectiveToolState(rows.find(t=>t.key==='find')!,worker).reason!,/未绑定/);
  assert.match(effectiveToolState(rows.find(t=>t.key==='ls')!,{...worker,enabled:false}).reason!,/角色已禁用/);
  assert.match(effectiveToolState(rows.find(t=>t.key==='powershell')!,worker).reason!,/尚未接入/);
});

test('native seeds add search defaults without overwriting operator choices',async()=>{
  const rows=new Map<string,{enabled:boolean;agents:string[]}>([['grep',{enabled:false,agents:['worker']}]]);
  const db={query:async(sql:string,args:unknown[])=>{
    assert.match(sql,/ON CONFLICT \(key\) DO NOTHING/);
    if(!rows.has(String(args[0])))rows.set(String(args[0]),{enabled:true,agents:JSON.parse(String(args[2]))});
    return {rows:[]};
  }} as unknown as Database;
  await seedBuiltinTools(db);await seedBuiltinTools(db);
  assert.deepEqual(rows.get('grep'),{enabled:false,agents:['worker']});
  for(const name of ['find','ls'])assert.deepEqual(rows.get(name),{enabled:true,agents:['worker','mainagent','pentest']});
  assert(!rows.has('powershell'));
});

for(const deferred of [false,true])test(`SDK tools outside the session grant are not registered (${deferred?'deferred':'direct'})`,async t=>{
  const dir=await mkdtemp(join(tmpdir(),'fate-native-grant-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
  const faux=fauxProvider({provider:'native-grant-fixture'});await runtime.registerNativeProvider(faux.provider);
  const runner=await AgentRunner.create({cwd:dir,agentDir:dir,inMemory:true,modelRuntime:runtime,model:faux.getModel(),toolAllowlist:['read'],
    // A conflicting custom definition must not resurrect an excluded native tool.
    customTools:[core('powershell')],...(deferred?{toolLoading:{version:'lean-tools-v1',initialActive:['read'],deferred:[],compatibility:[]}}:{})});
  t.after(()=>runner.dispose());
  assert.deepEqual(runner.session.getAllTools().map(t=>t.name),['read']);
  runner.session.setActiveToolsByName(['read','powershell','bash','grep']);
  assert.deepEqual(runner.activeToolNames,['read']);
});

test('restoring a native legacy session cannot resurrect PowerShell',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'fate-native-legacy-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
  const faux=fauxProvider({provider:'native-legacy-fixture'});await runtime.registerNativeProvider(faux.provider);
  const settings=SettingsManager.inMemory({cacheWarming:'off'});
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:settings,noExtensions:true,noSkills:true,noContextFiles:true,noPromptTemplates:true,noThemes:true});
  await loader.reload();
  const manager=SessionManager.create(dir,dir);
  const {session}=await createAgentSession({cwd:dir,agentDir:dir,modelRuntime:runtime,model:faux.getModel(),sessionManager:manager,resourceLoader:loader,settingsManager:settings,tools:['read','powershell']});
  await session.bindExtensions({});
  faux.setResponses([fauxAssistantMessage('Legacy session, no tools executed')]);
  try{await session.prompt('Save old native tool selection');assert(session.getActiveToolNames().includes('powershell'));}finally{await session.dispose();}
  const runner=await AgentRunner.create({cwd:dir,agentDir:dir,resumeSessionPath:manager.getSessionFile()!,modelRuntime:runtime,model:faux.getModel(),
    ...toolLoadout('worker',{toolAllowlist:['read']})});
  t.after(()=>runner.dispose());
  assert.deepEqual(runner.session.getAllTools().map(t=>t.name),['read']);
  assert.deepEqual(runner.activeToolNames,['read']);
});

for(const role of ['worker','mainagent','pentest'])test(`${role} discovers native search tools on demand, expires idle help and restores current grants`,async t=>{
  const dir=await mkdtemp(join(tmpdir(),'fate-native-search-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'fixture.txt'),'native-search-needle\n');
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
  const faux=fauxProvider({provider:'native-search-fixture'});await runtime.registerNativeProvider(faux.provider);
  // Keep the real pi find schema/execution, substituting its filesystem operation
  // so this regression never downloads fd or contacts external services.
  const find=createFindToolDefinition(dir,{operations:{exists:async()=>true,glob:async(pattern,path)=>{
    assert.equal(pattern,'*.txt');assert.equal(path,dir);return [join(dir,'fixture.txt')];
  }}}) as ToolDefinition;
  const tools=[find,core('context_get'),core('record_fact')];
  const options={cwd:dir,agentDir:dir,resumeSessionPath:join(dir,'session.jsonl'),modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Local synthetic fixture only.',platform:{role,taskID:1,policy:{version:'domain-v1' as const,compaction:'native' as const,mcpLoading:'direct' as const}},
    ...toolLoadout(role,{toolAllowlist:[...nativeToolNames(role),'context_get','record_fact'],customTools:tools})};
  const events:RunnerActivity[]=[];
  let revoked=false;
  let runner=await AgentRunner.create({...options,discoveryGuard:async name=>{if(revoked&&name==='ls')throw new Error('fixture revoked');},onActivity:a=>{events.push(a);}});
  t.after(()=>runner.dispose());
  for(const name of searches){assert(!runner.activeToolNames.includes(name));assert(runner.session.getAllTools().some(t=>t.name===name));}
  assert(!runner.session.getAllTools().some(t=>t.name==='powershell'));
  const receipt=(context:any)=>JSON.parse(context.messages.filter((m:any)=>m.role==='toolResult'&&m.toolName==='tool_search').at(-1).content[0].text);
  for(const name of searches){
    faux.setResponses([
      ()=>fauxAssistantMessage([fauxToolCall('tool_search',{query:name,mode:'exact'})]),
      ctx=>{assert.equal(receipt(ctx).status,'loaded');return fauxAssistantMessage([fauxToolCall(name,name==='ls'?{path:dir}:name==='find'?{pattern:'*.txt',path:dir}:{pattern:'native-search-needle',path:join(dir,'fixture.txt')})]);},
      ctx=>{const result=ctx.messages.filter((m:any)=>m.role==='toolResult'&&m.toolName===name).at(-1);assert(result&&!result.isError);assert.match(JSON.stringify(result.content),name==='grep'?/native-search-needle/:/fixture.txt/);return fauxAssistantMessage('done');},
    ]);
    await runner.prompt(`Use ${name} on the local fixture`);
  }
  // Revoke a loaded tool between requests. Neither its declaration nor an
  // attempted direct call may survive until a new search happens.
  revoked=true;
  faux.setResponses([()=>{assert(!runner.activeToolNames.includes('ls'));return fauxAssistantMessage([fauxToolCall('ls',{path:dir})]);},fauxAssistantMessage('done')]);
  await runner.prompt('Check live revocation');
  assert(events.some(a=>a.kind==='tool_end'&&a.toolName==='ls'&&a.isError));
  for(let i=0;i<3;i++){faux.setResponses([fauxAssistantMessage('idle')]);await runner.prompt('Idle fixture');}
  for(const name of searches)assert(!runner.activeToolNames.includes(name));
  for(const name of ['context_get','record_fact'])assert(runner.activeToolNames.includes(name));
  await runner.dispose();
  const next=toolLoadout(role,{toolAllowlist:options.toolAllowlist.filter(n=>n!=='ls'),customTools:tools});
  runner=await AgentRunner.create({...options,...next});
  assert(!runner.session.getAllTools().some(t=>t.name==='ls'||t.name==='powershell'));
  for(const name of ['context_get','record_fact'])assert(runner.activeToolNames.includes(name));
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('tool_search',{query:'不匹配的关键词',mode:'keyword'})]),
    ctx=>{const r=receipt(ctx);assert.equal(r.fallback,'catalog');assert(r.candidates.some((t:any)=>t.name==='grep'));assert(!r.candidates.some((t:any)=>['ls','powershell'].includes(t.name)));return fauxAssistantMessage([fauxToolCall('tool_search',{query:'ls',mode:'exact'})]);},
    ctx=>{assert.equal(receipt(ctx).status,'unauthorized');return fauxAssistantMessage([fauxToolCall('tool_search',{query:'grep',mode:'exact'})]);},
    ctx=>{assert.equal(receipt(ctx).status,'loaded');return fauxAssistantMessage('done');},
  ]);
  await runner.prompt('Recover and rediscover');
});
