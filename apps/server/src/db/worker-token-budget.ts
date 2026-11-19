import type {Database} from './index.js';
import {CANONICAL_USAGE_CTE, USAGE_SUM_SQL, type UsageScope} from './usage-ledger.js';

export const WORKER_TOKEN_LIMIT = 'worker_total_token_limit';
export const TOKEN_LIMIT_REACHED = 'Worker 累计 token 额度已达到';
export const TOKEN_USAGE_UNCERTAIN = 'Worker 累计 token 用量待核对';

export async function workerTokenLimit(db: Database) {
  const raw = await db.platform().getSetting(WORKER_TOKEN_LIMIT);
  if (raw === null) return 10_000_000;
  const limit = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(limit)) throw new Error(TOKEN_USAGE_UNCERTAIN + '：额度配置无效');
  return limit;
}

// Called inside the same transaction that inserts the running request. A concurrent
// admission must see either that request or its final receipt, including after resume.
export async function checkWorkerTokenBudget(tx: Database, scope: UsageScope & {role: string}) {
  if (scope.role !== 'worker' || !scope.intentID || !scope.taskID) return;
  const limit = await workerTokenLimit(tx);
  if (limit === 0) return;
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `worker-token-budget:${scope.taskID}:${scope.intentID}`,
  ]);
  const ledger = CANONICAL_USAGE_CTE.replace('/* usage_scope */', 'WHERE task_id=$1 AND intent_id=$2');
  const {rows: [row]} = await tx.query<{input_tokens: string; output_tokens: string; pending_calls: string; uncertain: string}>(`WITH ${ledger} SELECT ${USAGE_SUM_SQL},
    count(*) FILTER (WHERE history_gap OR (quality NOT IN ('complete','not_sent')
      AND NOT (status='completed' AND COALESCE(usage->>'_input_total_known'='true'
        AND (usage->'_known_fields') ? 'output',false)))) AS uncertain
    FROM measured`, [scope.taskID, scope.intentID]);
  const used = BigInt(row!.input_tokens) + BigInt(row!.output_tokens);
  if (used >= BigInt(limit)) throw new Error(`${TOKEN_LIMIT_REACHED}（${used} / ${limit}）`);
  if (Number(row!.pending_calls) || Number(row!.uncertain)) {
    throw new Error(TOKEN_USAGE_UNCERTAIN + '：先前请求尚未结算或缺少完整用量');
  }
}
