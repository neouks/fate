import assert from "node:assert/strict";
import { test } from "node:test";
import { toolCallState } from "./terminal-diagnostic";
import { isLifecycle, legacyReceiptStatus, withLiveStreams } from "./conversation-turns";
import type { Activity } from "./types";

const use: Activity = { seq: 1, worker: "worker", ts: "", kind: "tool_use", tool: "bash", summary: "" };
const result: Activity = { ...use, seq: 2, kind: "tool_result", is_error: true };

test("output and summaries do not supply execution status", () => {
  for (const text of ["Command aborted", "partial output\n\nCommand aborted", "Command exited with code 1"]) {
    for (const truncated of [true, false]) {
      const record = { ...result, summary: text, detail: text, detail_truncated: truncated };
      assert.equal(toolCallState(use, record), "failed");
      assert.equal(toolCallState(use, { ...record, is_error: false }), "completed");
    }
  }
});

test("tool status follows the call's own receipt", () => {
  assert.equal(toolCallState(use, undefined), "unknown");
  assert.equal(toolCallState({ ...use, metadata: { status: "running" } }, undefined), "running");
  assert.equal(toolCallState(undefined, { ...result, interrupted: true }), "stopped");
  assert.equal(toolCallState(use, { ...result, metadata: { status: "aborted" } }), "stopped");
  assert.equal(toolCallState({ ...use, interrupted: true }, { ...result, is_error: false }), "completed");
});

test("an expired stream snapshot records neither a running stream nor an interruption", () => {
  const [step] = withLiveStreams([], [{worker:"worker",turn_id:"t",stream_id:"s",channel:"text",text:"body",offset:4,ts:"",active:false}]);
  assert.equal(step.streaming, false);
  assert.equal(step.interrupted, undefined);
});

test("legacy lifecycle receipts retain their outcome while native response text remains visible", () => {
  const receipt: Activity = {...result, kind:"result", worker:"mainagent", summary:"回复已停止"};
  assert.equal(legacyReceiptStatus(receipt), "stopped");
  assert.equal(legacyReceiptStatus({...receipt, summary:"回复完成"}), "completed");
  for (const native of [{...receipt, worker:"worker"}, {...receipt, metadata:{response:true}}, {...receipt, detail:"回复已停止，还有输出。"}]) {
    assert.equal(isLifecycle(native), false);
  }
});
