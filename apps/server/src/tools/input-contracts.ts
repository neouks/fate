// Mandatory API contracts are shared by declarations and validation. They remain
// visible even when an administrator supplies custom business descriptions.
export const CONTEXT_ITEM_LIMIT_GUIDANCE = 'items[].max_chars 仅用于 node/activity/operation/session；output/attachment/traffic 禁止传此字段，使用原生分页并将 next_item 原样续读，偏移单位以 offset_unit 为准。';
export const INTENT_RETRY_GUIDANCE = 'retry_of、retry_kind、retry_reason 必须一起提供，retry_reason 非空；retry_of 仅引用本任务同一工作。双方都有 contract.work 时按 resource/question_key/method_class/identity 和派单资产范围核对；任一方没有 work 时还可按规范化 summary 和相同资产范围匹配。先 context_get 读取旧意图，保留原工作身份与范围；不能通过改写 summary、补造 work 或删除 retry_of 绕过去重。transient_failure 仅适用于 blocked/exhausted/stopped；new_evidence 必须在 contract.basis 中提供新增或有效版本变化的事实依据。用户取消不可重试，活跃工作返回已有意图。';

export function contextItemLimitError(item: unknown, index: number): string | undefined {
  if (!item || typeof item !== 'object') return;
  const value = item as Record<string, unknown>;
  if (value.max_chars !== undefined && typeof value.ref === 'string' && /^(output|attachment|traffic):/.test(value.ref))
    return `CONTEXT_NATIVE_PAGING: items[${index}].max_chars 不适用于 ${value.ref.split(':')[0]}: 引用；请移除此字段，保留 ref，按返回的 next_item 和 offset_unit 续读。修改 view 或 field 不能解决此错误。`;
}

export function intentRetryArgumentError(item: Record<string, unknown>, path: string): string | undefined {
  const fields = ['retry_of', 'retry_kind', 'retry_reason'];
  if (!fields.some(key => item[key] !== undefined)) return;
  if (!Number.isSafeInteger(item.retry_of) || Number(item.retry_of) <= 0)
    return `${path}retry_of 必须是本任务原意图的正整数 ID；retry_of、retry_kind、retry_reason 必须一起提供`;
  if (typeof item.retry_kind !== 'string' || !['new_evidence', 'transient_failure'].includes(item.retry_kind))
    return `${path}retry_kind 必须为 new_evidence 或 transient_failure；与 retry_of、retry_reason 一起提供`;
  if (typeof item.retry_reason !== 'string' || !item.retry_reason.trim() || item.retry_reason.length > 2000)
    return `${path}retry_reason 必须是 1–2000 字符的非空重试原因；与 retry_of、retry_kind 一起提供`;
}
