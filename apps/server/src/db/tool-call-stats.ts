import type {Database} from './index.js';

const FORMAT_VERSION=1;

/** One-time/recovery rebuild. Normal catalog reads only touch the compact
 * projection; source tables are locked only while publishing a new snapshot. */
export async function prepareToolCallStats(db:Database){
 const state=(await db.query('SELECT format_version,ready FROM tool_call_rollup_state WHERE singleton')).rows[0];
 if(state?.ready&&Number(state.format_version)===FORMAT_VERSION)return;
 await db.transaction(async tx=>{
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('tool-call-rollup-rebuild',0))");
  const current=(await tx.query('SELECT format_version,ready FROM tool_call_rollup_state WHERE singleton FOR UPDATE')).rows[0];
  if(current?.ready&&Number(current.format_version)===FORMAT_VERSION)return;
  await tx.query('LOCK TABLE activity,conversation_activities IN SHARE ROW EXCLUSIVE MODE');
  await tx.query('UPDATE tool_call_rollup_state SET ready=false,format_version=$1 WHERE singleton',[FORMAT_VERSION]);
  await tx.query('DELETE FROM tool_call_rollup_stats');
  await tx.query('DELETE FROM tool_call_rollup_calls');
  await tx.query(`WITH events AS (
   SELECT 'task' AS scope,exploration_id AS scope_id,id,node_id,main_seg,worker,kind,tool,tool_use_id,is_error,metadata
    FROM activity WHERE kind IN ('tool_use','tool_result') AND tool IS NOT NULL
   UNION ALL
   SELECT 'conversation',conversation_id,id,NULL,NULL,worker,kind,tool,tool_use_id,is_error,metadata
    FROM conversation_activities WHERE kind IN ('tool_use','tool_result') AND tool IS NOT NULL
  ), identified AS (
   SELECT *,tool_call_rollup_identity(scope,scope_id,worker,node_id,main_seg,metadata->>'turn_id',tool_use_id,metadata,id) call_identity
   FROM events
  ) INSERT INTO tool_call_rollup_calls(tool,identity_hash,call_identity,started_members,finished_members,failed_members)
   SELECT tool,md5(call_identity::text),call_identity,
    count(*) FILTER(WHERE kind='tool_use'),count(*) FILTER(WHERE kind='tool_result'),
    count(*) FILTER(WHERE kind='tool_result' AND is_error)
   FROM identified GROUP BY tool,call_identity`);
  await tx.query(`INSERT INTO tool_call_rollup_stats(tool,calls,succeeded,failed,unknown)
   SELECT tool,count(*) FILTER(WHERE started_members>0),
    count(*) FILTER(WHERE started_members>0 AND finished_members>0 AND failed_members=0),
    count(*) FILTER(WHERE started_members>0 AND failed_members>0),
    count(*) FILTER(WHERE started_members>0 AND finished_members=0)
   FROM tool_call_rollup_calls GROUP BY tool`);
  await tx.query('UPDATE tool_call_rollup_state SET ready=true WHERE singleton');
 });
}

/** Counts cover retained logs only. Old tool_usage rows cannot be safely added:
 * they have no call identity and may describe the same historical calls. */
export async function toolCallStats(db:Database,keys:string[]){
 if(!keys.length)return new Map<string,Record<string,unknown>>();
 await prepareToolCallStats(db);
 const result=await db.query(`SELECT tool,calls::int,succeeded::int,failed::int,unknown::int
  FROM tool_call_rollup_stats WHERE tool=ANY($1::text[])`,[keys]);
 return new Map(result.rows.map(row=>[String(row.tool),row]));
}
export const emptyToolCallStats={calls:0,succeeded:0,failed:0,unknown:0};
