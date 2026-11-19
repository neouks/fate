import {resolveGraphNode} from '../db/graph_view.js';
import {loadToolOutput} from './tool-outputs.js';
import {randomUUID} from 'node:crypto';
import type {Database} from '../db/index.js';
import {readBlob} from './blobs.js';
import {authorizeEvidence} from './authorization.js';
import {bindEvidence} from './store.js';
import {DISCOVERY_LABELS,type ReportSections} from './report-sections.js';
export interface ReproStep {id:string;action:string;request:string;response:string;expected:string;proves:string;traffic_id?:string;source?:'evidence';source_ref?:string;verified?:boolean;truncated?:boolean;packet_note?:string;}
export interface Reproduction {entry_point:string;prerequisites:string[];steps:ReproStep[];provenance:string;}
const invalid=(m:string)=>Object.assign(new Error(m),{statusCode:400});
const text=(v:unknown)=>typeof v==='string'?v:'';
export function normalizeReproduction(value:unknown):Reproduction|null{
 if(value==null)return null;
 if(typeof value!=='object'||Array.isArray(value))throw invalid('reproduction 必须为对象');
 const v=value as Record<string,unknown>;
 if(!Array.isArray(v.steps)||v.steps.length>100)throw invalid('steps 必须为不超过 100 项的数组');
 const seen=new Set<string>();
 const steps=v.steps.map((raw:unknown)=>{
  if(!raw||typeof raw!=='object')throw invalid('无效复现步骤');
  const r=raw as Record<string,unknown>,id=text(r.id)||randomUUID();
  if(!/^[\w-]{1,80}$/.test(id)||seen.has(id))throw invalid('步骤 ID 无效或重复');seen.add(id);
  const step:ReproStep={id,action:text(r.action),request:text(r.request),response:text(r.response),expected:text(r.expected),proves:text(r.proves)};
  if(!step.action.trim()&&!step.request.trim())throw invalid('步骤需要操作说明或真实请求');
  if(r.traffic_id)step.traffic_id=text(r.traffic_id);
  if(r.source==='evidence')step.source='evidence';
  if(r.source_ref)step.source_ref=text(r.source_ref);
  if(r.truncated===true)step.truncated=true;
  if(Buffer.byteLength(JSON.stringify(step))>256*1024)throw invalid('步骤过大，请引用完整证据并提交关键片段');
  return step;
 });
 if(v.prerequisites!==undefined&&(!Array.isArray(v.prerequisites)||v.prerequisites.some(x=>typeof x!=='string')))throw invalid('prerequisites 必须为字符串数组');
 return {entry_point:text(v.entry_point),prerequisites:(v.prerequisites??[]) as string[],steps,provenance:text(v.provenance)};
}
export const reproductionSchema={type:'object',properties:{entry_point:{type:'string'},prerequisites:{type:'array',items:{type:'string'}},provenance:{type:'string'},steps:{type:'array',maxItems:100,items:{type:'object',properties:{id:{type:'string'},action:{type:'string',description:'自然语言说明做了什么'},request:{type:'string',description:'HTTP 请求原文：完整请求行、全部 Header、空行和完整 Body；优先填真实 traffic_id 由平台展开。非 HTTP 操作保留真实命令，不编造报文'},response:{type:'string',description:'HTTP 响应原文：完整状态行、全部 Header、空行和完整 Body；不只写 JSON 或关键片段。证据缺失留空并说明；非 HTTP 操作保留真实输出'},expected:{type:'string'},proves:{type:'string',description:'真实结果证明了什么'},traffic_id:{type:'string',description:'当前任务真实流量 ID；平台展开已保存的 Header 和 Body，无需模型重复抄写'},source:{type:'string',enum:['evidence']},source_ref:{type:'string',description:'node:<id>、activity:<id> 或 tool-output:<uuid>，摘录必须逐字匹配来源'},truncated:{type:'boolean'}},required:['action','request','response','proves']}}},required:['steps']};
function target(request:string,entry:string){
 const url=request.match(/https?:\/\/[^\s'"<>]+/)?.[0]??entry.match(/https?:\/\/[^\s'"<>]+/)?.[0];
 if(!url)return;
 try{const u=new URL(url),m=request.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/m);if(m) return {url:new URL(m[2]!,u).href,method:m[1]!};return {url:u.href,method:request.match(/(?:-X|--request)\s+([A-Z]+)/)?.[1]??(/(?:--data|-d |--form|-F )/.test(request)?'POST':'GET')};}catch{return;}
}
/** Raw excerpts are never reconstructed by the report model. Auto-match only exact, unique evidence. */
export async function prepareReproduction(db:Database,value:unknown,owner:{taskID:number;intentID?:number;evidence:string;since?:Date;findingNodeID?:number},strict=false){
 const repro=normalizeReproduction(value);if(!repro)return null;
 const intentID=owner.intentID??(owner.findingNodeID?Number((await db.query("SELECT payload->>'from_intent' AS intent FROM exploration_nodes WHERE id=$1",[owner.findingNodeID])).rows[0]?.intent)||undefined:undefined);
 const start=owner.since??(intentID?new Date(String((await db.query('SELECT created_at FROM exploration_nodes WHERE id=$1',[intentID])).rows[0]?.created_at)):undefined);
 for(const st of repro.steps){
  if(!st.traffic_id&&(st.source==='evidence'||st.source_ref)){
   const original=await stepSource(db,owner,st);
   if((st.request&&!original.includes(st.request))||(st.response&&!original.includes(st.response)))throw invalid('步骤摘录不是原始证据内容');st.verified=true;if(!st.traffic_id)continue;
  }
  let candidates:Record<string,unknown>[]=[];
  if(st.traffic_id)candidates=(await db.query('SELECT * FROM traffic_evidence_snapshots WHERE id=$1 AND task_id=$2',[st.traffic_id,owner.taskID])).rows;
  else{
   const t=target(st.request,repro.entry_point);
   if(t&&intentID&&start&&Number.isFinite(start.getTime())&&st.request&&st.response)candidates=(await db.query(`SELECT * FROM traffic_evidence_snapshots WHERE task_id=$1 AND url=$2 AND method=$3 AND ($4::bigint IS NULL OR intent_id=$4) AND captured_at >= $5 AND captured_at <= $6 ORDER BY captured_at LIMIT 201`,[owner.taskID,t.url,t.method,intentID??null,start?.getTime()??0,Date.now()])).rows;
   if(candidates.length>200)candidates=[]; // Too ambiguous; never silently pick the newest packet.
  }
  const matches:Record<string,unknown>[]=[];
  for(const snap of candidates){
   await authorizeEvidence(db,snap as never,owner.taskID);
   if(st.traffic_id&&!st.request&&!st.response){matches.push(snap);continue;}
   const request=packet(snap.req_head,await readBlob(db,String(snap.req_hash)));
   const response=packet(snap.resp_head,await readBlob(db,String(snap.resp_hash)));
   if((!st.request||request.includes(st.request))&&(!st.response||response.includes(st.response)))matches.push(snap);
  }
  if(st.traffic_id&&matches.length!==1)throw invalid('流量引用不存在、跨任务或摘录不匹配');
  if(matches.length===1){st.traffic_id=String(matches[0]!.id);st.verified=true;}
  else if(strict&&(st.request||st.response))throw invalid('新增步骤必须引用原始 evidence 或唯一真实流量；不能补造报文');
 }
 return expandTrafficPackets(db,repro,owner.taskID);
}

const INLINE_PACKET_BYTES=256*1024;
const packet=(head:unknown,body:Buffer)=>String(head??'').replace(/(?:\r?\n)+$/,'')+'\r\n\r\n'+body.toString('utf8');
/** Expand only verified persisted traffic; the model never reconstructs headers. */
export async function expandTrafficPackets(db:Database,repro:Reproduction|null,taskID:number){
 if(!repro)return repro;
 for(const step of repro.steps){
  delete step.packet_note;
  if(!step.traffic_id)continue;
  const snap=(await db.query(`SELECT s.*,e.truncated AS capture_truncated FROM traffic_evidence_snapshots s
   LEFT JOIN traffic_exchanges e ON e.id=s.id WHERE s.id=$1 AND s.task_id=$2`,[step.traffic_id,taskID])).rows[0];
  if(!snap)throw invalid('流量引用不存在或不属于当前任务');
  await authorizeEvidence(db,snap as never,taskID);
  if(Number(snap.req_len)+Number(snap.resp_len)+Buffer.byteLength(String(snap.req_head)+String(snap.resp_head))>INLINE_PACKET_BYTES){
   step.request=packet(snap.req_head,Buffer.alloc(0));step.response=packet(snap.resp_head,Buffer.alloc(0));
   step.truncated=true;step.packet_note='报文超过内联展示上限，请通过流量证据读取或下载全部 Header 与 Body；此处不是完整报文。';continue;
  }
  const req=await readBlob(db,String(snap.req_hash)),resp=await readBlob(db,String(snap.resp_hash));
  try{for(const bytes of [req,resp]){new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(bytes.includes(0))throw new Error('binary');}}
  catch{step.request=packet(snap.req_head,Buffer.alloc(0));step.response=packet(snap.resp_head,Buffer.alloc(0));step.truncated=true;step.packet_note='Body 含二进制内容，请通过流量证据下载原始数据；不以文本改写。';continue;}
  const request=packet(snap.req_head,req),response=packet(snap.resp_head,resp);
  if((step.request&&!request.includes(step.request))||(step.response&&!response.includes(step.response)))throw invalid('步骤摘录不是关联流量的原始内容');
  if(Buffer.byteLength(JSON.stringify({...step,request,response}))>INLINE_PACKET_BYTES){
   step.request=packet(snap.req_head,Buffer.alloc(0));step.response=packet(snap.resp_head,Buffer.alloc(0));
   step.truncated=true;step.packet_note='报文超过内联展示上限，Header 完整保留，Body 请从关联流量证据下载。';continue;
  }
  // Expanded packets are now backed by the traffic snapshot, not a shorter source excerpt.
  step.request=request;step.response=response;step.verified=true;delete step.source;delete step.source_ref;
  step.truncated=snap.capture_truncated===true;
  if(step.truncated)step.packet_note='原始流量采集已截断，以下为全部已保存内容，缺失部分无法补造。';
  else if(snap.capture_truncated==null)step.packet_note='以下为全部已保存报文；历史采集完整性未记录。';
 }
 return repro;
}

export async function stepSource(db:Database,owner:{taskID:number;intentID?:number;evidence:string},step:ReproStep):Promise<string>{
 if(!step.source_ref)return owner.evidence;
 const task=await db.tasks().getTask(owner.taskID);if(!task)throw invalid('证据任务不存在');
 const ref=step.source_ref;
 if(/^node:[1-9]\d*$/.test(ref)){
  const {node}=await resolveGraphNode(db,owner.taskID,task.exploration_id,Number(ref.slice(5)));
  if(!['fact','finding'].includes(node.kind))throw invalid('节点不是事实或漏洞证据');
  if(node.kind==='finding'){const f=(await db.query('SELECT evidence FROM findings WHERE node_id=$1 AND finding_readable(id)',[node.id])).rows[0];if(f)return String(f.evidence);}
  return ['evidence','detail'].map(k=>typeof node.payload[k]==='string'?node.payload[k]:'').join('\n');
 }
 if(/^activity:[1-9]\d*$/.test(ref)){
  const row=(await db.query('SELECT node_id,detail FROM activity WHERE id=$1 AND exploration_id=$2',[Number(ref.slice(9)),task.exploration_id])).rows[0];
  if(!row||owner.intentID&&Number(row.node_id)!==owner.intentID)throw invalid('活动证据不属于当前执行范围');
  if(row.node_id)await resolveGraphNode(db,owner.taskID,task.exploration_id,Number(row.node_id));return String(row.detail??'');
 }
 if(/^tool-output:[a-f0-9-]+$/i.test(ref))return loadToolOutput(db,ref.slice(12),{taskID:owner.taskID,agent:!!owner.intentID,intentID:owner.intentID});
 throw invalid('无效的原始证据引用');
}
export async function attachStepTraffic(db:Database,findingID:number,taskID:number,repro:Reproduction|null,options:{bumpVersion?:boolean}={}){
 const ids=[...new Set(repro?.steps.flatMap(s=>s.traffic_id?[s.traffic_id]:[])??[])];
 if(ids.length)await bindEvidence(db,findingID,ids.map(traffic_id=>({traffic_id,role:'proof'})),taskID,options);
}
export async function archiveReport(db:Database,f:Record<string,unknown>){
 await db.query(`INSERT INTO finding_report_versions(finding_id,revision,evidence_version,report,sections,reproduction) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[f.id,f.report_revision, f.report_evidence_version??f.evidence_version,f.report??'',f.report_sections??null,f.reproduction??null]);
}
const fence=(v:string)=>{const marks='`'.repeat(Math.max(3,...(v.match(/`+/g)??[]).map(s=>s.length+1)));return `${marks}\n${v}\n${marks}`;};
/** One deterministic assembler for the UI's report text and every export. */
export function assembleReport(f:Record<string,unknown>,images:Array<{id:string;step_id?:string|null;caption:string;mime:string}>=[],imageURL=(id:string)=>`/api/exploration/findings/${f.id}/images/${id}`){
 const r=f.reproduction as Reproduction|null,sections=f.report_sections as ReportSections|null;
 const out=[`# ${f.name||f.vulnclass||'漏洞报告'}`,'',`## 漏洞说明`,sections?.description||String(f.summary??''),''];
 if(Number(f.report_evidence_version)!==Number(f.evidence_version))out.push('> 报告依据已变化，请核对当前证据。','');
 for(const key of ['vulnerability','asset'] as const){
  const value=sections?.discovery?.[key];
  if(value?.trim())out.push(`## ${DISCOVERY_LABELS[key]}`,value,'');
 }
 if(r){out.push('## 复现步骤',`入口：${r.entry_point||'未记录'}`,'',...r.prerequisites.map(p=>`- ${p}`),'');
 for(const [i,s]of r.steps.entries()){
  out.push(`${i+1}. ${s.action||'验证'}`,'',...[s.expected,s.proves].filter(Boolean),'');
  if(!s.verified)out.push('> Worker 提交的过程；尚未关联可核对的原始证据。','');
  if(!s.packet_note?.startsWith('原始证据未包含完整 HTTP 请求与响应')&&(s.packet_note||s.truncated))out.push('> '+(s.packet_note||'以下为证据片段，完整内容请读取证据来源。'),'');
  if(s.request)out.push('请求 / 命令：',fence(s.request),'');else out.push('缺少原始请求 / 命令。','');
  if(s.response)out.push('响应 / 输出：',fence(s.response),'');else out.push('缺少原始响应 / 输出。','');
  if(s.traffic_id)out.push(`[流量证据 ${s.traffic_id}](/function/findings/detail?id=${encodeURIComponent(String(f.id))})`,'');
  for(const img of images.filter(im=>im.step_id===s.id))out.push(`![${img.caption.replace(/[\[\]\n]/g,' ')}](${imageURL(img.id)})`,'');
 }
 if(!sections?.discovery&&r.provenance)out.push('## 发现来源',r.provenance,'');
 }else out.push('## 复现步骤','尚未整理复现过程，以下原始证据完整保留。','');
 const extra=images.filter(im=>!im.step_id||!r?.steps.some(s=>s.id===im.step_id));if(extra.length)out.push('## 补充证据',...extra.flatMap(img=>[`![${img.caption.replace(/[\[\]\n]/g,' ')}](${imageURL(img.id)})`,'']));
 if(sections?.impact.length)out.push('## 具体影响',...sections.impact.map(s=>`- ${s}`),'');
 if(sections?.remediation.length)out.push('## 修复建议',...sections.remediation.map(s=>`- ${s}`),'');
 if(!sections&&f.report)out.push('## 历史报告',String(f.report),'');
 out.push('## 原始证据 / PoC',fence(String(f.evidence??'')),'');return out.join('\n');
}
