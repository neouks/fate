import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fauxProvider,fauxAssistantMessage,fauxToolCall,validateToolArguments} from '@earendil-works/pi-ai';
import {ModelRuntime,createBashToolDefinition} from '@earendil-works/pi-coding-agent';
import {openDatabase} from '../db/index.js';
import {trafficSearchTool} from './traffic-search.js';
import {PREVIOUS_CONTEXT_GET_DESCRIPTION} from '../agent/tool-descriptions.js';
import {PREVIOUS_TRAFFIC_SEARCH_DESCRIPTION} from '../agent/tool-description-policy.js';
import {previewRoleTools,searchDefinition} from '../agent/tool-catalog.js';
import {toolLoadout} from '../agent/tool-loading.js';
import {applyToolBindings} from '../agent/tool-bindings.js';
import {AgentRunner,type RunnerActivity} from '../pi/runner.js';
import {steerWorkTool} from './intents.js';
import {reportFindingTool,listFindingsTool} from './findings.js';
import {conversationDomainTools} from './conversations.js';
import {contextGetTool} from './context-read.js';
import {insertAssetsTool,assetGetTool} from './assets.js';
import {runContext} from './context.js';

const dsn=process.env.TEST_TOOL_CONTRACTS_DSN;
test('catalog, native declarations and partial-read outcomes share one contract', {skip:!dsn&&'requires isolated PostgreSQL'},async t=>{
 assert.match(new URL(dsn!).pathname,/^\/test_[a-z0-9_]+$/);process.env.SERIES_PG_DSN=dsn;
 const db=await openDatabase();t.after(()=>db.close());
 await db.query("UPDATE tools SET description=$1 WHERE key='traffic_search'",[PREVIOUS_TRAFFIC_SEARCH_DESCRIPTION]);
 await db.query("UPDATE tools SET description=$1 WHERE key='context_get'",[PREVIOUS_CONTEXT_GET_DESCRIPTION+' 任一项失败则调用标为失败，成功项仍保留；长正文需选择 field，按 read_options 选择读取。']);
 const dir=await mkdtemp(join(tmpdir(),'fate-catalog-contract-'));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
 const task=(await db.query(`WITH e AS (INSERT INTO explorations(goal) VALUES ('synthetic') RETURNING id)
  INSERT INTO tasks(description,goal,exploration_id) SELECT 'synthetic','synthetic',id FROM e RETURNING id,exploration_id`)).rows[0]!;
 const fact=async(evidence:string)=>(await db.query("INSERT INTO exploration_nodes(exploration_id,kind,state,payload) VALUES ($1,'fact','confirmed',$2::jsonb) RETURNING id",[task.exploration_id,JSON.stringify({summary:'local fixture',evidence})])).rows[0]!.id;
 const long=await fact('中文😀'.repeat(5000)),short=await fact('saved local evidence');
 const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
 const faux=fauxProvider({provider:'catalog-contract-local'});runtime.registerNativeProvider(faux.provider);
 for(const role of ['worker','planner','reporter'] as const)await t.test(role+' native declarations match catalog and keep partial errors',async()=>{
  const ctx=runContext(db,Number(task.id),Number(task.exploration_id),role);
  const preview=await previewRoleTools(db,role);
  assert(preview.resident.includes('tool_search'));
  assert.match(preview.descriptions.context_get!,/next_item 原样放入 items/);
  assert.match(preview.descriptions.context_get!,/版本时按 read_options 从 offset=0/);
  assert.doesNotMatch(preview.descriptions.context_get!,/正文只需|冲突重新检索|长正文需选择 field/);
  assert.deepEqual(preview.schemas.tool_search,searchDefinition().parameters);
  assert.equal(preview.descriptions.tool_search,searchDefinition().description);
  const tools=[contextGetTool(ctx),assetGetTool(ctx),trafficSearchTool(ctx),...(role==='reporter'?[listFindingsTool(ctx)]:[]),
   ...(role==='planner'?[steerWorkTool(ctx)]:role==='worker'?[reportFindingTool(ctx)]:conversationDomainTools(ctx,{} as never).filter(t=>['get_finding','update_finding_report'].includes(t.name)))];
  if(role==='worker'){
   tools.push(insertAssetsTool(ctx));
   const bash=createBashToolDefinition(dir);
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
  const args={items:[{ref:'node:'+long,field:'/payload/missing'},{ref:'node:'+short}]};
  const activities:RunnerActivity[]=[];let requests=0;
  faux.setResponses([context=>{
   requests++;
   const declared=new Map<string,any>();for(const m of context.messages as any[])if(m.role==='system')for(const tool of m.toolsAdded??[])declared.set(tool.name,tool);
   for(const name of ['tool_search',...bound.filter(t=>t.name!=='asset_get').map(t=>t.name)]){
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
  const invoke=async(items:unknown[],max_chars?:number)=>tool.execute('read',validateToolArguments(tool,{type:'toolCall',id:'read',name:tool.name,arguments:{items,...(max_chars?{max_chars}:{})}}),undefined,undefined,{} as never);
  const allFailed=await invoke([{ref:'node:'+long,offset:100}]);assert.equal(allFailed.isError,true);assert.match((allFailed.content[0] as {text:string}).text,/1\/1/);
  const first=await invoke([{ref:'node:'+long},{ref:'node:'+short}]);assert.notEqual(first.isError,true);
  const pages=JSON.parse((first.content[0] as {text:string}).text);assert.equal(pages.items[0].field,'');assert.equal(pages.items[0].read_receipt.coordinate.field,'');
  assert(pages.items[0].next_item);assert.equal(pages.items[0].next_item.field,'');assert.match(pages.items[1].content,/saved local evidence/);
  const next=await invoke([pages.items[0].next_item]);assert.notEqual(next.isError,true);
  const nextPage=JSON.parse((next.content[0] as {text:string}).text).items[0];assert.equal(nextPage.read_receipt.start,pages.items[0].read_receipt.end);
  assert.equal(nextPage.read_receipt.source_hash,pages.items[0].read_receipt.source_hash);
  let complete=pages.items[0].content+nextPage.content,cursor=nextPage.next_item;
  for(let n=0;cursor&&n<30;n++){
   const chunk=await invoke([cursor]);assert.notEqual(chunk.isError,true);
   const part=JSON.parse((chunk.content[0] as {text:string}).text).items[0];
   assert.equal(part.read_receipt.start,Array.from(complete).length);complete+=part.content;cursor=part.next_item;
  }
  assert.equal(cursor,undefined);assert.equal(JSON.parse(complete).payload.evidence,'中文😀'.repeat(5000));
  const bounded=await invoke([{ref:'node:'+long},{ref:'node:'+short}],256);assert.notEqual(bounded.isError,true);
  assert(JSON.parse((bounded.content[0] as {text:string}).text).items.reduce((n:number,i:any)=>n+Array.from(i.content).length,0)<=256);
  const stale=await invoke([{ref:'node:'+long,version:1,field:'/payload/evidence',offset:100}]);assert.equal(stale.isError,true);
  const mismatch=JSON.parse((stale.content[0] as {text:string}).text).items[0];assert.equal(mismatch.error_code,'READ_VERSION_CHANGED');assert.equal(mismatch.current_version,0);
  assert.deepEqual(mismatch.read_options,[{ref:'node:'+long,view:'detail',version:0,field:'/payload/evidence',offset:0}]);
  const repaired=await invoke(mismatch.read_options);assert.notEqual(repaired.isError,true);
  assert.equal(JSON.parse((repaired.content[0] as {text:string}).text).items[0].read_receipt.start,0);
  const selected=partial.items[0].read_options.find((o:any)=>o.field==='/payload/evidence');
  const success=await invoke([selected,{ref:'node:'+short}]);assert.notEqual(success.isError,true);
  const body=JSON.parse((success.content[0] as {text:string}).text);assert(body.items[0].next_item);assert(!body.items.some((i:any)=>i.error));
 });
});
