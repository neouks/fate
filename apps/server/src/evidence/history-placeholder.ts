export const HISTORY_EXCERPT_NOTE = '旧工具结果仅保留摘要；按原调用参数或引用、版本和字段重读。分页坐标对应原文。';
export const HISTORY_INDEX_NOTE = '仅历史索引，非完整证据；按引用或原调用参数重读。';
export const HISTORY_OMITTED_NOTE = '历史正文未展示不代表没有结果；按原调用参数重读，不将索引当作证据。';

/** A former request projection generated this text inside write arguments.
 * It is a display placeholder, never evidence or a resolvable source reference.
 * Do not dereference its node number: it may point at unrelated or future data. */
export function hasHistoryPlaceholder(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (/历史调用正文已保存至\s*node\s*[:：]/u.test(value)) return true;
  // Recognize our own projection envelope, not arbitrary evidence that happens
  // to contain a similarly named JSON field. Plain verified excerpts are valid.
  try {
    const row = JSON.parse(value);
    return !!row && typeof row === 'object' &&
      [HISTORY_EXCERPT_NOTE,HISTORY_INDEX_NOTE,HISTORY_OMITTED_NOTE].includes(row.history_note);
  } catch { return false; }
}

export function assertOriginalEvidence(fields: {evidence?: string; detail?: string}): void {
  for (const field of ['evidence', 'detail'] as const) {
    if (hasHistoryPlaceholder(fields[field])) {
      throw new Error(`${field} 包含历史压缩占位符，不是原始证据，未保存。请从原始工具结果恢复正文；不能猜测节点编号或把占位符复制为新事实。无法恢复时如实说明证据缺失，不重复执行来补齐旧记录。`);
    }
  }
}
