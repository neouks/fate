import type {Database} from '../db/index.js';

/** pi usage.input excludes cache reads/writes. The public overview contract is
 * total prompt input, with cache reads/writes shown as subsets. Count requests,
 * never host result rows, and never attribute history to today's default model. */
export async function modelTokenUsage(db:Database,taskID?:number){
 const params=[taskID??null];
 const audit=(await db.query(`WITH requests AS (
   SELECT a.*,COALESCE((usage->>'input')::bigint,0) i,COALESCE((usage->>'output')::bigint,0) o,
    COALESCE((usage->>'cacheRead')::bigint,0) cr,COALESCE((usage->>'cacheWrite')::bigint,0) cw
   FROM llm_request_attempts a LEFT JOIN tasks t ON t.id=a.task_id
   WHERE ($1::bigint IS NULL OR a.task_id=$1) AND (a.task_id IS NULL OR t.deleted_at IS NULL)
  ) SELECT model,count(*) calls,sum(i) uncached_input_tokens,sum(i+cr+cw) input_tokens,
   sum(o) output_tokens,sum(cr) cache_read_tokens,sum(cw) cache_write_tokens,
   count(*) FILTER(WHERE purpose='compaction') compaction_calls,
   count(*) FILTER(WHERE status IN ('failed','aborted')) failed_calls,
   count(*) FILTER(WHERE status='running') pending_calls,
   count(*) FILTER(WHERE status='running' OR COALESCE((usage->>'unavailable')::boolean,false)
    OR NOT usage ?& ARRAY['input','output','cacheRead','cacheWrite']
    OR status IN ('failed','aborted') AND i+o+cr+cw=0) unknown_usage_calls
  FROM requests GROUP BY model ORDER BY model`,params)).rows;
 const models=audit.map(r=>({model:String(r.model),source:'request_audit',input_semantics:'inclusive_cache',
  ...Object.fromEntries(['calls','input_tokens','uncached_input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','compaction_calls','failed_calls','pending_calls','unknown_usage_calls'].map(k=>[k,Number(r[k])]))}));
 // Old tasks without request audits retain recorded totals. Counts, model and
 // cache semantics cannot be recovered from run totals. Never add run totals
 // on top of audited requests from the same task (including partial runs).
 const old=(await db.query(`SELECT count(*) records,COALESCE(sum(a.input_tokens),0) input_tokens,
  COALESCE(sum(a.output_tokens),0) output_tokens,COALESCE(sum(a.cache_read_tokens),0) cache_read_tokens,
  COALESCE(sum(a.cache_write_tokens),0) cache_write_tokens
  FROM activity a JOIN tasks t ON t.exploration_id=a.exploration_id AND t.deleted_at IS NULL
  WHERE a.kind='result' AND a.input_tokens IS NOT NULL AND ($1::bigint IS NULL OR t.id=$1)
   AND NOT EXISTS(SELECT 1 FROM llm_request_attempts r WHERE r.task_id=t.id)`,params)).rows[0]!;
 return {models:[...models,...Number(old.records)>0?[{model:'未记录模型',source:'legacy_results',input_semantics:'unknown',calls:null,
  ...Object.fromEntries(['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens'].map(k=>[k,Number(old[k])]))}]:[]]};
}
