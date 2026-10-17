import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AgentRunner } from "../pi/runner.js";
import { describe,it,expect,afterEach } from "vitest";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { customWorkerTools,renderToolTemplate,shellQuote } from "./custom.js";
import { runContext } from "./context.js";
import type { Database } from "../db/index.js";
const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
async function fixture(kind:string,exec:Record<string,unknown>,guard?:Parameters<typeof customWorkerTools>[3]) {
 const cwd=mkdtempSync(path.join(tmpdir(),"fate-custom-"));dirs.push(cwd);
 const db={ platform:()=>({listTools:async()=>[{key:"fixture",kind,exec,schema:{type:"object",properties:{value:{type:"string"}},required:["value"]},description:"fixture",agents:["worker"],enabled:true,system:false}]} )} as unknown as Database;
 return (await customWorkerTools(runContext(db,1,1,"worker"),cwd,undefined,guard))[0]!;
}
async function executeNative(tool: ToolDefinition, value: string): Promise<string> {
 const faux=fauxProvider();const modelRuntime=await ModelRuntime.create({refreshOnCreate:false});await modelRuntime.registerNativeProvider(faux.provider);
 faux.setResponses([fauxAssistantMessage([fauxToolCall(tool.name,{value})]),fauxAssistantMessage("done")]);
 let output="";
 const runner=await AgentRunner.create({cwd:dirs[dirs.length-1]!,agentDir:path.join(dirs[dirs.length-1]!,"agent"),modelRuntime,model:faux.getModel() as never,inMemory:true,
 customTools:[tool],toolAllowlist:[tool.name],onActivity:(a)=>{if(a.kind==="tool_end") {expect(a.isError).toBe(false);output=a.text??"";}}});
 try {await runner.prompt("run fixture");return output;} finally {await runner.dispose();}
}
describe("custom tool native execution",()=>{
 it("quotes substituted shell metacharacters and preserves the original value",async()=>{
  const value="hello ' $(printf bad) ; echo wrong";
  const tool=await fixture("command",{command:"printf %s {value}"});
  expect(await executeNative(tool,value)).toBe(value);
 });
 it("executes scripts with JSON on stdin",async()=>{
  const tool=await fixture("script",{code:"import sys,json; print(json.load(sys.stdin)['value'])"});
  expect(await executeNative(tool,"native custom script")).toContain("native custom script");
 });
 it("applies approvals to the rendered command, before execution",async()=>{
  let expanded="";
  const tool=await fixture("command",{command:"printf %s {value}"},g=>{expanded=String(g.args.command);return {block:true,reason:"denied"};});
  await expect(tool.execute("id",{value:"secret"},undefined,undefined,{} as never)).rejects.toThrow("denied");
  expect(expanded).toBe("printf %s 'secret'");
 });
 it("rejects missing template values",()=>{
  expect(()=>renderToolTemplate("echo {missing}",{},shellQuote)).toThrow("missing");
 });
});
