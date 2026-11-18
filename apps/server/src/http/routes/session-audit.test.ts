import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from 'pg';
import {postgresDSN} from '../../config/index.js';
import {factSignatureSQL,groupFacts,inspectSession} from './session-audit-data.js';

test('archived fact versions, partial batches, multiple reads and next-response byte accounting',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'fact-history-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'session.jsonl');
  const message=(message:unknown)=>({type:'message',message});
  const assistant=(input:number,content:unknown[]=[])=>message({role:'assistant',usage:{input,cacheRead:10,cacheWrite:1},content});
  const result=(name:string,id:string,body:unknown,error=false)=>message({role:'toolResult',toolName:name,toolCallId:id,isError:error,
    content:[{type:'text',text:typeof body==='string'?body:JSON.stringify(body)}]});
  const original={summary:'first',evidence:'原始记录'};
  const rows=[assistant(30,[{type:'toolCall',name:'record_fact',id:'batch',arguments:{facts:[{},original]}}]),
    result('record_fact','batch',{results:[{error:'invalid'},{fact_id:10,version:1}]}),
    result('read','large','中'.repeat(2000)),assistant(57),
    result('context_get','read',{items:[{ref:'node:10',version:1,content:'a'},{ref:'node:10',version:2,content:'b'},
      {ref:'node:10',version:3,error:'conflict'},{ref:'node:99',version:1,content:'other'}]},true),assistant(80)];
  await writeFile(file,rows.map(r=>JSON.stringify(r)).join('\n'));
  const selected={id:10,version:1,originals:[]};
  const session=await inspectSession(file,'Planner',new Set([10,11]),selected);
  assert.equal(session.rounds[1]?.total,68);assert.equal(session.rounds[1]?.delta,27);
  assert.deepEqual(session.rounds[1]?.largeOutputs,[{label:'read',bytes:6000}]);
  assert.deepEqual(session.rounds.flatMap(r=>r.events.map(e=>[e.id,e.version,e.round,e.kind])),
    [[10,1,1,'submit'],[10,1,2,'read'],[10,2,2,'read']]);
  assert.deepEqual(selected.originals.map((o:{content:unknown})=>o.content),[original,'a']);
  const facts=[{id:10,version:2,summary:'latest',worker:'A',signature:null},{id:11,version:1,summary:'no receipt',worker:'B',signature:null}];
  const audit=groupFacts(facts,[session]);
  assert.equal(audit.rawCount,2);assert.equal(audit.repeatCount,1);
  assert.deepEqual(audit.groups.flat().map(m=>[m.id,m.version]),[[10,2],[11,1],[10,1]]);
  assert.equal(audit.groups.flat().find(m=>m.id===11)?.events.length,0);
});

test('missing transcript explicitly reports incomplete history',async()=>{
  assert.deepEqual((await inspectSession('/missing-fixture/session.jsonl','Planner',new Set())).warnings,['未找到会话日志']);
});

test('canonical SQL groups only matching cross-worker facts and keeps unknown and conflicting evidence separate',
 {skip:!process.env.TEST_SESSION_AUDIT_READ_ONLY},async t=>{
  const db=new Client({connectionString:postgresDSN().dsn,options:'-c default_transaction_read_only=on'});
  await db.connect();t.after(()=>db.end());
  const base={summary:'same',evidence:'verbatim',scope:{tested:'local'},observation_type:'observed'};
  const values=[base,base,{...base,evidence:'different'},{...base,observation_type:'negative'},{...base,scope:{tested:'another'}},
    {...base,observation_type:'unknown'},{...base,observation_type:'unknown'},base];
  const rows=(await db.query(`WITH n AS (SELECT ordinality AS id,'confirmed' AS state,p AS payload
    FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS f(p,ordinality)),
    exploration_anchors AS (SELECT id AS node_id,CASE WHEN id=8 THEN 55 ELSE 1 END AS asset_id FROM n)
    SELECT n.id,${factSignatureSQL} AS signature FROM n ORDER BY n.id`,
    [JSON.stringify(values.map((v,i)=>({...v,from_intent:i+1})))])).rows;
  const facts=rows.map(r=>({id:Number(r.id),version:0,summary:'same',worker:'Worker #'+r.id,signature:r.signature}));
  const a=groupFacts(facts,[]);
  assert.equal(a.rawCount,8);
  assert.deepEqual(a.groups.map(g=>g.map(x=>x.id)),[[1,2],[3],[4],[5],[6],[7],[8]]);
});

test('offline byte estimate separates pagination, versions, exact repeats and compaction boundaries',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'audit-reading-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'session.jsonl');
  const body='多字节原文'.repeat(80);
  const response={type:'message',message:{role:'assistant',content:[]}};
  const item=(start:number,version=0)=>({ref:'node:10',version,view:'detail',field:'/evidence',content:body,
    read_receipt:{start,end:start+400,total:800,source_hash:'fixture'}});
  const result=(id:string,tool:string,items:unknown[])=>({type:'message',message:{role:'toolResult',toolName:tool,toolCallId:id,
    content:[{type:'text',text:JSON.stringify({items})}]}});
  const search={ref:'node:10',version:0,summary:'a'};
  const rows=[response,result('call-a','context_get',[item(0)]),response,result('call-b','context_get',[item(400),item(0),item(0,1)]),
    result('search','context_search',[search,search]),{type:'compaction'},response,result('call-c','context_get',[item(0)])];
  await writeFile(file,rows.map(r=>JSON.stringify(r)).join('\n'));
  const s=await inspectSession(file,'Worker #1',new Set([10]));
  const totals=groupFacts([{id:10,version:1,summary:'fact',worker:s.name,signature:null}],[s]).reads;
  const expectedBytes=Buffer.byteLength(JSON.stringify(body))-Buffer.byteLength(JSON.stringify({ref:'node:10',version:0,tool_call_id:'call-a',item_index:0}));
  assert.deepEqual(totals.read,{items:5,pages:1,identical:1,netBytes:expectedBytes});
  assert.deepEqual(totals.search,{items:2,pages:0,identical:1,netBytes:0});
  assert.equal(s.rounds[1]?.events[1]?.comparison?.firstRound,1);
  assert.equal(s.rounds[2]?.events[0]?.comparison?.match,'distinct');
});
