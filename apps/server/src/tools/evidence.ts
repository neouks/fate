import {domainTool} from './define.js';
import type {ToolRunContext} from './context.js';
import {evidenceRequest} from '../evidence/http.js';
import {evidenceBody} from '../evidence/store.js';
export function httpRequestTool(ctx:ToolRunContext){return domainTool<{url:string;method?:string;headers?:Record<string,string>;body?:string}>({
 transactional:false, name:'http_request',description:'执行任务范围内 HTTP 请求并持久保存请求/响应证据，返回 traffic_id 可用于 report_finding；8 MiB 正文上限，超限明确标记。',
 parameters:{type:'object',properties:{url:{type:'string'},method:{type:'string'},headers:{type:'object',additionalProperties:{type:'string'}},body:{type:'string'}},required:['url']},
 run:async(args,c)=>evidenceRequest(c,args,c.signal?AbortSignal.any([c.signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000)),
},ctx);}
export function trafficBodyTool(ctx:ToolRunContext){return domainTool<{traffic_id:string;side?:string;offset?:number}>({
 name:'traffic_body',description:'分页读取本任务 HTTP 证据正文；offset 以字节计。',readOnly:true,
 parameters:{type:'object',properties:{traffic_id:{type:'string'},side:{type:'string',enum:['request','response']},offset:{type:'integer',minimum:0}},required:['traffic_id']},
 async run(args,c){const r=await c.db.query('SELECT id FROM traffic_exchanges WHERE id=$1 AND task_id=$2',[args.traffic_id,c.taskID]);if(!r.rowCount)throw new Error('流量不属于本任务或已删除');return evidenceBody(c.db,args.traffic_id,args.side??'response',args.offset);}
},ctx);}
export function readAttachmentTool(ctx:ToolRunContext){return domainTool<{path:string;offset?:number}>({
 name:'read_attachment',description:'按字符分页读取本任务附件正文。只允许平台登记的附件引用，不能访问任意本地路径。',readOnly:true,
 parameters:{type:'object',properties:{path:{type:'string'},offset:{type:'integer',minimum:0}},required:['path']},
 async run(args,c){const r=await c.db.query('SELECT b.bytes FROM chat_artifacts a JOIN evidence_blobs b ON b.hash=a.sha256 WHERE a.path=$1 AND a.task_id=$2',[args.path,c.taskID]);if(!r.rowCount)throw new Error('附件不存在或不属于本任务');const bytes=r.rows[0]!.bytes as Buffer;if(bytes.includes(0))throw new Error('二进制附件需要由相应解析器处理');const text=bytes.toString('utf8'),offset=Math.max(0,args.offset??0);return {content:text.slice(offset,offset+12000),total:text.length,next_offset:offset+12000<text.length?offset+12000:null};}
},ctx);}
