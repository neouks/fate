import {createHash} from 'node:crypto';
import type {Database} from '../db/index.js';
import {hasHistoryPlaceholder} from './history-placeholder.js';

export interface EvidenceRepairItem {node_id: number; version: number; activity_ids: number[];}

/** Caller owns the transaction. Sources are explicitly reviewed log IDs, never
 * inferred from the untrusted node number in the placeholder. No task execution. */
export async function prepareEvidenceRepair(db: Pick<Database, 'query'>, taskID: number, item: EvidenceRepairItem) {
  if (![taskID, item.node_id, ...item.activity_ids].every(n => Number.isSafeInteger(n) && n > 0)
    || !Number.isSafeInteger(item.version) || item.version < 0 || !item.activity_ids.length
    || item.activity_ids.length > 30 || new Set(item.activity_ids).size !== item.activity_ids.length) throw new Error('无效修复清单');
  const node = (await db.query<{id: string; exploration_id: string; content_version: number; payload: Record<string, unknown>; created_at: Date}>(`SELECT n.* FROM exploration_nodes n JOIN tasks t ON t.exploration_id=n.exploration_id
    WHERE t.id=$1 AND n.id=$2 AND n.kind='fact' FOR UPDATE OF n`, [taskID, item.node_id])).rows[0];
  if (!node || Number(node.content_version) !== item.version || !hasHistoryPlaceholder(node.payload.evidence)) throw new Error(`事实 #${item.node_id} 已变化或不是占位证据，停止修复`);
  const sourceIntent = Number(node.payload.from_intent);
  if (!Number.isSafeInteger(sourceIntent) || sourceIntent <= 0) throw new Error('无法确定事实来源 Worker');
  const rows = (await db.query<{id: string; node_id: string; tool: string; detail: string; created_at: Date}>(`SELECT id,node_id,tool,detail,created_at FROM activity WHERE id=ANY($1::bigint[])
    AND exploration_id=$2 AND node_id=$3 AND kind='tool_result' AND NOT is_error
    AND created_at<=$4 AND tool NOT IN ('record_fact','report_finding','context_get','context_search') ORDER BY id`,
  [item.activity_ids, node.exploration_id, sourceIntent, node.created_at])).rows;
  if (rows.length !== item.activity_ids.length || rows.some(r => !r.detail || hasHistoryPlaceholder(r.detail))) throw new Error('来源必须是同一 Worker 在提交事实前已有的原始工具结果');
  const evidence = '【证据修复：以下为核对后选取的既有工具结果原文，替换误写的历史占位符；不是恢复模型当时未提交的正文，也不表示重新验证了全部结论。未重跑任何操作。】\n' +
    rows.map(r => `\n[activity:${r.id}; tool=${r.tool}; time=${new Date(r.created_at).toISOString()}]\n${r.detail}`).join('\n');
  const repair = {version: 1, method: 'reviewed_source_logs', previous_evidence_sha256: createHash('sha256').update(String(node.payload.evidence)).digest('hex'),
    source_intent: sourceIntent, sources: rows.map(r => ({ref: `activity:${r.id}`, sha256: createHash('sha256').update(r.detail).digest('hex')})),
    claim_revalidated: false};
  return {node, evidence, repair};
}

export async function applyEvidenceRepair(db: Pick<Database, 'query'>, taskID: number, item: EvidenceRepairItem) {
  const prepared = await prepareEvidenceRepair(db, taskID, item);
  await db.query(`UPDATE exploration_nodes SET payload=payload||jsonb_build_object('evidence',$2::text,'evidence_repair',$3::jsonb),
    content_version=content_version+1 WHERE id=$1`, [item.node_id, prepared.evidence, JSON.stringify(prepared.repair)]);
  return prepared;
}
