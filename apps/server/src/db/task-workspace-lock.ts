import type { Database } from './index.js';

export async function lockTaskWorkspace(tx: Database, taskID: number) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('task-workspace:' || $1::text, 0))", [taskID]);
}

export async function taskWorkspaceBusy(db: Database, taskID: number): Promise<boolean> {
  const result = await db.query(`SELECT
    EXISTS (SELECT 1 FROM runtime_role_configs WHERE task_id=$1 AND finished_at IS NULL)
    OR EXISTS (SELECT 1 FROM runtime_session_leases WHERE key LIKE 'main:'||$1::text||':%' AND expires_at>clock_timestamp())
    OR EXISTS (SELECT 1 FROM engine_worker_slots s JOIN engine_task_leases l
      ON l.task_id=s.task_id AND l.token=s.token
      WHERE s.task_id=$1 AND s.phase='running' AND l.expires_at>clock_timestamp()) AS busy`, [taskID]);
  return result.rows[0]?.busy === true;
}
