import {trafficCursorSchema,trafficPagePosition,trafficPageContinuation} from './traffic-page.js';
import {domainTool} from './define.js';
import type {ToolRunContext} from './context.js';
import {authorizeEvidence} from '../evidence/authorization.js';
import {bindEvidence} from '../evidence/store.js';
export const REPORTER_TRAFFIC_TOOLS=['search_finding_traffic','bind_finding_traffic'];
export function reporterTrafficTools(ctx:ToolRunContext){
 async function finding(c:ToolRunContext,id:number){
  if(!await c.db.platform().getBool('agent_traffic_binding',false))throw new Error('Agent 自动绑定流量已关闭');
  const f=(await c.db.query('SELECT id,task_id,evidence_version FROM findings WHERE id=$1 AND ($2::bigint=0 OR task_id=$2) AND finding_readable(id)',[id,c.taskID])).rows[0];
  if(!f)throw new Error('漏洞不存在或不属于当前任务');return f;
 }
 return [domainTool<{finding_id:number;query?:string;cursor?:string}>({name:'search_finding_traffic',readOnly:true,
  description:'报告前按漏洞所属任务查找已有 HTTP 流量；query 为 URL 关键词，按 next 原样续页。核对内容后才可绑定，不发起网络请求。',
  parameters:{type:'object',properties:{finding_id:{type:'integer',minimum:1},query:{type:'string'},cursor:trafficCursorSchema},required:['finding_id']},
  async run(a,c){const f=await finding(c,a.finding_id);const scope=[Number(f.task_id),a.finding_id,a.query??''],position=trafficPagePosition(a.cursor,scope);const rows=(await c.db.query(`SELECT s.id,s.captured_at,s.task_id,s.intent_id,s.url,s.method,s.status,s.req_head,s.resp_head FROM traffic_evidence_snapshots s JOIN traffic_exchanges e ON e.id=s.id WHERE s.task_id=$1 AND ($2='' OR position(lower($2) in lower(s.url))>0) AND ($3::bigint IS NULL OR (s.captured_at,s.id)<($3::bigint,$4::text)) ORDER BY s.captured_at DESC,s.id DESC LIMIT 21`,[f.task_id,a.query??'',...position])).rows;
   const items=[];for(const row of rows.slice(0,20)){try{await authorizeEvidence(c.db,row as never,Number(f.task_id));items.push({traffic_id:row.id,request_ref:`traffic:${row.id}:request`,response_ref:`traffic:${row.id}:response`,url:row.url,method:row.method,status:row.status,request_headers:String(row.req_head).slice(0,1500),response_headers:String(row.resp_head).slice(0,1500)});}catch{/* revoked evidence */}}
   return {finding_id:a.finding_id,evidence_version:Number(f.evidence_version),items,...trafficPageContinuation(a,scope,rows,20),body_tool:'context_get',note:'仅有匹配流量才绑定；没有匹配项可以继续编写报告。'};
  }},ctx),domainTool<{finding_id:number;evidence_version:number;traffic_id:string;note?:string}>({name:'bind_finding_traffic',
  description:'将已核对的现有流量关联到漏洞；必须使用最新证据版本。绑定后重新 get_finding 再保存报告。关闭自动绑定后立即拒绝。',
  parameters:{type:'object',properties:{finding_id:{type:'integer',minimum:1},evidence_version:{type:'integer',minimum:0},traffic_id:{type:'string'},note:{type:'string'}},required:['finding_id','evidence_version','traffic_id']},
  async run(a,c){return c.db.transaction(async db=>{c={...c,db};await c.hooks.assertOwnership?.(db);await c.db.query('SELECT id FROM findings WHERE id=$1 FOR UPDATE',[a.finding_id]);const f=await finding(c,a.finding_id);
   if(Number(f.evidence_version)!==a.evidence_version)throw new Error('证据版本已变化，请重新读取');
   return bindEvidence(c.db,a.finding_id,[{traffic_id:a.traffic_id,note:a.note}],Number(f.task_id));
  });}},ctx)];
}
