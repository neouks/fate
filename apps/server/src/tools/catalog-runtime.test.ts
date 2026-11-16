import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fauxProvider,fauxAssistantMessage,fauxToolCall,validateToolArguments} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {openDatabase} from '../db/index.js';
import {previewRoleTools,searchDefinition} from '../agent/tool-catalog.js';
import {toolLoadout} from '../agent/tool-loading.js';
import {applyToolBindings} from '../agent/tool-bindings.js';
import {configuredBash} from '../config/execution.js';
import {platformBashDescription} from './custom.js';
import {AgentRunner,type RunnerActivity} from '../pi/runner.js';
import {contextGetTool} from './context-read.js';
import {insertAssetsTool,assetGetTool} from './assets.js';
import {runContext} from './context.js';

const dsn=process.env.TEST_TOOL_CONTRACTS_DSN;
test('catalog, native declarations and partial-read outcomes share one contract', {skip:!dsn&&'requires isolated PostgreSQL'},async t=>{
 assert.match(new URL(dsn!).pathname,/^\/test_[a-z0-9_]+$/);process.env.SERIES_PG_DSN=dsn;
 const db=await openDatabase();t.after(()=>db.close());
 const dir=await mkdtemp(join(tmpdir(),'fate-catalog-contract-'));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
 const task=(await db.query(`WITH e AS (INSERT INTO explorations(goal) VALUES ('synthetic') RETURNING id)
  INSERT INTO tasks(description,goal,exploration_id) SELECT 'synthetic','synthetic',id FROM e RETURNING id,exploration_id`)).rows[0]!;
 const fact=async(evidence:string)=>(await db.query("INSERT INTO exploration_nodes(exploration_id,kind,state,payload) VALUES ($1,'fact','confirmed',$2::jsonb) RETURNING id",[task.exploration_id,JSON.stringify({summary:'local fixture',evidence})])).rows[0]!.id;
 const long=await fact('中文😀'.repeat(5000)),short=await fact('saved local evidence');
 const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
 const faux=fauxProvider({provider:'catalog-contract-local'});runtime.registerNativeProvider(faux.provider);
 for(const role of ['worker','planner'] as const)await t.test(role+' native declarations match catalog and keep partial errors',async()=>{
  const ctx=runContext(db,Number(task.id),Number(task.exploration_id),role);
  const preview=await previewRoleTools(db,role);
  assert(preview.resident.includes('tool_search'));
  assert.deepEqual(preview.schemas.tool_search,searchDefinition().parameters);
  assert.equal(preview.descriptions.tool_search,searchDefinition().description);
  const tools=[contextGetTool(ctx),assetGetTool(ctx)];
  if(role==='worker'){
   tools.push(insertAssetsTool(ctx));
   const bash=await configuredBash(db,dir,{});bash.description=await platformBashDescription(ctx,bash.description,(await db.platform().getAgentByKey(role))!.interactiveShell);
   assert.equal(preview.descriptions.bash,bash.description);
   const asset=tools.find(t=>t.name==='insert_assets')!;
   for(const legacy of [false,true]){
    const loaded=toolLoadout(role,{customTools:[asset],toolAllowlist:[asset.name]},{legacy}).customTools[0]!;
    assert.deepEqual(loaded.parameters,preview.schemas.insert_assets);
    for(const key of ['assets','items'])assert.doesNotThrow(()=>validateToolArguments(loaded,{type:'toolCall',id:'alias',name:asset.name,arguments:{[key]:[{type:'ip',ip:'192.0.2.1'}]}}));
    assert.throws(()=>validateToolArguments(loaded,{type:'toolCall',id:'mixed',name:asset.name,arguments:{assets:[{type:'ip',ip:'192.0.2.1'}],items:[{type:'ip',ip:'192.0.2.1'}]}}));
   }
  }
  const bound=await applyToolBindings(db,role,tools);
  const args={items:[{ref:'node:'+long},{ref:'node:'+short}]};
  const activities:RunnerActivity[]=[];let requests=0;
  faux.setResponses([context=>{
   requests++;
   const declared=new Map<string,any>();for(const m of context.messages as any[])if(m.role==='system')for(const tool of m.toolsAdded??[])declared.set(tool.name,tool);
   for(const name of ['context_get','tool_search',...(role==='worker'?['insert_assets']:[])]){
    assert(declared.has(name),name);assert.deepEqual(declared.get(name).parameters,preview.schemas[name]);assert.equal(declared.get(name).description,preview.descriptions[name]);
   }
   return fauxAssistantMessage([fauxToolCall('context_get',args)]);
  },()=>{requests++;return fauxAssistantMessage('Read failed item reported; no automatic retry.');}]);
  const runner=await AgentRunner.create({cwd:dir,agentDir:dir,modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Local contract test.',customTools:bound,toolAllowlist:bound.map(t=>t.name),
   toolLoading:{version:'lean-tools-v1',initialActive:bound.filter(t=>t.name!=='asset_get').map(t=>t.name),deferred:['asset_get'],compatibility:[]},onActivity:a=>{activities.push(a);}});
  try{await runner.prompt('Read local fixtures once.');}finally{await runner.dispose();}
  assert.equal(requests,2);
  const results=activities.filter((a):a is Extract<RunnerActivity,{kind:'tool_end'}>=>a.kind==='tool_end');
  assert.equal(results.length,1);assert.equal(results[0]!.isError,true);
  const partial=JSON.parse(results[0]!.text!);assert.match(partial.error,/1\/2/);
  assert.equal(partial.items[0].error_code,'READ_SELECTION_REQUIRED');assert(partial.items[0].read_options.some((o:any)=>o.field==='/payload/evidence'));
  assert.match(partial.items[1].content,/saved local evidence/);assert(partial.items[1].read_receipt);
  const tool=contextGetTool(ctx);
  const invoke=async(items:unknown[])=>tool.execute('read',validateToolArguments(tool,{type:'toolCall',id:'read',name:tool.name,arguments:{items}}),undefined,undefined,{} as never);
  const allFailed=await invoke([{ref:'node:'+long}]);assert.equal(allFailed.isError,true);assert.match((allFailed.content[0] as {text:string}).text,/1\/1/);
  const selected=partial.items[0].read_options.find((o:any)=>o.field==='/payload/evidence');
  const success=await invoke([selected,{ref:'node:'+short}]);assert.notEqual(success.isError,true);
  const body=JSON.parse((success.content[0] as {text:string}).text);assert(body.items[0].next_item);assert(!body.items.some((i:any)=>i.error));
 });
});
