import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxThinking } from "@earendil-works/pi-ai";
import { ModelRuntime, defineTool } from "@earendil-works/pi-coding-agent";
import { AgentRunner, type AgentRunnerOptions } from "./runner.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function fixture(extra: Partial<AgentRunnerOptions> = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), "fate-pi-")); dirs.push(cwd);
  const faux = fauxProvider({ provider: `faux-${path.basename(cwd)}` });
  const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
  await modelRuntime.registerNativeProvider(faux.provider);
  const options: AgentRunnerOptions = { cwd, agentDir: path.join(cwd, "agent"), modelRuntime, model: faux.getModel() as never, inMemory: true, toolAllowlist: [], ...extra };
  return { cwd, faux, options };
}
describe("pi native lifecycle", () => {
  it("persists at the requested path and resumes the same conversation", async () => {
    const { cwd, faux, options } = await fixture();
    options.resumeSessionPath = path.join(cwd, "sessions", "main-2.jsonl"); options.inMemory = false;
    faux.setResponses([fauxAssistantMessage("记住了")]);
    const first = await AgentRunner.create(options);
    await first.prompt("remember unique-session-value"); first.dispose();
    expect(existsSync(options.resumeSessionPath)).toBe(true);
    faux.setResponses([(context) => {
      expect(JSON.stringify(context.messages)).toContain("unique-session-value");
      return fauxAssistantMessage("上下文仍在");
    }]);
    const second = await AgentRunner.create(options);
    try { expect((await second.prompt("刚才是什么？")).lastAssistantText).toBe("上下文仍在"); }
    finally { second.dispose(); }
  });
  it("surfaces provider errors instead of completing successfully", async () => {
    const { faux, options } = await fixture();
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider unavailable" })]);
    const runner = await AgentRunner.create(options);
    try { await expect(runner.prompt("hello")).rejects.toThrow("provider unavailable"); }
    finally { runner.dispose(); }
  });
  it("enforces turn budget even when the model keeps calling tools", async () => {
    let calls = 0;
    const tick = defineTool({ name: "tick", label: "tick", description: "tick", parameters: { type: "object", properties: {} } as never,
      async execute() { calls++; return { content: [{ type: "text", text: "ok" }], details: undefined }; } });
    const { faux, options } = await fixture({ maxTurns: 2, toolAllowlist: ["tick"], customTools: [tick] });
    faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage([fauxToolCall("tick", {})])));
    const runner = await AgentRunner.create(options);
    try { expect((await runner.prompt("tick repeatedly")).stopReason).toBe("budget"); expect(calls).toBe(2); }
    finally { runner.dispose(); }
  });
  it("reads pi thinking blocks and emits text deltas", async () => {
    const events: unknown[] = [];
    const { faux, options } = await fixture({ onActivity: (a) => events.push(a) });
    faux.setResponses([fauxAssistantMessage([fauxThinking("internal trace"), { type: "text", text: "hello" }])]);
    const runner = await AgentRunner.create(options);
    try { await runner.prompt("hello"); }
    finally { runner.dispose(); }
    expect(events).toContainEqual({ kind: "assistant_message_end", text: "internal trace", isThinking: true });
    expect(events.some((a: any) => a.kind === "assistant_delta")).toBe(true);
  });
  it("honors cancellation before the runner is ready", async () => {
    const controller = new AbortController(); controller.abort();
    const { options, faux } = await fixture({ signal: controller.signal });
    const runner = await AgentRunner.create(options);
    try { await expect(runner.prompt("hello")).rejects.toThrow(); expect(faux.state.callCount).toBe(0); }
    finally { runner.dispose(); }
  });
});
