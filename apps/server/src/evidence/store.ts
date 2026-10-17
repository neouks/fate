import {createHash,randomUUID} from 'node:crypto';
import type {Database} from '../db/index.js';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
export interface ExchangeInput {taskID:number;intentID?:number;url:string;method:string;status:number;reqHead:string;respHead:string;request:Buffer;response:Buffer;contentType?:string;truncated?:boolean;}
export async function recordExchange(db:Database,input:ExchangeInput){
 const id=randomUUID(),reqHash=hash(input.request),respHash=hash(input.response),url=new URL(input.url);
 await db.transaction(async tx=>{
  for(const [key,bytes] of [[reqHash,input.request],[respHash,input.response]] as const)await tx.query('INSERT INTO evidence_blobs(hash,bytes) VALUES($1,$2) ON CONFLICT DO NOTHING',[key,bytes]);
  await tx.query(`INSERT INTO traffic_evidence_snapshots(id,source_traffic_id,captured_at,url,method,status,content_type,req_head,resp_head,req_hash,resp_hash,req_len,resp_len) VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[id,Date.now(),input.url,input.method,input.status,input.contentType??'',input.reqHead,input.respHead,reqHash,respHash,input.request.length,input.response.length]);
  await tx.query(`INSERT INTO traffic_exchanges(id,task_id,intent_id,host,truncated) VALUES($1,$2,$3,$4,$5)`,[id,input.taskID,input.intentID??null,url.hostname,input.truncated===true]);
 });return id;
}
export async function evidenceBody(db:Database,snapshotID:string,side:string,offset=0){
 const column=side==='request'?'req_hash':'resp_hash';
 const r=await db.query(`SELECT b.bytes FROM traffic_evidence_snapshots s JOIN evidence_blobs b ON b.hash=s.${column} WHERE s.id=$1`,[snapshotID]);
 if(!r.rows.length)throw Object.assign(new Error('证据正文不存在'),{statusCode:404});
 const bytes=r.rows[0]!.bytes as Buffer,start=Math.max(0,Math.floor(offset)),end=Math.min(bytes.length,start+32_768);
 const binary=bytes.includes(0);
 return {content:bytes.subarray(start,end).toString(binary?'base64':'utf8'),offset:start,total:bytes.length,next_offset:end,truncated:end<bytes.length,binary};
}
export async function findingEvidence(db:Database,findingID:number){
 const f=(await db.query('SELECT evidence_version,report_evidence_version FROM findings WHERE id=$1',[findingID])).rows[0];
 if(!f)throw Object.assign(new Error('finding not found'),{statusCode:404});
 const rows=await db.query('SELECT b.*,row_to_json(s) AS snapshot FROM finding_traffic_bindings b JOIN traffic_evidence_snapshots s ON s.id=b.snapshot_id WHERE b.finding_id=$1 ORDER BY position,id',[findingID]);
 return {finding_id:String(findingID),version:Number(f.evidence_version),report_version:Number(f.report_evidence_version),bindings:rows.rows};
}
export async function bindEvidence(db:Database,findingID:number,refs:Array<{traffic_id:string;role?:string;note?:string}>,taskID:number){
 await db.query('SELECT id FROM findings WHERE id=$1 FOR UPDATE',[findingID]);
 for(const ref of refs){
  if(!['baseline','proof','verification','supporting'].includes(ref.role??'supporting'))throw Object.assign(new Error('无效证据角色'),{statusCode:400});
  const permitted=await db.query(`SELECT id FROM traffic_exchanges WHERE id=$1 AND task_id=$2`,[ref.traffic_id,taskID]);
  if(!permitted.rowCount)throw Object.assign(new Error('流量不存在或不属于漏洞任务'),{statusCode:404});
  await db.query(`INSERT INTO finding_traffic_bindings(finding_id,snapshot_id,role,note,position) VALUES($1,$2,$3,$4,COALESCE((SELECT max(position)+1 FROM finding_traffic_bindings WHERE finding_id=$1),0)) ON CONFLICT(finding_id,snapshot_id) DO NOTHING`,[findingID,ref.traffic_id,ref.role??'supporting',ref.note??'']);
 }
 await db.query('UPDATE findings SET evidence_version=evidence_version+1 WHERE id=$1',[findingID]);
 return findingEvidence(db,findingID);
}
