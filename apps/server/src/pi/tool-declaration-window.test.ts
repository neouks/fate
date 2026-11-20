import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime,type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {toolLoadout} from '../agent/tool-loading.js';
import {roleDefinitions} from '../agent/tool-catalog.js';
import type {Database} from '../db/index.js';
import {AgentRunner} from './runner.js';

const marker='SYNTHETIC_FULL_PARAMETER_HELP';
const definition=(name:string):ToolDefinition=>({name,label:name,description:'Local synthetic tool. '+'Long contract '.repeat(8)+marker+' '+name,
  parameters:{type:'object',properties:{value:{type:'string',description:'exact fixture value'}},required:['value'],additionalProperties:false},
  execute:async(_id,args)=>({content:[{type:'text',text:'original evidence: '+(args as {value:string}).value}],details:{}}),
});
const declarations=(context:any)=>context.messages.filter((m:any)=>m.role==='system').flatMap((m:any)=>m.toolsAdded??[]);

for(const role of ['planner','worker','mainagent'])for(const scenario of ['boundary','expired','invalid'])test(`${role}: declared boundary calls renew; expired tools reject immediately (${scenario})`,async t=>{
  const expired=scenario==='expired',invalid=scenario==='invalid';
  const dir=await mkdtemp(join(tmpdir(),'fate-boundary-use-'));
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
  const faux=fauxProvider({provider:'local-boundary-fixture'});await runtime.registerNativeProvider(faux.provider);
  const lookup='asset_get',tick='context_get',tools=[definition(lookup),definition(tick)];
  const loadout=toolLoadout(role,{customTools:tools,toolAllowlist:[lookup,tick]});
  const sessionFile=join(dir,'session.jsonl');
  const runner=await AgentRunner.create({cwd:dir,agentDir:dir,resumeSessionPath:sessionFile,
    modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Synthetic local test.',...loadout});
  t.after(async()=>{try{await runner.dispose();}finally{await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}});
  const call=(name:string,value:string)=>()=>fauxAssistantMessage([fauxToolCall(name,{value})]);
  const search=()=>fauxAssistantMessage([fauxToolCall('tool_search',{query:lookup,mode:'exact'})]);
  const responses=[search,call(lookup,'first use'),call(lookup,'second use'),call(tick,'idle one'),
    ...(expired?[call(tick,'idle two')]:[]),invalid?()=>fauxAssistantMessage([fauxToolCall(lookup,{})]):call(lookup,'boundary use'),
    ...(expired?[search]:[]),call(lookup,'following turn'),()=>fauxAssistantMessage('done')];
  faux.setResponses(responses.map((response,index)=>(context)=>{
    const declared=declarations(context).filter((tool:any)=>tool.name===lookup);
    assert.equal(declared.length,runner.activeToolNames.includes(lookup)?1:0,'declaration and executable registry must agree');
    if(expired&&index===5)assert.equal(declared.length,0,'two completed idle turns expire before the next request');
    return response();
  }));
  await runner.prompt('Run the local fixture sequence');
  const messages=(await readFile(sessionFile,'utf8')).trim().split('\n').map(line=>JSON.parse(line).message);
  const results=messages.filter(message=>message?.role==='toolResult');
  assert.equal(results.filter(m=>m.isError).length,expired||invalid?1:0);
  if(expired)assert.match(JSON.stringify(results.find(m=>m.isError)),/not found/);
  if(invalid)assert.match(JSON.stringify(results.find(m=>m.isError)),/Validation failed/);
  assert.equal(results.at(-1).toolName,lookup);assert.equal(results.at(-1).isError,false);
});

test('all task roles defer large schemas while direct loading retains the full contract',()=>{
  for(const role of ['worker','planner','mainagent','auto','pentest','reporter']){
    const tools=roleDefinitions({} as Database,role),options={customTools:tools,toolAllowlist:tools.map(t=>t.name)};
    const lazy=toolLoadout(role,options),direct=toolLoadout(role,options,{direct:true});
    for(const name of ['context_get','record_fact']){
      assert(!lazy.toolLoading.deferred.includes(name),role+' must not retire '+name);
      if(lazy.toolAllowlist.includes(name))assert(lazy.toolLoading.initialActive.includes(name),role+' must declare '+name);
    }
    if(role==='planner')assert(!lazy.toolAllowlist.includes('record_fact'),'residency must not expand Planner permissions');
    if(['planner','mainagent'].includes(role))assert(lazy.toolLoading.deferred.includes('add_intent'),role);
    assert.equal(lazy.toolLoading.idleToolRequests,2);
    assert.equal(direct.toolLoading.idleToolRequests,undefined);assert.deepEqual(direct.toolLoading.deferred,[]);
    for(const tool of lazy.customTools)assert.deepEqual(tool.parameters,direct.customTools.find(t=>t.name===tool.name)!.parameters);
    const size=(items:ToolDefinition[])=>Buffer.byteLength(JSON.stringify(items.map(t=>({name:t.name,description:t.description,parameters:t.parameters}))));
    const initial=lazy.customTools.filter(t=>lazy.toolLoading.initialActive.includes(t.name));
    assert(size(initial)<size(direct.customTools)*0.5,role+' initial domain schema reduction');
  }
});

for(const role of ['worker','mainagent'])test(role+' read and writeback remain callable through invalid arguments, idle turns and native resume',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'fate-worker-resident-'));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
  const faux=fauxProvider({provider:'worker-resident-local'});await runtime.registerNativeProvider(faux.provider);
  const tools=['context_get','record_fact','fixture_optional'].map(definition);
  const loadout=toolLoadout(role,{customTools:tools,toolAllowlist:['read','bash','write','edit',...tools.map(t=>t.name)]});
  const file=join(dir,'session.jsonl'),events:import('./runner.js').RunnerActivity[]=[];
  const options={cwd:dir,agentDir:dir,resumeSessionPath:file,modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Synthetic local test.',...loadout,onActivity:(event:import('./runner.js').RunnerActivity)=>{events.push(event);}};
  let runner=await AgentRunner.create(options);t.after(()=>runner.dispose());
  const resident=(context:any)=>{
    for(const name of ['context_get','record_fact']){
      assert(runner.activeToolNames.includes(name),name+' must not expire');
      assert(declarations(context).some((tool:any)=>tool.name===name),name+' must remain declared');
    }
    for(const name of ['read','bash','write','edit'])assert(runner.activeToolNames.includes(name));
  };
  faux.setResponses([
    context=>{resident(context);return fauxAssistantMessage([fauxToolCall('context_get',{value:'first evidence'}),fauxToolCall('tool_search',{query:'fixture_optional',limit:1})]);},
    context=>{resident(context);return fauxAssistantMessage([fauxToolCall('fixture_optional',{value:'optional evidence'})]);},
    context=>{resident(context);return fauxAssistantMessage([fauxToolCall('context_get',{})]);},
    context=>{
      resident(context);
      assert(context.messages.some((m:any)=>m.role==='toolResult'&&m.toolName==='context_get'&&m.isError),'native parameter validation must still reject invalid input');
      return fauxAssistantMessage('idle one');
    },
    context=>{resident(context);return fauxAssistantMessage('idle two');},
    context=>{
      resident(context);assert(!runner.activeToolNames.includes('fixture_optional'),'other idle platform tools still expire');
      assert(!declarations(context).some((tool:any)=>tool.name==='fixture_optional'));
      return fauxAssistantMessage([fauxToolCall('context_get',{value:'corrected evidence'})]);
    },
    context=>{resident(context);return fauxAssistantMessage([fauxToolCall('record_fact',{})]);},
    context=>{
      resident(context);
      assert(context.messages.some((m:any)=>m.role==='toolResult'&&m.toolName==='record_fact'&&m.isError));
      return fauxAssistantMessage('write correction pending');
    },
    context=>{resident(context);return fauxAssistantMessage('idle before correction');},
    context=>{resident(context);return fauxAssistantMessage([fauxToolCall('record_fact',{value:'saved original evidence'})]);},
    context=>{resident(context);return fauxAssistantMessage('done');},
  ]);
  await runner.prompt('Read then reject invalid arguments');
  await runner.prompt('An idle turn');
  await runner.dispose();runner=await AgentRunner.create(options);
  await runner.prompt('Correct the read and write the result');
  await runner.prompt('An idle turn before correcting the write');
  await runner.dispose();runner=await AgentRunner.create(options);
  await runner.prompt('Correct the write without rediscovering tools');
  const searches=events.filter(e=>e.kind==='tool_start'&&e.toolName==='tool_search');
  assert.equal(searches.length,1,'resident tools must not need discovery or reload');
  const failures=events.filter(e=>e.kind==='tool_end'&&e.isError);
  assert.equal(failures.length,2,'only the two intentionally invalid arguments may fail');
  for(const event of failures)if(event.kind==='tool_end')assert.match(event.text??'',/Validation failed/);
  for(const name of ['context_get','record_fact'])assert(events.some(e=>e.kind==='tool_end'&&e.toolName===name&&!e.isError));
  const audit=await readFile(file,'utf8');
  for(const value of ['first evidence','corrected evidence','saved original evidence'])assert(audit.includes('original evidence: '+value));
});

test('an old deferred Main Agent session resumes with resident real contracts and preserves keyword fallback',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'fate-resident-upgrade-'));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
  const faux=fauxProvider({provider:'resident-upgrade-local'});runtime.registerNativeProvider(faux.provider);
  const calls:string[]=[];
  const tools=[...roleDefinitions({} as Database,'mainagent').filter(tool=>['context_get','record_fact'].includes(tool.name)).map(tool=>({...tool,
    execute:async()=>{calls.push(tool.name);return {content:[{type:'text' as const,text:'synthetic evidence saved'}],details:{}};},
  })),definition('fixture_optional')];
  const loaded=toolLoadout('mainagent',{customTools:tools,toolAllowlist:tools.map(tool=>tool.name)});
  const old={...loaded,customTools:loaded.customTools.map(tool=>({...tool,exposure:'deferred' as const})),
    toolLoading:{...loaded.toolLoading,initialActive:[],deferred:tools.map(tool=>tool.name)}};
  const events:import('./runner.js').RunnerActivity[]=[];
  const options={cwd:dir,agentDir:dir,resumeSessionPath:join(dir,'session.jsonl'),modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Synthetic local test.',onActivity:(event:import('./runner.js').RunnerActivity)=>{events.push(event);}};
  let runner=await AgentRunner.create({...options,...old});t.after(()=>runner.dispose());
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('tool_search',{query:'context_get',mode:'exact'})]),
    fauxAssistantMessage([fauxToolCall('context_get',{items:[{ref:'node:101'}]})]),
    fauxAssistantMessage('read'),fauxAssistantMessage('idle one'),fauxAssistantMessage('idle two'),
  ]);
  await runner.prompt('Read a local fixture using the old policy');
  await runner.prompt('Idle');await runner.prompt('Idle again');
  assert(!runner.activeToolNames.includes('context_get'),'old policy has expired the read tool');
  await runner.dispose();runner=await AgentRunner.create({...options,...loaded});
  const boundary=events.length;
  const resident=(context:any)=>{
    for(const name of ['context_get','record_fact']){
      assert(runner.activeToolNames.includes(name));
      const declared=declarations(context).find((tool:any)=>tool.name===name);
      assert(declared,name+' restored without discovery');
      assert.deepEqual(declared.parameters,tools.find(tool=>tool.name===name)!.parameters,'full parameter contract retained');
    }
  };
  const receipt=(context:any)=>JSON.parse(context.messages.filter((m:any)=>m.role==='toolResult'&&m.toolName==='tool_search').at(-1).content[0].text);
  faux.setResponses([
    context=>{resident(context);return fauxAssistantMessage([fauxToolCall('context_get',{items:[{ref:'node:101'}]})]);},
    context=>{resident(context);return fauxAssistantMessage([fauxToolCall('tool_search',{query:'琥珀盒登记簿',mode:'keyword'})]);},
    context=>{
      resident(context);const result=receipt(context);
      assert.equal(result.fallback,'catalog');assert.equal(result.status,'candidates');
      assert(result.candidates.some((tool:any)=>tool.name==='fixture_optional'));
      assert(!runner.activeToolNames.includes('fixture_optional'),'fallback metadata must not load schemas');
      return fauxAssistantMessage([fauxToolCall('tool_search',{query:'fixture_optional',mode:'exact'})]);
    },
    context=>{
      resident(context);assert.deepEqual(receipt(context).loaded,['fixture_optional']);
      return fauxAssistantMessage([fauxToolCall('fixture_optional',{value:'optional evidence'})]);
    },
    context=>{resident(context);return fauxAssistantMessage([fauxToolCall('record_fact',{summary:'Local fixture fact',evidence:'synthetic evidence saved'})]);},
    context=>{resident(context);return fauxAssistantMessage('done');},
  ]);
  await runner.prompt('Resume, read directly, discover an optional tool and save');
  assert.deepEqual(calls,['context_get','context_get','record_fact']);
  const resumed=events.slice(boundary);
  assert.equal(resumed.filter(e=>e.kind==='tool_start'&&e.toolName==='tool_search').length,2,'only the optional tool needs search');
  assert(!resumed.some(e=>e.kind==='tool_end'&&e.isError));
});

test('native discovery loads one tool, keeps repeated use, retires idle help, and can reload it',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'fate-tool-window-'));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
  const faux=fauxProvider({provider:'tool-window-local'});runtime.registerNativeProvider(faux.provider);
  const tools=[definition('fixture_alpha'),definition('fixture_beta')];
  const loaded=toolLoadout('worker',{customTools:tools,toolAllowlist:tools.map(t=>t.name)});
  const sessionFile=join(dir,'session.jsonl');
  const options={cwd:dir,agentDir:dir,resumeSessionPath:sessionFile,modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Synthetic local test.',...loaded};
  let runner=await AgentRunner.create(options);
  t.after(()=>runner.dispose());
  const hasAlpha=(context:any)=>{
    const ds=declarations(context),alpha=ds.find((d:any)=>d.name==='fixture_alpha');
    assert(alpha);assert.deepEqual(alpha.parameters,tools[0]!.parameters);
    assert.equal(ds.filter((d:any)=>d.name==='fixture_alpha').length,1,'reloading does not duplicate old schemas');
    assert(!ds.some((d:any)=>d.name==='fixture_beta'));
    return ds;
  };
  faux.setResponses([
    context=>{assert(!JSON.stringify(context.messages).includes(marker));return fauxAssistantMessage([fauxToolCall('tool_search',{query:'fixture'})]);},
    context=>{
      const ds=declarations(context).filter((t:any)=>t.name.startsWith('fixture_'));assert.equal(ds.length,1);
      assert.equal(ds[0].name,'fixture_alpha');
      const search=context.messages.filter((m:any)=>m.role==='toolResult'&&m.toolName==='tool_search');
      assert(!JSON.stringify(search).includes(marker),'search receipt must not duplicate full help');
      const candidates=JSON.parse((search.at(-1) as any).content[0].text).candidates;
      assert.deepEqual(candidates.filter((tool:any)=>tool.name.startsWith('fixture_')).map((tool:any)=>tool.name).sort(),['fixture_alpha','fixture_beta'],'fixture candidate metadata survives context projection');
      return fauxAssistantMessage([fauxToolCall('fixture_alpha',{value:'one'})]);
    },
    context=>{hasAlpha(context);return fauxAssistantMessage([fauxToolCall('fixture_alpha',{value:'two'})]);},
    context=>{hasAlpha(context);return fauxAssistantMessage('idle one');},
    context=>{hasAlpha(context);return fauxAssistantMessage('idle two');},
    context=>{
      assert(!declarations(context).some((t:any)=>t.name==='fixture_alpha'));
      assert(!JSON.stringify(context.messages).includes(marker),'expired schemas must be absent even from historical declarations');
      assert(!JSON.stringify(context.messages).includes('LEGACY_DUPLICATED_HELP'));
      assert.match(JSON.stringify(context.messages),/fixture discovery diagnostic/);
      assert.match(JSON.stringify(context.messages),/original evidence: one/);
      assert.match(JSON.stringify(context.messages),/original evidence: two/);
      return fauxAssistantMessage([fauxToolCall('tool_search',{query:'fixture_alpha',limit:1})]);
    },
    context=>{hasAlpha(context);return fauxAssistantMessage([fauxToolCall('fixture_alpha',{value:'three'})]);},
    context=>{hasAlpha(context);return fauxAssistantMessage('done');},
  ]);
  await runner.prompt('Load and use the local fixture twice');
  await runner.dispose();
  // Simulate a pre-upgrade search receipt with duplicated help. Projection may
  // shorten only discovery metadata, retaining diagnostics and the audit source.
  const entries=(await readFile(sessionFile,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const receipt=entries.find(entry=>entry.type==='message'&&entry.message.role==='toolResult'&&entry.message.toolName==='tool_search');
  assert(receipt);receipt.message.content[0].text+=' LEGACY_DUPLICATED_HELP';
  delete receipt.message.details.discovery_version;
  receipt.message.content.push({type:'text',text:'fixture discovery diagnostic'});
  await writeFile(sessionFile,entries.map(entry=>JSON.stringify(entry)).join('\n')+'\n');
  runner=await AgentRunner.create(options);
  await runner.prompt('An idle turn');
  await runner.dispose();runner=await AgentRunner.create(options);
  await runner.prompt('Load the retired fixture again');
  const audit=await readFile(sessionFile,'utf8');
  assert(audit.includes(marker),'native historical declarations remain in the audit file');
  assert(audit.includes('LEGACY_DUPLICATED_HELP'));
  for(const value of ['one','two','three'])assert(audit.includes('original evidence: '+value));
});
