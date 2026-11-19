import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertOriginalEvidence, hasHistoryPlaceholder, HISTORY_EXCERPT_NOTE, HISTORY_INDEX_NOTE, HISTORY_OMITTED_NOTE} from './history-placeholder.js';

test('reject legacy placeholders even when the referenced node exists or is the fact itself', () => {
  const placeholder = '[历史调用正文已保存至 node:42，版本 0；用 context_get 读取 /payload/evidence]';
  for (const field of ['evidence', 'detail']) {
    for (const text of [placeholder, `observed output\n${placeholder}`]) {
      assert.throws(() => assertOriginalEvidence({[field]: text}), /不是原始证据/);
    }
  }
  assert.equal(hasHistoryPlaceholder(placeholder), true);
  assert.doesNotThrow(() => assertOriginalEvidence({evidence: 'activity:42 原始响应：fixture OK', detail: '仅检查样本'}));
  assert.doesNotThrow(() => assertOriginalEvidence({evidence: '见 node:42 的实测记录'}));
});

test('platform history envelopes cannot be saved as new evidence; real excerpts and unrelated JSON remain valid', () => {
  for (const history_note of [HISTORY_EXCERPT_NOTE, HISTORY_INDEX_NOTE, HISTORY_OMITTED_NOTE]) {
    assert.throws(() => assertOriginalEvidence({evidence: JSON.stringify({history_omitted: true, history_note}, null, 2)}), /不是原始证据/);
  }
  assert.doesNotThrow(() => assertOriginalEvidence({evidence: '{"history_omitted":true,"result":"original API response"}'}));
  assert.doesNotThrow(() => assertOriginalEvidence({evidence: '已核对的原始响应片段', detail: '仅包含相关字段'}));
});
