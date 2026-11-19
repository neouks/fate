import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRuntime,type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall,validateToolArguments} from '@earendil-works/pi-ai';
import {discoverTools,type DiscoveryArgs,type DiscoverySnapshot,type DiscoveryTool} from './tool-discovery.js';
import {searchDefinition} from '../agent/tool-catalog.js';
import {toolLoadout} from '../agent/tool-loading.js';
import {AgentRunner,type RunnerActivity} from './runner.js';

const tool=(name:string,description='Synthetic local fixture'):DiscoveryTool=>({name,description,exposure:'deferred',parameters:{type:'object',properties:{required_value:{type:'string'}},required:['required_value']}});
const snapshot=(tools:DiscoveryTool[]):DiscoverySnapshot=>({tools,active:[],denied:new Set(),unavailable:new Set(),known:()=>false,unavailableServers:[]});

test('exact lookup distinguishes loaded, already loaded, unauthorized, missing and unavailable',async()=>{
  const s=snapshot([tool('alpha'),tool('alpha_suffix'),tool('hidden')]);s.tools[2]!.exposure='hidden';
  assert.deepEqual((await discoverTools({query:'alpha',mode:'exact'},s)).loaded,['alpha']);
  s.active=['alpha'];assert.equal((await discoverTools({query:'alpha',mode:'exact'},s)).status,'already_loaded');
  s.denied.add('alpha');assert.equal((await discoverTools({query:'alpha',mode:'exact'},s)).status,'unauthorized');
  assert.equal((await discoverTools({query:'hidden',mode:'exact'},s)).status,'unauthorized');
  assert.equal((await discoverTools({query:'alph',mode:'exact'},s)).status,'not_found','exact lookup must not substitute a similar tool');
  s.known=name=>name==='disabled_builtin';assert.equal((await discoverTools({query:'disabled_builtin'},s)).status,'unauthorized');
  s.unavailableServers=['offline'];assert.equal((await discoverTools({query:'mcp__offline__alpha',mode:'exact'},s)).status,'unavailable');
});

test('full names win over MCP suffixes; ambiguous shorthand cannot silently load the wrong tool',async()=>{
  const s=snapshot([tool('mcp__a__echo'),tool('mcp__b__echo')]);
  // Explicit exact mode never resolves a shorthand.
  assert.equal((await discoverTools({query:'echo',mode:'exact'},s)).status,'not_found');
  assert.deepEqual((await discoverTools({query:'mcp__a__echo'},s)).loaded,['mcp__a__echo']);
  const alias=snapshot([tool('mcp__a__fixture_echo'),tool('mcp__b__fixture_echo')]);
  const ambiguous=await discoverTools({query:'fixture_echo'},alias);assert.equal(ambiguous.status,'candidates');assert.deepEqual(ambiguous.loaded,[]);
  alias.tools.push(tool('fixture_echo'));assert.deepEqual((await discoverTools({query:'fixture_echo'},alias)).loaded,['fixture_echo']);
});

test('keyword fallback enumerates every authorized candidate without bulk loading schemas',async()=>{
  const tools=Array.from({length:25},(_,i)=>tool('fixture_'+String(i).padStart(2,'0'),'Local record '+i));
  const s=snapshot([...tools,tool('denied'),{...tool('hidden'),exposure:'hidden'},tool('offline')]);
  s.denied.add('denied');s.unavailable.add('offline');
  const seen:string[]=[];let args:DiscoveryArgs|undefined={query:'完全不同的同义表述',mode:'keyword'};
  while(args){
    const result=await discoverTools(args,s);
    assert.equal(result.status,'candidates');assert.equal(result.fallback,'catalog');assert.deepEqual(result.loaded,[]);
    assert.equal(result.total_candidates,25);assert(!JSON.stringify(result).includes('required_value'));
    assert(result.candidates!.length<=8);seen.push(...result.candidates!.map(t=>t.name));args=result.next;
  }
  assert.deepEqual(seen,tools.map(t=>t.name));assert.equal(new Set(seen).size,25);
});

test('top-one loading retains lower ranked candidates and stable pagination after activation',async()=>{
  const s=snapshot(Array.from({length:19},(_,i)=>tool('fixture_'+String(i).padStart(2,'0'),'compare local fixture')));
  const first=await discoverTools({query:'compare',mode:'keyword'},s);
  assert.equal(first.loaded.length,1);assert.equal(first.candidates!.length,8);assert.equal(first.total_candidates,19);
  s.active.push(...first.loaded);let args=first.next;const names=first.candidates!.map(t=>t.name);
  while(args){const page=await discoverTools(args,s);assert.notEqual(page.status,'catalog_changed');names.push(...page.candidates!.map(t=>t.name));s.active.push(...page.loaded);args=page.next;}
  assert.equal(names.length,19);assert.equal(new Set(names).size,19);
  assert.deepEqual((await discoverTools({query:'fixture_18',mode:'exact'},s)).loaded,['fixture_18']);
  s.denied.add('fixture_00');const stale=await discoverTools(first.next!,s);
  assert.equal(stale.status,'catalog_changed');assert.equal(stale.next!.offset,0);assert.deepEqual(stale.loaded,[]);
});

test('catalog mode does not activate tools and schema rejects invalid limits or offsets',async()=>{
  const s=snapshot([tool('fixture')]);assert.deepEqual((await discoverTools({query:'',mode:'catalog'},s)).loaded,[]);
  const definition=searchDefinition();
  for(const args of [{query:'x',limit:0},{query:'x',limit:21},{query:'x',offset:-1},{query:'x',mode:'invented'}])
    assert.throws(()=>validateToolArguments(definition,{type:'toolCall',id:'fixture',name:'tool_search',arguments:args}));
  for(const args of [{query:'x',limit:1.2},{query:'x',offset:1.2}]){
    assert.throws(()=>definition.prepareArguments!(args),/整数/);
    await assert.rejects(discoverTools(args,s),/整数/);
  }
});

test('native model receives structured states, exact schemas and revocation without executing a target',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'fate-discovery-contract-'));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
  const faux=fauxProvider({provider:'discovery-local'});runtime.registerNativeProvider(faux.provider);
  let enabled=true,calls=0;
  const definition:ToolDefinition={...tool('fixture_exact'),label:'Fixture',exposure:'deferred',execute:async()=>{calls++;return {content:[{type:'text',text:'synthetic result'}],details:{}};}};
  const loadout=toolLoadout('worker',{customTools:[definition],toolAllowlist:[definition.name]});
  const activities:RunnerActivity[]=[];
  const runner=await AgentRunner.create({cwd:dir,agentDir:dir,inMemory:true,modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Local fixture.',...loadout,
    discoveryGuard:async name=>{if(name===definition.name&&!enabled)throw new Error('revoked');},onActivity:event=>{activities.push(event);}});
  t.after(()=>runner.dispose());
  const result=(context:any)=>JSON.parse(context.messages.filter((m:any)=>m.role==='toolResult'&&m.toolName==='tool_search').at(-1).content[0].text);
  faux.setResponses([
    ()=>fauxAssistantMessage([fauxToolCall('tool_search',{query:'fixture_exact',mode:'exact'})]),
    context=>{
      assert.equal(result(context).status,'loaded');
      const declared=context.messages.filter((m:any)=>m.role==='system').flatMap((m:any)=>m.toolsAdded??[]);
      assert.deepEqual(declared.find((tool:any)=>tool.name==='fixture_exact').parameters,definition.parameters);
      return fauxAssistantMessage([fauxToolCall('tool_search',{query:'fixture_exact',mode:'exact'})]);
    },
    context=>{assert.equal(result(context).status,'already_loaded');return fauxAssistantMessage([fauxToolCall('fixture_exact',{required_value:'local'})]);},
    ()=>{enabled=false;return fauxAssistantMessage([fauxToolCall('tool_search',{query:'fixture_exact',mode:'exact'})]);},
    context=>{assert.equal(result(context).status,'unauthorized');return fauxAssistantMessage([fauxToolCall('tool_search',{query:'fixture_missing',mode:'exact'})]);},
    context=>{assert.equal(result(context).status,'not_found');return fauxAssistantMessage('done');},
  ]);
  await runner.prompt('Load and execute one synthetic fixture');assert.equal(calls,1);
  assert(!runner.activeToolNames.includes('fixture_exact'));
  const searches=activities.filter((a):a is Extract<RunnerActivity,{kind:'tool_end'}>=>a.kind==='tool_end'&&a.toolName==='tool_search');
  assert.deepEqual(searches.map(a=>a.isError===true),[false,false,true,true]);
});
