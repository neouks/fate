import type {Database} from './index.js';

export type UsageScope={taskID?:number;conversationID?:number;intentID?:number;mainSegment?:number;runtimeID?:string;turnID?:string};
export const USAGE_VERSION='usage-v2';

/** One-way import. No business record is rewritten; reruns and deleted logs cannot remove receipts. */
export async function backfillUsageLedger(db:Database){
 await db.query(`INSERT INTO llm_usage_ledger(request_id,audit_id,task_id,conversation_id,intent_id,main_seg,runtime_id,turn_id,scope_key,role,purpose,profile_id,model,status,usage,quality,source,created_at,finished_at)
 SELECT COALESCE(a.request_id,'audit:'||a.id),a.id,a.task_id,a.conversation_id,(s.metadata->>'node_id')::bigint,s.main_seg,a.runtime_id,s.metadata->>'turn_id',COALESCE(a.runtime_id,s.metadata->>'turn_id','audit:'||a.id),a.role,a.purpose,a.profile_id,a.model,a.status,a.usage,
 CASE WHEN a.status='running' OR COALESCE((a.usage->>'unavailable')::boolean,false) THEN 'unknown'
 WHEN a.usage ?& ARRAY['input','output','cacheRead','cacheWrite'] AND COALESCE((a.usage->>'totalTokens')::numeric,0)>0 THEN 'complete'
 WHEN a.usage ?| ARRAY['input','output','cacheRead','cacheWrite'] THEN 'partial' ELSE 'unknown' END,'request_audit',a.created_at,a.finished_at
 FROM llm_request_attempts a LEFT JOIN LATERAL (
  SELECT x.metadata||jsonb_build_object('node_id',x.node_id) metadata,x.main_seg FROM activity x
   WHERE x.metadata->>'runtime_id'=a.runtime_id AND x.metadata->>'event_type'='turn_start' LIMIT 1
 ) s ON true ON CONFLICT(request_id) DO NOTHING`);
 for(const conversation of [false,true]){
  const table=conversation?'conversation_activities':'activity';
  await db.query(`INSERT INTO llm_usage_ledger(request_id,task_id,conversation_id,intent_id,main_seg,runtime_id,turn_id,scope_key,role,model,status,usage,quality,input_semantics,source,created_at,finished_at)
   SELECT CASE WHEN a.kind='result' THEN 'legacy:' ELSE 'native:' END||'${conversation?'conversation':'task'}:'||${conversation?'a.conversation_id':'COALESCE(t.id,a.exploration_id)'}||':'||CASE WHEN a.kind='result' THEN a.id::text ELSE a.metadata->>'stream_id' END,
    t.id,${conversation?'a.conversation_id':'NULL::bigint'},${conversation?'NULL::bigint':'a.node_id'},${conversation?'NULL::int':'a.main_seg'},s.metadata->>'runtime_id',a.metadata->>'turn_id',COALESCE(s.metadata->>'runtime_id',a.metadata->>'turn_id','legacy:${table}:'||a.id),
    COALESCE(s.metadata->>'role',CASE WHEN a.worker='main' THEN 'mainagent' WHEN a.worker LIKE 'work#%' THEN 'worker' ELSE a.worker END,'unknown'),
    COALESCE(a.metadata->'response'->>'model','未记录模型'),'completed',
    CASE WHEN a.kind='result' THEN jsonb_build_object('input',a.input_tokens,'output',COALESCE(a.output_tokens,0),'cacheRead',COALESCE(a.cache_read_tokens,0),'cacheWrite',COALESCE(a.cache_write_tokens,0)) ELSE a.metadata->'response'->'usage' END,
    CASE WHEN a.kind='result' AND s.metadata->>'runtime_id' IS NULL THEN 'legacy_unknown' ELSE 'complete' END,
    CASE WHEN a.kind='result' AND s.metadata->>'runtime_id' IS NULL THEN 'unknown' ELSE 'exclusive_cache' END,
    CASE WHEN a.kind='result' THEN 'legacy_results' ELSE 'native_response' END,a.created_at,a.created_at
   FROM ${table} a ${conversation?'JOIN conversations c ON c.id=a.conversation_id LEFT JOIN tasks t ON t.id=c.task_id':'LEFT JOIN tasks t ON t.exploration_id=a.exploration_id'}
   LEFT JOIN LATERAL (SELECT x.metadata FROM ${table} x WHERE x.${conversation?'conversation_id':'exploration_id'}=a.${conversation?'conversation_id':'exploration_id'}
    AND x.metadata->>'turn_id'=a.metadata->>'turn_id' AND x.metadata->>'event_type'='turn_start' AND x.created_at<=a.created_at ORDER BY x.id DESC LIMIT 1) s ON true
   WHERE a.kind='result' AND a.input_tokens IS NOT NULL OR (a.metadata ? 'response' AND a.metadata ? 'stream_id' AND COALESCE((a.metadata->'response'->'usage'->>'totalTokens')::numeric,0)>0)
   ON CONFLICT(request_id) DO NOTHING`);
 }
}

/** Priority is per execution, never per task. Ambiguous overlaps remain explicitly visible. */
export const CANONICAL_USAGE_CTE=`physical AS (
 SELECT * FROM llm_usage_ledger WHERE source IN ('provider','request_audit')
), canonical AS (
 SELECT l.*, EXISTS(SELECT 1 FROM llm_usage_ledger x WHERE x.scope_key=l.scope_key AND x.source='native_response'
    AND (SELECT count(*) FROM llm_usage_ledger n WHERE n.scope_key=l.scope_key AND n.source='native_response')>
        (SELECT count(*) FROM physical p WHERE p.scope_key=l.scope_key)) AS history_gap
 FROM physical l
 UNION ALL
 SELECT l.*,false history_gap FROM llm_usage_ledger l WHERE l.source='legacy_results'
  AND NOT EXISTS(SELECT 1 FROM physical p WHERE p.scope_key=l.scope_key OR (
    l.runtime_id IS NULL AND l.turn_id IS NULL AND p.task_id IS NOT DISTINCT FROM l.task_id AND p.role=l.role
    AND p.created_at<=l.created_at AND p.created_at>COALESCE((SELECT max(prev.created_at) FROM llm_usage_ledger prev WHERE prev.source='legacy_results'
      AND prev.task_id IS NOT DISTINCT FROM l.task_id AND prev.role=l.role AND prev.main_seg IS NOT DISTINCT FROM l.main_seg AND prev.created_at<l.created_at),'-infinity'::timestamptz)))
 UNION ALL
 SELECT l.*,false history_gap FROM llm_usage_ledger l WHERE l.source='native_response'
  AND NOT EXISTS(SELECT 1 FROM physical p WHERE p.scope_key=l.scope_key)
  AND NOT EXISTS(SELECT 1 FROM llm_usage_ledger r WHERE r.source='legacy_results' AND r.scope_key=l.scope_key)
), measured AS (
 SELECT *,GREATEST(0,COALESCE((usage->>'input')::bigint,0)) i,GREATEST(0,COALESCE((usage->>'output')::bigint,0)) o,
  GREATEST(0,COALESCE((usage->>'cacheRead')::bigint,0)) cr,GREATEST(0,COALESCE((usage->>'cacheWrite')::bigint,0)) cw FROM canonical
)`;

export const USAGE_SUM_SQL=`count(*) FILTER(WHERE source<>'legacy_results') calls,
 COALESCE(sum(i+CASE WHEN input_semantics='exclusive_cache' THEN cr+cw ELSE 0 END),0) input_tokens,
 COALESCE(sum(i),0) uncached_input_tokens,COALESCE(sum(o),0) output_tokens,
 COALESCE(sum(cr),0) cache_read_tokens,COALESCE(sum(cw),0) cache_write_tokens,
 count(*) FILTER(WHERE quality NOT IN ('complete','not_sent') OR history_gap) unknown_usage_calls,
 count(*) FILTER(WHERE source='legacy_results') legacy_records,
 count(*) FILTER(WHERE status='running') pending_calls,
 count(*) FILTER(WHERE status IN ('failed','aborted')) failed_calls,
 count(*) FILTER(WHERE purpose='compaction') compaction_calls,
 bool_and(quality IN ('complete','not_sent') AND NOT history_gap) usage_complete,
 bool_and(source<>'legacy_results') calls_complete,
 bool_and(input_semantics='exclusive_cache' AND quality IN ('complete','not_sent') AND NOT history_gap) input_complete`;

export function usageDTO(row:Record<string,unknown>={}){
 const keys=['calls','input_tokens','uncached_input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','unknown_usage_calls','legacy_records','pending_calls','failed_calls','compaction_calls'];
 return {...Object.fromEntries(keys.map(k=>[k,Number(row[k]??0)])),version:USAGE_VERSION,input_semantics:row.input_complete===false?'unknown':'inclusive_cache',
   usage_complete:row.usage_complete!==false,calls_complete:row.calls_complete!==false,input_complete:row.input_complete!==false,source:'usage_ledger'};
}

export async function aggregateUsage(db:Database,scope:UsageScope={},group?:'model'|'profile'|'day'|'profile_day'|'worker'|'session'|'conversation'|'role'){
 const params:unknown[]=[];const where:string[]=[];
 for(const [key,col] of [['taskID','task_id'],['conversationID','conversation_id'],['runtimeID','runtime_id'],['turnID','turn_id']] as const)
  if(scope[key]!==undefined){params.push(scope[key]);where.push(`${col}=$${params.length}`);}
 const expression={model:'model',profile:"COALESCE(profile_id::text,'unknown')",day:"to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')",
  profile_day:"COALESCE(profile_id::text,'unknown')||':'||to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')",
  worker:"CASE WHEN role='worker' THEN COALESCE((SELECT a.worker FROM activity a WHERE a.node_id=measured.intent_id LIMIT 1),'worker') ELSE role END",
  session:"CASE WHEN conversation_id IS NOT NULL THEN 'conversation:'||conversation_id WHEN intent_id IS NOT NULL THEN 'intent:'||intent_id WHEN role='mainagent' THEN 'main:'||COALESCE(main_seg,0) WHEN role IN ('planner','goals') THEN 'plan' ELSE role END",
  conversation:'conversation_id::text',role:'role'};
 if(group==='conversation')where.push('conversation_id IS NOT NULL');
 const rows=(await db.query(`WITH ${CANONICAL_USAGE_CTE} SELECT ${group?`${expression[group]} bucket, max(model) model,max(profile_name) profile_name,max(profile_id) profile_id, min(created_at) created_at,count(DISTINCT task_id) tasks,`:''}${USAGE_SUM_SQL}
  FROM measured ${where.length?'WHERE '+where.join(' AND '):''} ${group?'GROUP BY 1 ORDER BY 1':''}`,params)).rows;
 return rows.map(r=>({...r,...usageDTO(r)}));
}
