import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ToolDefinition} from '@earendil-works/pi-coding-agent';
import type {Database} from '../db/index.js';
import {assembleReport} from '../evidence/reproduction.js';
import {reporterFindingInput} from '../evidence/reporter-input.js';
import {conversationDomainTools} from './conversations.js';
import {runContext} from './context.js';
import {MAX_TOOL_OUTPUT} from './define.js';

function fixture(role:'reporter'|'auto'='reporter') {
  const request='GET /sample HTTP/1.1\r\nHost: fixture.test\r\n\r\n';
  const response='HTTP/1.1 200 OK\r\n\r\n'+('中文😀\\"\n'.repeat(1200));
  const reproduction={entry_point:'https://fixture.test/sample',prerequisites:[],provenance:'',steps:[
    {id:'original',action:'核对已有记录',request,response,expected:'',proves:'原始返回',source:'evidence',verified:true},
  ]};
  const sections={description:'合成记录',impact:[],remediation:[],discovery:{}};
  const finding:Record<string,unknown>={id:9,task_id:7,name:'fixture',evidence:request+response,reproduction,
    report_sections:sections,evidence_version:2,report_evidence_version:2,report_revision:3};
  finding.report=assembleReport(finding);
  const bindings=[{id:1,snapshot_id:'snapshot',role:'proof',note:'kept',snapshot:{id:'snapshot',task_id:7,intent_id:null,
    url:'https://fixture.test/sample',req_head:'UNIQUE_HEADER '+('h'.repeat(9000)),resp_head:'HTTP/1.1 200 OK'}}];
  const evidence={finding_id:'9',version:2,report_version:2,bindings};
  let saved:unknown[]|undefined;
  const db={
    tasks:()=>({getTask:async()=>({id:7,exploration_id:8})}),
    transaction:async(run:(db:Database)=>unknown)=>run(db as unknown as Database),
    query:async(sql:string,args:unknown[])=>{
      if(sql.startsWith('SELECT * FROM findings')||sql.startsWith('SELECT evidence_version'))return {rows:[finding]};
      if(sql.includes('finding_traffic_bindings'))return {rows:bindings};
      if(sql.startsWith('INSERT INTO finding_report_versions'))return {rows:[]};
      if(sql.startsWith('UPDATE findings SET report=')){saved=args;return {rows:[]};}
      throw new Error('Unexpected database access: '+sql);
    },
  };
  const tools=conversationDomainTools(runContext(db as unknown as Database,7,8,role),{} as never);
  const invoke=async(name:string,args:Record<string,unknown>)=>{
    const tool=tools.find(t=>t.name===name)! as ToolDefinition;
    const result=await tool.execute('fixture',args,undefined,undefined,{} as never);
    assert.equal(result.content[0]?.type,'text');
    const text=(result.content[0] as {text:string}).text;
    assert.ok(Buffer.byteLength(text)<=MAX_TOOL_OUTPUT);
    return {error:result.isError===true,body:JSON.parse(text),bytes:Buffer.byteLength(text)};
  };
  return {finding,evidence,invoke,saved:()=>saved,sections};
}

test('Reporter omits only the exact derived report and preserves every original field and binding',()=>{
  const {finding,evidence}=fixture(),original=structuredClone(finding);
  const input=JSON.parse(reporterFindingInput(finding,evidence));
  assert.equal(input.report,undefined);
  for(const key of ['evidence','reproduction','report_sections'])assert.deepEqual(input[key],finding[key]);
  assert.deepEqual(input.traffic_evidence,evidence);
  assert.deepEqual(finding,original);
  finding.report+='\n独立的人工补充信息';
  assert.equal(JSON.parse(reporterFindingInput(finding,evidence)).report,finding.report);
  finding.report_sections=null;
  assert.equal(JSON.parse(reporterFindingInput(finding,evidence)).report,finding.report);
  finding.report_sections={description:'旧结构'};
  assert.equal(JSON.parse(reporterFindingInput(finding,evidence)).report,finding.report);
});

test('Reporter pages bindings once, losslessly, within the tool budget; saves reuse original steps',async()=>{
  const {finding,evidence,invoke,saved,sections}=fixture();
  const pieces:string[]=[];let offset:number|null=0,totalBytes=0,pages=0;
  const saveArgs={finding_id:9,evidence_version:2,report_revision:3,report_sections:sections};
  while(offset!==null){
    const {error,body,bytes}=await invoke('get_finding',{finding_id:9,offset});
    assert.equal(error,false);assert.equal(body.evidence,undefined);
    assert.equal(body.read_complete,body.next_offset===null);
    pieces.push(body.content);totalBytes+=bytes;pages++;
    if(offset===0)assert.match((await invoke('update_finding_report',saveArgs)).body.error,/尚未读完/);
    offset=body.next_offset;
  }
  const document=pieces.join('');
  assert.deepEqual(JSON.parse(document).traffic_evidence,evidence);
  assert.deepEqual(JSON.parse(document).reproduction,finding.reproduction);
  assert.equal(document.split('UNIQUE_HEADER').length-1,1);
  // Compare serialized input bytes, not tokenizer estimates or billed tokens.
  const oldPages=Math.ceil(Array.from(JSON.stringify(finding)).length/1500);
  const oldBytes=Buffer.byteLength(JSON.stringify(finding))+oldPages*Buffer.byteLength(JSON.stringify(evidence));
  assert.ok(totalBytes<oldBytes/2,`${totalBytes} vs ${oldBytes}`);
  assert.ok(pages<oldPages);
  assert.equal((await invoke('update_finding_report',saveArgs)).error,false);
  assert.deepEqual(saved()?.[3],finding.reproduction);
  assert.ok(String(saved()?.[1]).includes((finding.reproduction as any).steps[0].response));
});

test('skipped pages and changed evidence/report versions cannot bypass the save gate',async()=>{
  const {invoke,finding,sections}=fixture();
  const args={finding_id:9,evidence_version:2,report_revision:3,report_sections:sections};
  await invoke('get_finding',{finding_id:9,offset:999999});
  assert.match((await invoke('update_finding_report',args)).body.error,/尚未读完/);
  let offset:number|null=0;
  while(offset!==null)offset=(await invoke('get_finding',{finding_id:9,offset})).body.next_offset;
  finding.report_revision=4;
  assert.match((await invoke('update_finding_report',args)).body.error,/版本已变化/);
  finding.report_revision=3;finding.evidence_version=3;
  assert.match((await invoke('update_finding_report',args)).body.error,/版本已变化/);
});

test('auto conversation retains its existing get_finding response format',async()=>{
  const {invoke,finding,evidence}=fixture('auto');
  const {body,error}=await invoke('get_finding',{finding_id:9});
  assert.equal(error,false);
  assert.deepEqual(body.evidence,evidence);
  assert.equal(body.content,Array.from(JSON.stringify(finding)).slice(0,1500).join(''));
});
