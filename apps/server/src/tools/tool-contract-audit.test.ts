import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {validateToolArguments} from '@earendil-works/pi-ai';
import type {ToolDefinition} from '@earendil-works/pi-coding-agent';
import {openDatabase,type Database} from '../db/index.js';
import {ACTIVE_ROLES} from '../agent/tool-registry.js';
import {roleDefinitions,previewRoleTools} from '../agent/tool-catalog.js';
import {applyToolBindings} from '../agent/tool-bindings.js';
import {compactToolSchema} from '../agent/tool-loading.js';
import {effectiveToolDescription} from '../agent/tool-descriptions.js';
import {runContext} from './context.js';
import {goalsTools} from './index.js';
import {steerWorkTool} from './intents.js';
import {reportFindingTool,listFindingsTool} from './findings.js';
import {setConstraintsTool} from './goals.js';
import {assetGetTool,listUntestedAssetsTool} from './assets.js';
import {graphIndexTool} from './graph_read.js';
import {getWorkerTraceTool,searchWorkerTracesTool} from './graph.js';
import {trafficSearchTool} from './traffic-search.js';
import {reporterTrafficTools} from './reporter-traffic.js';
import {conversationDomainTools} from './conversations.js';

const empty={} as Database;
const ctx=(role:'worker'|'planner'|'goals'|'mainagent')=>runContext(empty,1,1,role);
const validate=(tool:ToolDefinition,args:Record<string,unknown>)=>validateToolArguments(tool,{type:'toolCall',id:'fixture',name:tool.name,arguments:args});
async function invoke(tool:ToolDefinition,args:Record<string,unknown>){
 const result=await tool.execute(randomUUID(),validate(tool,args),undefined,undefined,{} as never);
 return {error:result.isError===true,body:JSON.parse((result.content[0] as {text:string}).text)};
}

test('steering schema rejects impossible correction combinations before delivery',()=>{
 const tool=steerWorkTool(ctx('planner'));
 for(const correction of [{kind:'reuse_evidence',criterion_indices:[0]},{kind:'stop_criteria',criterion_indices:[0],fact_ids:[1]},
  {kind:'adjust_method',criterion_indices:[0],method:'改用分号'},
  {kind:'adjust_method',criterion_indices:[0],method:'改用分号',reason:'分隔失败',fact_ids:[1]},
  {kind:'reuse_evidence',criterion_indices:[0],fact_ids:[1],method:'改用分号'}])
  assert.throws(()=>validate(tool,{intent_id:1,correction}));
 for(const correction of [{kind:'reuse_evidence',criterion_indices:[0],fact_ids:[1]},{kind:'stop_criteria',criterion_indices:[0]},
  {kind:'adjust_method',criterion_indices:[0],method:'改用分号',reason:'分隔失败'}])
  assert.doesNotThrow(()=>validate(tool,{intent_id:1,correction}));
 assert.match(tool.description,/adjust_method/);
});

test('finding creation and amendment have disjoint native schemas',()=>{
 for(const role of ['worker','mainagent'] as const){
  const tool=reportFindingTool(ctx(role)),base={vulnclass:'fixture',severity:'low',summary:'fixture',evidence:'original'};
  for(const args of [{finding_id:1,evidence_version:0},{...base,evidence_version:0},{...base,finding_id:1},
   {...base,distinct_from:[1]},{...base,distinct_reason:'different'},
   {finding_id:1,evidence_version:0,evidence:'extra',distinct_from:[2],distinct_reason:'different'},
   {...base,summary:' '},{...base,evidence:' '}])assert.throws(()=>validate(tool,args));
  for(const args of [base,{finding_id:1,evidence_version:0,evidence:'extra'},
   {...base,distinct_from:[1],distinct_reason:'different mechanism'}])assert.doesNotThrow(()=>validate(tool,args));
 }
});

test('role-specific constraints and fixed legacy queries expose runtime restrictions',()=>{
 assert.throws(()=>validate(setConstraintsTool(ctx('goals')),{constraints:[],replace:true}));
 assert.throws(()=>validate(setConstraintsTool(ctx('mainagent')),{constraints:[],replace:true}));
 assert.doesNotThrow(()=>validate(setConstraintsTool(ctx('goals')),{constraints:[]}));
 assert.throws(()=>validate(listUntestedAssetsTool(ctx('planner')),{untested:false}));
 assert.throws(()=>validate(graphIndexTool(ctx('planner'),'list_facts'),{kind:'goal'}));
 assert.throws(()=>validate(listFindingsTool(ctx('worker')),{offset:-1}));
 assert.throws(()=>validate(assetGetTool(ctx('worker')),{ids:[1],field:'auth'}));
});

test('default read guidance upgrades while custom help remains untouched',()=>{
 const old='按 ids 和字段组读取资产；identity/fingerprint 默认返回，dns/params/auth/extra 按需选择。field 使用 JSON Pointer；next 参数原样续读 Unicode 正文。';
 const upgraded=effectiveToolDescription('asset_get','unused',old);
 assert.equal(upgraded.source,'builtin');assert.match(upgraded.description,/deferred.*read/);
 assert.deepEqual(effectiveToolDescription('asset_get','unused','custom help'),{description:'custom help',source:'custom'});
});

const dsn=process.env.TEST_TOOL_CONTRACTS_DSN;
test('platform contracts execute against isolated data, without model or target requests',{skip:!dsn&&'requires isolated PostgreSQL'},async t=>{
 assert.match(new URL(dsn!).pathname,/^\/test_[a-z0-9_]+$/);process.env.SERIES_PG_DSN=dsn;
 const db=await openDatabase();t.after(()=>db.close());
 const task=(await db.query(`WITH e AS (INSERT INTO explorations(goal) VALUES ('fixture') RETURNING id)
  INSERT INTO tasks(description,goal,exploration_id) SELECT 'fixture','fixture',id FROM e RETURNING id,exploration_id`)).rows[0]!;
 const taskID=Number(task.id),expID=Number(task.exploration_id),worker=runContext(db,taskID,expID,'worker'),planner=runContext(db,taskID,expID,'planner');
 const graph=db.exploration(expID);
 await db.query("INSERT INTO task_scope(task_id,kind,domain) VALUES ($1,'subdomain','fixture.example.test')",[taskID]);
 const addAsset=async(slug:string)=>{
  const id=Number((await db.query("INSERT INTO assets(type,domain,url,method,extra) VALUES ('endpoint','fixture.example.test',$1,'GET',$2::jsonb) RETURNING id",[
   'https://fixture.example.test/'+slug,JSON.stringify({original:'中文😀'.repeat(5000)}),
  ])).rows[0]!.id);
  await db.query('INSERT INTO task_asset_links(task_id,asset_id) VALUES ($1,$2)',[taskID,id]);return id;
 };
 const a=await addAsset('alpha'),b=await addAsset('beta');

 await t.test('asset reads preserve successes, expose missing groups, and reset deferred coordinates',async()=>{
  const tool=assetGetTool(worker);
  const mixed=await invoke(tool,{ids:[a,2147483647]});assert.equal(mixed.error,true);
  assert.equal(mixed.body.assets[0].asset_id,a);assert(mixed.body.assets[1].error);
  const missing=await invoke(tool,{ids:[a],field:'/extra/original'});assert.equal(missing.error,true);
  const group=missing.body.assets[0].read_options.find((r:any)=>r.field==='/extra');assert(group);
  const first=await invoke(tool,{...group,max_chars:80});assert.equal(first.error,false);
  const read=first.body.assets[0].details.entries[0].read;
  assert.equal(read.index,0);assert.equal(read.offset,0);assert.equal(read.field,'/extra/original');
  const page=await invoke(tool,read);assert.equal(page.error,false);assert.equal(page.body.assets[0].details.value,Array.from('中文😀'.repeat(5000)).slice(0,80).join(''));
  assert(page.body.assets[0].next.offset>0);
  const large=await invoke(tool,{ids:[a,2147483647],fields:['extra'],field:'/extra/original',max_chars:24000});
  assert.equal(large.error,true);assert.equal(large.body.truncated_fields,undefined);
  const delivered=large.body.assets[0];assert.equal(delivered.next.offset,Array.from(delivered.details.value).length);
  assert.equal(delivered.details.value,Array.from('中文😀'.repeat(5000)).slice(0,delivered.next.offset).join(''));
 });

 await t.test('legacy untested query honors DSL, paging and coverage permission',async()=>{
  const tool=listUntestedAssetsTool(planner);
  const page=await invoke(tool,{dsl:'url contains "alpha"',limit:1});assert.equal(page.error,false);
  assert.deepEqual(page.body.assets.map((r:any)=>r.id),[a]);assert.equal(page.body.total,1);
  const all=await invoke(tool,{limit:1});assert.equal(all.body.next_offset,1);
  assert.deepEqual((await invoke(tool,{limit:1,offset:all.body.next_offset})).body.assets.map((r:any)=>r.id),[b]);
  await db.query('UPDATE tasks SET coverage_enabled=false WHERE id=$1',[taskID]);
  assert.equal((await invoke(tool,{})).error,true);
  await db.query('UPDATE tasks SET coverage_enabled=true WHERE id=$1',[taskID]);
 });

 const intent=await graph.addNode('intent',{summary:'fixture'},0,'done','fixture',[]);
 const activity=async(kind:string,summary:string,detail:string,metadata={})=>Number((await db.query(
  'INSERT INTO activity(exploration_id,node_id,worker,kind,summary,detail,metadata) VALUES($1,$2,\'fixture\',$3,$4,$5,$6::jsonb) RETURNING id',
  [expID,intent,kind,summary,detail,JSON.stringify(metadata)],
 )).rows[0]!.id);
 const secret=await activity('thinking','private needle','private needle');
 const original='prefix '.repeat(100)+'needle original '+'body '.repeat(200);
 const step=await activity('tool_result','fixture',original);
 const final='FINAL ORIGINAL '+'正文😀'.repeat(600);
 await activity('result','short summary',final,{event_type:'outcome'});

 await t.test('trace search locates literal matches and detail/output read original text without thoughts',async()=>{
  const search=await invoke(searchWorkerTracesTool(planner),{query:'needle'});assert.equal(search.error,false);
  assert.equal(search.body.matches.length,1);assert.match(JSON.stringify(search.body.matches[0]),/needle original/);
  const tool=getWorkerTraceTool(planner),list=await invoke(tool,{intent_id:intent});
  assert(!list.body.steps.some((r:any)=>r.step_id===secret));
  const page=await invoke(tool,{intent_id:intent,step_ids:[secret,step]});assert.equal(page.error,false);
  assert.equal(page.body.detail.length,1);assert.deepEqual(page.body.steps,[]);
  assert.equal(page.body.detail[0].body,original.slice(0,350));
  const next=await invoke(tool,page.body.detail[0].next);assert.equal(next.body.detail[0].body,original.slice(350,700));
  const output=await invoke(tool,{intent_id:intent,include_output:true});assert.equal(output.body.final_output,final.slice(0,1000));
  assert.equal((await invoke(tool,output.body.output_next)).body.final_output,final.slice(1000,2000));
 });

 await t.test('legacy graph cursors are directly reusable tool arguments',async()=>{
  for(let i=0;i<22;i++)await graph.addNode('fact',{summary:'fixture '+i},0,'confirmed','fixture',[]);
  const tool=graphIndexTool(planner,'list_facts'),first=await invoke(tool,{});
  assert.equal(first.body.nodes.length,20);assert.equal(first.body.next.after_id,first.body.next_cursor);
  const next=await invoke(tool,first.body.next);assert.equal(next.error,false);assert.equal(next.body.nodes.length,2);
  assert(!next.body.nodes.some((n:any)=>first.body.nodes.some((p:any)=>p.id===n.id)));
 });

 const findings:number[]=[];
 for(let i=0;i<3;i++)findings.push(Number((await db.query("INSERT INTO findings(task_id,summary,evidence) VALUES ($1,'fixture',$2) RETURNING id",[taskID,'original😀'.repeat(1000)])).rows[0]!.id));
 await t.test('finding listing has continuation and reporter pages reject version mixing',async()=>{
  const list=listFindingsTool(planner),first=await invoke(list,{limit:2});assert.equal(first.body.has_more,true);
  assert.equal((await invoke(list,first.body.next)).body.findings.length,1);
  const tools=conversationDomainTools(runContext(db,taskID,expID,'reporter'),{} as never),get=tools.find(t=>t.name==='get_finding')!;
  const page=await invoke(get,{finding_id:findings[0]});assert.equal(page.error,false);assert.equal(page.body.read_complete,false);
  const next=await invoke(get,page.body.next);assert.equal(next.error,false);
  await db.query('UPDATE findings SET evidence_version=evidence_version+1 WHERE id=$1',[findings[0]]);
  const stale=await invoke(get,page.body.next);assert.equal(stale.error,true);assert.equal(stale.body.code,'FINDING_READ_VERSION_CHANGED');
  const restart=await invoke(get,stale.body.read_options[0]);assert.equal(restart.error,false);assert.equal(restart.body.read_complete,false);
 });

 await t.test('traffic searches page existing local records with stable tie ordering',async()=>{
  const addTraffic=async(time:number)=>{
   const id=randomUUID();
   await db.query(`INSERT INTO traffic_evidence_snapshots(id,source_traffic_id,captured_at,url,method,status,req_head,resp_head,req_hash,resp_hash,req_len,resp_len,task_id)
    VALUES($1,$1,$3,'https://fixture.example.test/alpha','GET',200,'fixture request','fixture response','','',0,0,$2)`,[id,taskID,time]);
   await db.query("INSERT INTO traffic_exchanges(id,task_id,host) VALUES ($1,$2,'fixture.example.test')",[id,taskID]);return id;
  };
  for(let i=0;i<22;i++)await addTraffic(1);
  const tool=trafficSearchTool(worker),first=await invoke(tool,{query:'alpha',limit:20});assert.equal(first.error,false);assert.equal(first.body.items.length,20);
  const fresh=await addTraffic(2);
  assert.equal((await invoke(tool,{...first.body.next,query:'changed'})).error,true);
  const last=await invoke(tool,first.body.next);assert(!last.body.items.some((r:any)=>r.traffic_id===fresh));assert.equal(last.body.items.length,2);assert.equal(last.body.has_more,false);
  assert(!last.body.items.some((r:any)=>first.body.items.some((p:any)=>p.traffic_id===r.traffic_id)));
  await db.query("INSERT INTO settings(key,value) VALUES ('agent_traffic_binding','true') ON CONFLICT(key) DO UPDATE SET value='true'");
  const search=reporterTrafficTools(runContext(db,taskID,expID,'reporter')).find(t=>t.name==='search_finding_traffic')!;
  const report=await invoke(search,{finding_id:findings[0],query:'alpha'});assert.equal(report.error,false);assert.equal(report.body.items.length,20);
  assert.equal((await invoke(search,report.body.next)).body.items.length,3);
 });

 await t.test('all seven roles expose the same platform schemas and help as their bound tools',async()=>{
  let checked=0;const counts:Record<string,number>={};
  for(const role of ACTIVE_ROLES){
   const preview=await previewRoleTools(db,role);counts[role]=0;
   if(preview.descriptions.traffic_search)assert.match(preview.descriptions.traffic_search,/next 原样续页/);
   if(preview.descriptions.search_finding_traffic)assert.match(preview.descriptions.search_finding_traffic,/next 原样续页/);
   if(preview.descriptions.get_finding)assert.match(preview.descriptions.get_finding,/read_complete/);
   if(preview.descriptions.steer_work)assert.match(preview.descriptions.steer_work,/adjust_method/);
   const definitions=role==='goals'?goalsTools({...runContext(db,taskID,expID,'goals'),goalsPhase:'combined'}):roleDefinitions(db,role);
   for(const tool of await applyToolBindings(db,role,definitions)){
    if(!preview.schemas[tool.name])continue;
    const loaded=compactToolSchema(tool);
    assert.deepEqual(preview.schemas[tool.name],loaded.parameters,role+':'+tool.name);
    assert.equal(preview.descriptions[tool.name],loaded.description,role+':'+tool.name);checked++;counts[role]++;
   }
  }
  for(const role of ACTIVE_ROLES)assert(counts[role]!>0,role);
  t.diagnostic(JSON.stringify({checked,roles:counts}));
 });
});
