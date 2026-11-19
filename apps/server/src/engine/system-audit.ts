/** Display-only audit projection. Never infer control effects from model text. */
export const AUDIT_TYPES = ['correction','control','important_fact','system'] as const;
export type AuditType = typeof AUDIT_TYPES[number];
export interface AuditEvent {
  type: AuditType; source: string; status: string; title: string;
  intent_id?: string; fact_id?: string; source_session?: string; reason?: string;
}
const stopReasons=['planner_terminated','main_terminated','user_cancelled','intent_paused','task_paused','task_ended','task_completed','service_shutdown','executor_stopped'];
const excludedEvents=['finding_published','source_finding','finding','major_finding'];
const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const str=(v:unknown)=>typeof v==='string'?v:'';
const id=(v:unknown)=>/^[1-9][0-9]*$/.test(String(v??''))?String(v):undefined;
export function systemAuditEvent(row:Record<string,unknown>):AuditEvent|undefined {
  const m=obj(row.metadata),steering=obj(m.steering),stop=obj(m.execution_stop),fact=obj(m.important_fact);
  const kind=str(row.kind),event=str(m.event_type),worker=str(row.worker),tool=str(row.tool);
  if(['tool_use','tool_result','usage','finding'].includes(kind)||tool==='report_finding'||excludedEvents.includes(event))return;
  const intent=id(row.node_id??row.intent_id);
  const source=str(steering.source)||str(m.source)||({planner_terminated:'planner',main_terminated:'mainagent',user_cancelled:'user',intent_paused:'user'} as Record<string,string>)[str(stop.reason)]||'';
  const sourceSession=worker==='planner'||worker==='goals'?'plan':worker==='main'||worker==='mainagent'?`main:${Number(row.main_seg)||0}`:intent&&worker!=='system'?`intent:${intent}`:undefined;
  if(event==='steering'&&['user','status'].includes(kind))return {type:'correction',source,status:str(steering.status)||'unknown',title:'Worker 纠偏',intent_id:id(steering.intent_id)??intent,source_session:sourceSession};
  if(event==='important_fact'&&id(fact.fact_id))return {type:'important_fact',source:str(m.source),status:'saved',title:'重要事实',fact_id:id(fact.fact_id),intent_id:id(fact.intent_id),reason:str(fact.reason)};
  if((['lifecycle','outcome'].includes(event)&&stopReasons.includes(str(stop.reason)))||
    (event==='lifecycle'&&['resume_requested','resume_started'].includes(str(m.status)))) {
    const reason=str(stop.reason),status=str(m.status)||'unknown';
    return {type:'control',source,status,title:status.startsWith('resume_')?'恢复 Worker':reason==='intent_paused'||reason==='task_paused'?'暂停 Worker':'停止 Worker',intent_id:intent,source_session:sourceSession,reason:str(stop.summary)};
  }
  if(worker==='system'||['llm_switch','llm_failover'].includes(kind))return {type:'system',source:source||'system',status:str(m.status)||'recorded',title:kind==='llm_switch'?'模型切换':kind==='llm_failover'?'模型故障转移':'系统事件',intent_id:intent};
}
// The candidate matches the partial index; the CASE matches the DTO classifier.
export const AUDIT_CANDIDATE_SQL = `(worker='system' OR kind IN ('llm_switch','llm_failover') OR metadata->>'event_type' IN ('steering','important_fact','lifecycle','outcome'))`;
const quoted=(values:readonly string[])=>values.map(v=>`'${v}'`).join(',');
export const AUDIT_TYPE_SQL=`CASE
 WHEN COALESCE(kind,'') IN ('tool_use','tool_result','usage','finding') OR COALESCE(tool,'')='report_finding' OR COALESCE(metadata->>'event_type','') IN (${quoted(excludedEvents)}) THEN NULL
 WHEN metadata->>'event_type'='steering' AND kind IN ('user','status') THEN 'correction'
 WHEN metadata->>'event_type'='important_fact' AND metadata#>>'{important_fact,fact_id}' ~ '^[1-9][0-9]*$' THEN 'important_fact'
 WHEN (metadata->>'event_type' IN ('lifecycle','outcome') AND metadata#>>'{execution_stop,reason}' IN (${quoted(stopReasons)}))
   OR (metadata->>'event_type'='lifecycle' AND metadata->>'status' IN ('resume_requested','resume_started')) THEN 'control'
 WHEN worker='system' OR kind IN ('llm_switch','llm_failover') THEN 'system' END`;
export function systemAuditWhere(type:string|undefined,params:unknown[]) {
  if(type&&type!=='all'&&!AUDIT_TYPES.includes(type as AuditType))throw Object.assign(new Error('无效系统事件分类'),{statusCode:400});
  if(!type||type==='all')return ` AND ${AUDIT_CANDIDATE_SQL} AND (${AUDIT_TYPE_SQL}) IS NOT NULL`;
  params.push(type);return ` AND ${AUDIT_CANDIDATE_SQL} AND (${AUDIT_TYPE_SQL})=$${params.length}`;
}
