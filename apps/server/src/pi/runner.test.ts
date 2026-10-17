import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
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
    await first.prompt("remember unique-session-value"); await first.dispose();
    expect(existsSync(options.resumeSessionPath)).toBe(true);
    faux.setResponses([(context) => {
      expect(JSON.stringify(context.messages)).toContain("unique-session-value");
      return fauxAssistantMessage("上下文仍在");
    }]);
    const second = await AgentRunner.create(options);
    try { expect((await second.prompt("刚才是什么？")).lastAssistantText).toBe("上下文仍在"); }
    finally { await second.dispose(); }
  });
  it("surfaces provider errors instead of completing successfully", async () => {
    const { faux, options } = await fixture({ maxTurns: 1 });
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider unavailable" })]);
    const runner = await AgentRunner.create(options);
    try { await expect(runner.prompt("hello")).rejects.toThrow("provider unavailable"); }
    finally { await runner.dispose(); }
  });
  it.each([0, 2])("enforces turn budget with %i wrapup turns even when the model keeps calling tools", async (grace) => {
    let calls = 0;
    const tick = defineTool({ name: "tick", label: "tick", description: "tick", parameters: { type: "object", properties: {} } as never,
      async execute() { calls++; return { content: [{ type: "text", text: "ok" }], details: undefined }; } });
    const { faux, options } = await fixture({ maxTurns: 2, toolAllowlist: ["tick"], customTools: [tick],
      ...(grace ? { wrapup: () => ({ prompt: "save results and stop" }), maxWrapupTurns: grace } : {}) });
    faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage([fauxToolCall("tick", {})])));
    const runner = await AgentRunner.create(options);
    try { expect((await runner.prompt("tick repeatedly")).stopReason).toBe("budget"); expect(calls).toBe(2 + grace); }
    finally { await runner.dispose(); }
  });
  it("reads pi thinking blocks and emits text deltas", async () => {
    const events: unknown[] = [];
    const { faux, options } = await fixture({ onActivity: (a) => events.push(a) });
    faux.setResponses([fauxAssistantMessage([fauxThinking("internal trace"), { type: "text", text: "hello" }])]);
    const runner = await AgentRunner.create(options);
    try { await runner.prompt("hello"); }
    finally { await runner.dispose(); }
    expect(events).toContainEqual({ kind: "assistant_message_end", text: "internal trace", isThinking: true });
    expect(events.some((a: any) => a.kind === "assistant_delta")).toBe(true);
  });
  it("honors cancellation before the runner is ready", async () => {
    const controller = new AbortController(); controller.abort();
    const { options, faux } = await fixture({ signal: controller.signal });
    const runner = await AgentRunner.create(options);
    try { await expect(runner.prompt("hello")).rejects.toThrow(); expect(faux.state.callCount).toBe(0); }
    finally { await runner.dispose(); }
  });
  it("calls a native MCP stdio tool through the same guard pipeline", async () => {
    const { cwd, faux, options } = await fixture();
    const script = path.join(cwd, "mcp.cjs");
    writeFileSync(script, `const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};
if(m.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
if(m.method==='tools/list')result={tools:[{name:'echo',description:'echo',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};
if(m.method==='tools/call')result={content:[{type:'text',text:'echo:'+m.params.arguments.text}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
    options.mcpEntries = [{ name: "fixture", config: { command: process.execPath, args: [script], exposure: "direct" } }];
    options.toolAllowlist = ["mcp__*"];
    const calls: string[] = [], results: string[] = [];
    options.guard = (g) => { calls.push(g.toolName); return undefined; };
    options.onActivity = (a) => { if (a.kind === "tool_end") results.push(a.text ?? ""); };
    faux.setResponses([fauxAssistantMessage([fauxToolCall("mcp__fixture__echo", {text:"native"})]),fauxAssistantMessage("done")]);
    const runner = await AgentRunner.create(options);
    try { await runner.prompt("echo"); expect(calls).toContain("mcp__fixture__echo"); expect(results.join()).toContain("echo:native"); }
    finally { await runner.dispose(); }
  });

});
