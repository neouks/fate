import {pythonInterpreter,runProgram,configuredBash} from '../config/execution.js';
import {evidenceRequest} from "../evidence/http.js";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRunContext } from "./context.js";
import type { ToolGuard } from "../pi/runner.js";
import { clampOutput } from "./define.js";

export function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
export function renderToolTemplate(template: string, args: Record<string, unknown>, quote = (s: string) => s): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) => {
    if (!(key in args)) throw new Error(`缺少模板参数 ${key}`);
    const v = args[key];
    return quote(typeof v === "string" ? v : JSON.stringify(v));
  });
}

/** Share eligibility with planning; loading this catalog does not execute tools. */
export async function boundCustomTools(db: import('../db/index.js').Database, role: string) {
  if (!["worker", "planner", "mainagent", "pentest"].includes(role)) return [];
  const catalog = await db.platform().listTools();
  const reserved = new Set(catalog.filter(t => t.system || t.kind === 'builtin').map(t => t.key));
  return catalog.filter(t => t.enabled && t.agents.includes(role) && !t.system && t.kind !== 'builtin' && t.kind !== 'shell' && !reserved.has(t.key));
}

/** Custom tools enter the same pi tool pipeline and execution lifecycle as native tools. */
export async function customWorkerTools(ctx: ToolRunContext, cwd: string, bash?: ToolDefinition, guard?: ToolGuard,executionEnv?:Record<string,string>): Promise<ToolDefinition[]> {
  const catalog = await boundCustomTools(ctx.db, ctx.role);
  if (!catalog.length) return [];
  const env=executionEnv??Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined));
  const shell = bash ?? await configuredBash(ctx.db,cwd,env);
  return catalog
    .map((tool) => defineTool({
      name: tool.key, label: tool.key, description: tool.description,
      parameters: (Object.keys(tool.schema).length ? tool.schema : { type: "object", properties: { args: { type: "string" } } }) as never,
      async execute(callID: string, args: Record<string, unknown>, signal, update, extensionContext) {
        const spec = tool.exec;
        const timeout = Math.min(Math.max(Number(spec["timeout_ms"]) || 30_000, 100), 300_000);
        const check = async (toolName: string, input: Record<string, unknown>) => {
          signal?.throwIfAborted();
          const decision = await guard?.({ toolName, toolCallId: callID, args: input, signal });
          if (decision?.block) throw new Error(decision.reason ?? "当前执行已停止");
        };
        if (tool.kind === "http") {
          let url = renderToolTemplate(String(spec["url"] ?? ""), args);
          const headers = Object.fromEntries(Object.entries((spec["headers"] ?? {}) as Record<string, string>).map(([k,v]) => [k, renderToolTemplate(String(v), args)]));
          let method = String(spec["method"] ?? "GET").toUpperCase();
          let body = spec["body"] === undefined || spec["body"] === "" ? undefined : renderToolTemplate(typeof spec["body"] === "string" ? spec["body"] : JSON.stringify(spec["body"]), args);
          const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
          const result=await evidenceRequest(ctx,{url,method,headers,body},combined,input=>check(tool.key,{...args,...input}));
          return {content:[{type:'text' as const,text:clampOutput(JSON.stringify(result))}],isError:result.status>=400,details:undefined};
        }
        let command: string;
        if (tool.kind === "script") {
          const code = String(spec["code"] ?? "");
          if (!code.trim()) throw new Error("脚本 code 为空");
          await check('bash',{custom_tool:tool.key});
          const python=pythonInterpreter(await ctx.db.platform().getSetting('python_interpreter')??'');
          const result=await runProgram(python,['-c',code],{cwd,env,signal,timeoutMs:timeout,input:JSON.stringify(args)});
          return {content:[{type:'text' as const,text:clampOutput(result.output)}],isError:result.exitCode!==0,details:undefined};
        } else if (tool.kind === "command" && spec["legacy_shell_args"] === true && tool.executable) {
          // Executable is configured by the operator; model supplies an argument string.
          command = `${shellQuote(tool.executable)} ${String(args["args"] ?? "")}`;
        } else {
          command = renderToolTemplate(String(spec["command"] ?? ""), args, shellQuote);
          if (Array.isArray(spec["args"])) command += " " + spec["args"].map((v) => shellQuote(renderToolTemplate(String(v), args))).join(" ");
        }
        if (!command.trim()) throw new Error("自定义工具 command 为空");
        await check("bash", { command, custom_tool: tool.key });
        return shell.execute(callID, { command, timeout: timeout / 1000 }, signal, update, extensionContext);
      },
    }) as unknown as ToolDefinition);
}
