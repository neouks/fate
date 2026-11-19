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

export interface WorkerTokenBudget {
  limit: number;
  used: number;
  remaining: number;
  reserve: number;
  closing: boolean;
}

/** Reserve 10%, or three full requests for writeback/compaction with large contexts.
 * Include the next execution request's ceiling so it cannot consume that reserve. */
export async function readWorkerTokenBudget(tx: Database, scope: UsageScope & {role: string}, requestCeiling = 0): Promise<WorkerTokenBudget | undefined> {
  if (scope.role !== 'worker' || !scope.intentID || !scope.taskID) return;
  const limit = await workerTokenLimit(tx);
  if (limit === 0) return;
  const ledger = CANONICAL_USAGE_CTE.replace('/* usage_scope */', 'WHERE task_id=$1 AND intent_id=$2');
  const {rows: [row]} = await tx.query<{input_tokens: string; output_tokens: string; pending_calls: string; uncertain: string}>(`WITH ${ledger} SELECT ${USAGE_SUM_SQL},
    count(*) FILTER (WHERE history_gap OR (quality NOT IN ('complete','not_sent')
      AND NOT (status='completed' AND COALESCE(usage->>'_input_total_known'='true'
        AND (usage->'_known_fields') ? 'output',false)))) AS uncertain
    FROM measured`, [scope.taskID, scope.intentID]);
  const used = BigInt(row!.input_tokens) + BigInt(row!.output_tokens);
  if (Number(row!.pending_calls) || Number(row!.uncertain)) {
    throw new Error(TOKEN_USAGE_UNCERTAIN + '：先前请求尚未结算或缺少完整用量');
  }
  const remaining = Math.max(0, limit - Number(used));
  const reserve = Math.min(limit, Math.max(Math.ceil(limit * 0.1), 3 * requestCeiling));
  return {limit, used: Number(used), remaining, reserve, closing: remaining <= reserve + requestCeiling};
}

// Called inside the same transaction that inserts the running request. A concurrent
// admission must see either that request or its final receipt, including after resume.
export async function checkWorkerTokenBudget(tx: Database, scope: UsageScope & {role: string}) {
  if (scope.role !== 'worker' || !scope.intentID || !scope.taskID) return;
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `worker-token-budget:${scope.taskID}:${scope.intentID}`,
  ]);
  const budget = await readWorkerTokenBudget(tx, scope);
  if (budget && budget.used >= budget.limit) throw new Error(`${TOKEN_LIMIT_REACHED}（${budget.used} / ${budget.limit}）`);
  return budget;
}

/** Input is conservatively reserved at the configured model context ceiling;
 * never admit a request merely because its previous receipt was below the cap. */
export function workerRequestMaxTokens(budget: WorkerTokenBudget, model: {contextWindow: number; maxTokens: number}, requested?: number) {
  const maxTokens = Math.floor(Math.min(model.maxTokens, requested ?? model.maxTokens, budget.remaining - model.contextWindow));
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw new Error(`${TOKEN_LIMIT_REACHED}：剩余额度不足以容纳下一次请求（${budget.used} / ${budget.limit}）`);
  }
  return maxTokens;
}
