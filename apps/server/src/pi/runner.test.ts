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
  it.each([1,3])('ends a natural summary at the closing threshold %i without an extra model turn',async maxTurns=>{
    const {faux,options}=await fixture({maxTurns,reserveSettlementTurns:2,maxWrapupTurns:2,wrapup:({reason})=>reason==='settled'?undefined:{prompt:'save results'}});
    faux.setResponses([fauxAssistantMessage('No new observations; finished.'),()=>{throw new Error('unexpected extra model request');}]);
    const runner=await AgentRunner.create(options);
    try{expect((await runner.prompt('LOCAL summary')).stopReason).toBe('completed');expect(faux.state.callCount).toBe(1);}finally{await runner.dispose();}
  });
  it("reads pi thinking blocks and emits text deltas", async () => {
    const events: unknown[] = [];
    const { faux, options } = await fixture({ onActivity: (a) => events.push(a) });
    faux.setResponses([fauxAssistantMessage([fauxThinking("internal trace"), { type: "text", text: "hello" }])]);
    const runner = await AgentRunner.create(options);
    try { await runner.prompt("hello"); }
    finally { await runner.dispose(); }
    expect(events).toContainEqual(expect.objectContaining({ kind: "assistant_message_end", text: "internal trace", isThinking: true, streamID:expect.any(String) }));
    expect(events.some((a: any) => a.kind === "assistant_delta")).toBe(true);
  });
  it('announces the early closing reason and remaining budget, preserving explanatory tool failures in the session',async()=>{
    let explored=0,saved=false;const activities:any[]=[],reasons:unknown[]=[];
    const tool=(name:string,run:()=>void)=>defineTool({name,label:name,description:name,parameters:{type:'object',properties:{}} as never,
      async execute(){run();return {content:[{type:'text',text:'ok'}],details:undefined};}});
    const {cwd,faux,options}=await fixture({maxTurns:4,reserveSettlementTurns:2,maxWrapupTurns:2,
      wrapup:budget=>{reasons.push(budget);return {prompt:'save existing evidence'};},stopWhen:async()=>saved,
      settlementTools:['save'],toolAllowlist:['explore','save'],customTools:[tool('explore',()=>explored++),tool('save',()=>{saved=true;})],
      onActivity:a=>activities.push(a)});
    options.resumeSessionPath=path.join(cwd,'closing.jsonl');options.inMemory=false;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('explore',{})]),fauxAssistantMessage([fauxToolCall('explore',{})]),
      context=>{expect(runner.activeToolNames).not.toContain('explore');expect(JSON.stringify(context.messages)).toContain('剩余最多 4 次');return fauxAssistantMessage([fauxToolCall('explore',{})]);},
      context=>{const messages=JSON.stringify(context.messages);expect(messages).toContain('不要重试或排查工具环境');expect(messages).toContain('原始工具错误：Tool explore not found');expect(messages).toContain('剩余最多 3 次');return fauxAssistantMessage([fauxToolCall('save',{})]);},
    ]);
    const runner=await AgentRunner.create(options);
    try{
      expect((await runner.prompt('work')).stopReason).toBe('completed');expect(explored).toBe(2);expect(faux.state.callCount).toBe(4);
      expect(reasons).toContainEqual({reason:'turn_limit',usedRequests:2,remainingRequests:4});
      expect(activities).toContainEqual(expect.objectContaining({kind:'tool_end',toolName:'explore',isError:true,text:expect.stringContaining('停止新探索')}));
      expect(JSON.stringify(runner.messages)).toContain('原始工具错误：Tool explore not found');
    }finally{await runner.dispose();}
    saved=false;
    faux.setResponses([context=>{const messages=JSON.stringify(context.messages);expect(messages).toContain('当前仍在执行阶段');expect(messages).toContain('已用 0 次，剩余最多 6 次');expect(resumed.activeToolNames).toContain('explore');return fauxAssistantMessage([fauxToolCall('save',{})]);}]);
    const resumed=await AgentRunner.create(options);
    try{await resumed.prompt('resume explicit new execution');expect(faux.state.callCount).toBe(5);}finally{await resumed.dispose();}
  });
  it('keeps the hard cap when a model ignores closing and repeatedly calls an inactive tool',async()=>{
    let explored=0;const errors:string[]=[];
    const explore=defineTool({name:'explore',label:'explore',description:'explore',parameters:{type:'object',properties:{}} as never,
      async execute(){explored++;return {content:[{type:'text',text:'ok'}],details:undefined};}});
    const {faux,options}=await fixture({maxTurns:3,reserveSettlementTurns:2,maxWrapupTurns:2,wrapup:()=>({prompt:'save'}),
      settlementTools:[],toolAllowlist:['explore'],customTools:[explore],onActivity:a=>{if(a.kind==='tool_end'&&a.isError)errors.push(a.text??'');}});
    faux.setResponses(Array.from({length:9},()=>fauxAssistantMessage([fauxToolCall('explore',{})])));
    const runner=await AgentRunner.create(options);
    try{expect((await runner.prompt('work')).stopReason).toBe('budget');expect(faux.state.callCount).toBe(5);expect(explored).toBe(1);expect(errors).toHaveLength(4);expect(errors.every(e=>e.includes('不要重试'))).toBe(true);}finally{await runner.dispose();}
  });
  it("honors cancellation before the runner is ready", async () => {
    const controller = new AbortController(); controller.abort();
    const { options, faux } = await fixture({ signal: controller.signal });
    const runner = await AgentRunner.create(options);
    try { await expect(runner.prompt("hello")).rejects.toThrow(); expect(faux.state.callCount).toBe(0); }
    finally { await runner.dispose(); }
  });
  it('reserves closing time within the deadline and blocks new operations without blocking writeback',async()=>{
    let explored=0,saved=false;
    const tool=(name:string,run:()=>void)=>defineTool({name,label:name,description:name,parameters:{type:'object',properties:{}} as never,
      async execute(){run();return {content:[{type:'text',text:'ok'}],details:undefined};}});
    const {faux,options}=await fixture({maxDurationMs:1000,maxTurns:5,wrapup:context=>{if(!saved)expect(context.reason).toBe('duration_limit');return saved?undefined:{prompt:'save existing evidence'};},maxWrapupTurns:2,
      settlementTools:['save'],toolAllowlist:['explore','save'],customTools:[tool('explore',()=>explored++),tool('save',()=>{saved=true;})]});
    faux.setResponses([async()=>{await new Promise(r=>setTimeout(r,940));return fauxAssistantMessage([fauxToolCall('explore',{}),fauxToolCall('save',{})]);},
      context=>{expect(JSON.stringify(context.messages)).toContain('时间预算即将耗尽');return fauxAssistantMessage('saved');}]);
    const runner=await AgentRunner.create(options);
    try{await runner.prompt('work');expect(explored).toBe(0);expect(saved).toBe(true);}finally{await runner.dispose();}
  });
  it('reports the hard time limit independently of turn limits',async()=>{
    const {faux,options}=await fixture({maxDurationMs:50,maxTurns:5});
    faux.setResponses([async(_ctx,opts)=>{await new Promise<void>(resolve=>opts?.signal?.addEventListener('abort',()=>resolve(),{once:true}));return fauxAssistantMessage('',{stopReason:'aborted'});}]);
    const runner=await AgentRunner.create(options);
    try{expect(await runner.prompt('wait')).toMatchObject({aborted:true,stopReason:'budget',budgetReason:'duration_limit'});}finally{await runner.dispose();}
  });
  it('propagates cancellation into model retry backoff',async()=>{
    const controller=new AbortController();let retrySignal:AbortSignal|undefined;
    const {faux,options}=await fixture({signal:controller.signal,maxTurns:5,modelPolicy:{onResponse:async()=>{},retry:async signal=>{
      retrySignal=signal;controller.abort('pause');return false;
    }}});
    faux.setResponses([fauxAssistantMessage('',{stopReason:'error',errorMessage:'Connection error.'})]);
    const runner=await AgentRunner.create(options);
    try{await runner.prompt('retry');expect(retrySignal?.aborted).toBe(true);expect(faux.state.callCount).toBe(1);}finally{await runner.dispose();}
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
