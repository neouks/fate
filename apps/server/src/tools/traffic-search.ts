import {validateToolArguments} from '@earendil-works/pi-ai';
import {domainTool} from './define.js';
import type {ToolRunContext} from './context.js';
import {authorizeEvidence} from '../evidence/authorization.js';
export const trafficSearchSchema={type:'object',additionalProperties:false,properties:{query:{type:'string',description:'URL 子串，省略时查本任务全部已保存流量'},limit:{type:'integer',minimum:1,maximum:20,description:'默认 10，最多 20 条'}}};
export function trafficSearchTool(ctx:ToolRunContext){return domainTool<{query?:string;limit?:number}>({
 name:'traffic_search',readOnly:true,description:'按 URL 关键词检索当前任务已保存的 HTTP 流量；返回证据引用，正文用 context_get 读取。不发起网络请求。',
 parameters:trafficSearchSchema,
 async run(a,c){
  a=validateToolArguments({name:'traffic_search',description:'',parameters:trafficSearchSchema},{type:'toolCall',id:c.toolCallID??'validate',name:'traffic_search',arguments:{...a}}) as typeof a;
  if(!c.taskID)throw new Error('必须先绑定任务才能检索流量');
  const rows=(await c.db.query(`SELECT s.id,s.task_id,s.intent_id,s.url,s.method,s.status FROM traffic_evidence_snapshots s JOIN traffic_exchanges e ON e.id=s.id WHERE s.task_id=$1 AND ($2='' OR position(lower($2) in lower(s.url))>0) ORDER BY s.captured_at DESC LIMIT $3`,[c.taskID,a.query??'',a.limit??10])).rows;
  const items=[];for(const row of rows){try{await authorizeEvidence(c.db,row as never,c.taskID);items.push({traffic_id:row.id,url:row.url,method:row.method,status:row.status,request_ref:`traffic:${row.id}:request`,response_ref:`traffic:${row.id}:response`});}catch{/* revoked evidence */}}
  return {items};
 }
},ctx);}
