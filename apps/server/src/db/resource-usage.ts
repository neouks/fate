import type {Database} from './index.js';
import type {Activity} from './exploration.js';
import type {NativeActivityReference} from '../pi/native-activity.js';
import type {ResourceCall} from '../pi/resource-usage.js';
/** Same transaction as activity receipts. Recovery never executes tools. */
export async function projectResourceUsage(db:Database,a:Activity,native:NativeActivityReference){
 if(!native.call_key||!a.tool_use_id||!['tool_use','tool_result'].includes(a.kind??''))return;
 if(!/^[a-f0-9]{64}$/.test(native.call_key))throw new Error('Invalid resource call identity');
 if(a.kind==='tool_use'){
  const r=a.metadata?.resource_call as ResourceCall|undefined;if(!r)return;
  if(!['skill','mcp'].includes(r.kind)||typeof r.name!=='string'||!r.name||typeof r.operation!=='string'||!r.operation)throw new Error('Invalid resource usage descriptor');
  await db.query(`INSERT INTO resource_usage(runtime_id,call_key,kind,resource_name,server_id,operation,tool_call_id,agent_key,
    task_id,exploration_id,conversation_id,intent_id,session_id,turn_id,started_at)
    SELECT r.id,$2,$3,$4,$5,$6,$7,r.role,r.task_id,
      CASE WHEN n.identity->'source'->>'scope'='task' THEN (n.identity->'source'->>'scopeID')::bigint END,
      r.conversation_id,(r.effective->'usage_scope'->>'intentID')::bigint,n.session_id,n.identity->>'turn_id',COALESCE($8::timestamptz,now())
    FROM runtime_role_configs r JOIN native_activity_runs n ON n.runtime_id=r.id WHERE r.id=$1
    ON CONFLICT(runtime_id,call_key) DO NOTHING`,[native.runtime_id,native.call_key,r.kind,r.name,r.kind==='mcp'?r.server_id??null:null,r.operation,a.tool_use_id,a.created_at??null]);
  await db.query(`UPDATE resource_usage u SET outcome=r.outcome,finished_at=r.finished_at FROM resource_usage_results r WHERE u.runtime_id=$1 AND u.call_key=$2 AND u.runtime_id=r.runtime_id AND u.call_key=r.call_key AND u.tool_call_id=r.tool_call_id AND u.outcome='pending'`,[native.runtime_id,native.call_key]);
 }else{
  if(a.tool!=='read'&&!a.tool?.startsWith('mcp__'))return;
  await db.query(`INSERT INTO resource_usage_results(runtime_id,call_key,tool_call_id,outcome,finished_at) VALUES($1,$2,$3,$4,COALESCE($5::timestamptz,now())) ON CONFLICT DO NOTHING`,[native.runtime_id,native.call_key,a.tool_use_id,a.is_error?'failed':'succeeded',a.created_at??null]);
  await db.query(`UPDATE resource_usage SET outcome=$3,finished_at=COALESCE($4::timestamptz,now())
    WHERE runtime_id=$1 AND call_key=$2 AND tool_call_id=$5 AND outcome='pending'`,
   [native.runtime_id,native.call_key,a.is_error?'failed':'succeeded',a.created_at??null,a.tool_use_id]);
 }
}
// A bound conversation has one row with both dimensions. Never add task and
// conversation totals. Legacy rows are retained explicitly as unverified.
export const resourceUsageRows=`SELECT kind,resource_name,server_id,operation,agent_key,task_id,conversation_id,intent_id,session_id,turn_id,
 started_at AS ts, CASE WHEN u.outcome='pending' AND NOT EXISTS(SELECT 1 FROM runtime_role_configs r WHERE r.id=u.runtime_id AND r.finished_at IS NULL AND r.expires_at>clock_timestamp()) THEN 'unknown' ELSE u.outcome END AS outcome,
 'native-v1'::text AS source,u.runtime_id||':'||u.call_key AS call_id
 FROM resource_usage u
 UNION ALL SELECT 'skill',skill,NULL,'read',agent_key,task_id,NULL,intent_id,session_id,NULL,ts,'unknown','legacy','skill:'||id FROM skill_usage
 UNION ALL SELECT 'mcp',server_name,server_id,tool_name,agent_key,task_id,NULL,intent_id,session_id,NULL,ts,'unknown','legacy','mcp:'||id FROM mcp_usage`;
export const resourceUsageAggregate=`count(*)::int AS calls,count(DISTINCT task_id)::int AS tasks,count(DISTINCT conversation_id)::int AS conversations,
 count(*) FILTER(WHERE outcome='succeeded')::int AS succeeded,count(*) FILTER(WHERE outcome='failed')::int AS failed,
 count(*) FILTER(WHERE outcome='pending')::int AS pending,count(*) FILTER(WHERE outcome='unknown')::int AS unknown,
 COALESCE(array_agg(DISTINCT agent_key) FILTER(WHERE agent_key IS NOT NULL AND agent_key<>''),'{}') AS usage_agents,max(ts) AS last_used`;
export const emptyResourceUsage={calls:0,tasks:0,conversations:0,succeeded:0,failed:0,pending:0,unknown:0,usage_agents:[],last_used:null};
export async function resourceUsageList(db:Database,kind:'skill'|'mcp'){
 const rows=await db.query(`SELECT ${kind==='skill'?'resource_name':'server_id'},${resourceUsageAggregate} FROM (${resourceUsageRows}) u WHERE kind=$1 GROUP BY ${kind==='skill'?'resource_name':'server_id'}`,[kind]);
 return new Map(rows.rows.map(r=>[String(kind==='skill'?r.resource_name:r.server_id),r]));
}
export async function resourceUsageDetail(db:Database,kind:'skill'|'mcp',key:string|number,limit:number){
 const where=kind==='skill'?'resource_name=$2':'server_id=$2';
 const [stats,calls,policy]=await Promise.all([
  db.query(`SELECT server_id,resource_name AS server_name,operation AS tool_name,${resourceUsageAggregate} FROM (${resourceUsageRows}) u WHERE kind=$1 AND ${where} GROUP BY server_id,resource_name,operation ORDER BY calls DESC`,[kind,key]),
  db.query(`SELECT *,COALESCE(task_id,0) AS task_id,COALESCE(session_id,'') AS session_id,operation AS tool_name,NULL AS args_len FROM (${resourceUsageRows}) u WHERE kind=$1 AND ${where} ORDER BY ts DESC,call_id DESC LIMIT $3`,[kind,key,limit]),
  db.query('SELECT enabled_at FROM resource_usage_policy WHERE singleton'),
 ]);
 return {stats:stats.rows.map(r=>({...r,server_id:r.server_id==null?null:Number(r.server_id),agents:r.usage_agents})),calls:calls.rows.map(r=>({...r,task_id:Number(r.task_id),server_id:r.server_id==null?null:Number(r.server_id),conversation_id:r.conversation_id==null?null:Number(r.conversation_id),intent_id:r.intent_id==null?null:Number(r.intent_id)})),metering:{version:'native-v1',enabled_at:policy.rows[0]?.enabled_at??null,historical_complete:false,definition:kind==='skill'?'原生 read 读取 SKILL.md 的尝试；不含索引加载、辅助文件及 bash 读取':'原生 MCP 工具调用尝试；不含工具搜索、连接测试及资源枚举'}};
}
