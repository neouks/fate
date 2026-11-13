import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Database} from '../db/index.js';
import {prepareReproduction,expandTrafficPackets,assembleReport,type Reproduction} from './reproduction.js';
import {REPORTER_PROMPT,hostProtocol} from '../agent/prompts.js';
import {reportSectionsSchema} from './report-sections.js';

function fixture(options:{truncated?:boolean;body?:Buffer;length?:number;task?:number}={}){
 const request=Buffer.from('{"query":"合成资料"}'),response=options.body??Buffer.from('{"result":"local fixture"}');
 const snap={id:'fixture',task_id:options.task??7,intent_id:null,req_head:'POST /sample HTTP/1.1\r\nHost: fixture.test\r\nContent-Type: application/json\r\nX-Request: kept',resp_head:'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Response: kept\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2',req_hash:'req',resp_hash:'resp',req_len:request.length,resp_len:options.length??response.length,capture_truncated:options.truncated??false};
 const db={tasks:()=>({getTask:async()=>({id:7,exploration_id:8})}),query:async(sql:string,args:unknown[])=>{
  if(sql.includes('traffic_evidence_snapshots'))return {rows:Number(args[1])===Number(snap.task_id)?[snap]:[]};
  if(sql.includes('evidence_blobs'))return {rows:[{bytes:args[0]==='req'?request:response}]};
  throw new Error('Unexpected query: '+sql);
 }} as unknown as Database;
 const repro:Reproduction={entry_point:'http://fixture.test/sample',prerequisites:[],provenance:'',steps:[{id:'s1',action:'提交合成查询',request:'',response:'',expected:'',proves:'记录真实返回',traffic_id:'fixture'}]};
 return {db,repro,snap,request,response};
}

test('HTTP traffic reference expands all recorded headers and bodies; export has continuous steps',async()=>{
 const {db,repro,snap,request,response}=fixture();
 repro.steps[0]!.source='evidence';
 const result=await prepareReproduction(db,repro,{taskID:7,evidence:''},true);
 assert.equal(result!.steps[0]!.request,snap.req_head+'\r\n\r\n'+request.toString());
 assert.equal(result!.steps[0]!.response,snap.resp_head+'\r\n\r\n'+response.toString());
 const markdown=assembleReport({name:'合成漏洞',reproduction:result,evidence:'fixture',evidence_version:1,report_evidence_version:1});
 assert.match(markdown,/## 复现步骤\n/);
 assert.match(markdown,/1\. 提交合成查询/);
 assert.doesNotMatch(markdown,/### 步骤/);
 assert.ok(markdown.includes(result!.steps[0]!.request));
 assert.ok(markdown.includes(result!.steps[0]!.response));
 const refreshed=await expandTrafficPackets(db,structuredClone(result),7);
 assert.deepEqual(refreshed,result);
 const reSaved=await prepareReproduction(db,result,{taskID:7,evidence:'old short excerpt'},true);
 assert.deepEqual(reSaved,result);
});

test('cross-task references and fabricated packet excerpts cannot be saved',async()=>{
 const {db,repro}=fixture({task:8});
 await assert.rejects(prepareReproduction(db,repro,{taskID:7,evidence:''},true),/流量引用/);
 const current=fixture();current.repro.steps[0]!.response='invented success';
 await assert.rejects(prepareReproduction(current.db,current.repro,{taskID:7,evidence:''},true),/摘录不匹配/);
});

test('truncated, binary and large evidence stays explicitly incomplete instead of fabricating packets',async()=>{
 for(const [options,note] of [[{truncated:true},'截断'],[{body:Buffer.from([0,255])},'二进制'],[{length:300000},'内联展示上限']] as const){
  const {db,repro}=fixture(options);
  const result=await prepareReproduction(db,repro,{taskID:7,evidence:''},true);
  assert.equal(result!.steps[0]!.truncated,true);
  assert.ok(result!.steps[0]!.packet_note!.includes(note));
  assert.equal(result!.steps[0]!.traffic_id,'fixture');
 }
});

test('source-only partial HTTP evidence is preserved with an explicit gap',async()=>{
 const {db,repro}=fixture();
 repro.steps=[{id:'s',action:'核对已有证据',request:'GET /sample HTTP/1.1',response:'{"ok":true}',expected:'',proves:'仅有片段',source:'evidence'}];
 const result=await prepareReproduction(db,repro,{taskID:7,evidence:'GET /sample HTTP/1.1\n{"ok":true}'},true);
 assert.match(result!.steps[0]!.packet_note!,/未包含完整 HTTP/);
 assert.equal(result!.steps[0]!.response,'{"ok":true}');
});

test('Reporter template, host protocol and tool schema agree on concise prose without a word cap',()=>{
 for(const content of [REPORTER_PROMPT,hostProtocol('reporter'),JSON.stringify(reportSectionsSchema(true))])assert.doesNotMatch(content,/最多.{0,5}60|上限.{0,5}60|maxLength/);
 assert.match(REPORTER_PROMPT,/完整 Body/);
 assert.match(hostProtocol('reporter'),/不补造/);
});
