import { defineTool, createBashToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
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

/** Custom tools enter the same pi tool pipeline and approval gate as native tools. */
export async function customWorkerTools(ctx: ToolRunContext, cwd: string, bash?: ToolDefinition, guard?: ToolGuard): Promise<ToolDefinition[]> {
  if (ctx.role !== "worker") return [];
  const catalog = await ctx.db.platform().listTools();
  const reserved = new Set(catalog.filter((t) => t.system || t.kind === "builtin").map((t) => t.key));
  const shell = bash ?? createBashToolDefinition(cwd) as unknown as ToolDefinition;
  return catalog.filter((t) => t.enabled && t.agents.includes(ctx.role) && !t.system && t.kind !== "builtin" && !reserved.has(t.key))
    .map((tool) => defineTool({
      name: tool.key, label: tool.key, description: tool.description,
      parameters: (Object.keys(tool.schema).length ? tool.schema : { type: "object", properties: { args: { type: "string" } } }) as never,
      async execute(callID: string, args: Record<string, unknown>, signal, update, extensionContext) {
        const spec = tool.exec;
        const timeout = Math.min(Math.max(Number(spec["timeout_ms"]) || 30_000, 100), 300_000);
        const check = async (toolName: string, input: Record<string, unknown>) => {
          signal?.throwIfAborted();
          const decision = await guard?.({ toolName, toolCallId: callID, args: input });
          if (decision?.block) throw new Error(decision.reason ?? "工具执行被审批拦截");
        };
        if (tool.kind === "http") {
          let url = renderToolTemplate(String(spec["url"] ?? ""), args);
          const headers = Object.fromEntries(Object.entries((spec["headers"] ?? {}) as Record<string, string>).map(([k,v]) => [k, renderToolTemplate(String(v), args)]));
          let method = String(spec["method"] ?? "GET").toUpperCase();
          let body = spec["body"] === undefined || spec["body"] === "" ? undefined : renderToolTemplate(typeof spec["body"] === "string" ? spec["body"] : JSON.stringify(spec["body"]), args);
          const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
          for (let redirects = 0; redirects < 6; redirects++) {
            await ctx.db.taskScope().validateWorkerHosts(ctx.taskID, [url]);
            await check(tool.key, { ...args, url, method, body });
            const response = await fetch(url, { method, headers, body, signal: combined, redirect: "manual" });
            const location = response.headers.get("location");
            if ([301,302,303,307,308].includes(response.status) && location) {
              await response.body?.cancel();
              const next = new URL(location, url);
              if (next.origin !== new URL(url).origin) {
                for (const key of Object.keys(headers)) if (["authorization", "cookie", "proxy-authorization"].includes(key.toLowerCase())) delete headers[key];
              }
              if (response.status === 303 || ([301,302].includes(response.status) && method === "POST")) { method = "GET"; body = undefined; }
              url = next.href; continue;
            }
            const reader = response.body?.getReader();
            let text = "", bytes = 0;
            const decoder = new TextDecoder();
            try {
              while (reader && bytes < 24_000) {
                const chunk = await reader.read(); if (chunk.done) break;
                const part = chunk.value.subarray(0, 24_000 - bytes); bytes += part.length; text += decoder.decode(part, { stream: true });
              }
              text += decoder.decode();
            } finally { await reader?.cancel(); }
            return { content: [{ type: "text" as const, text: clampOutput(`HTTP ${response.status}\n${text}`) }], isError: !response.ok, details: undefined };
          }
          throw new Error("HTTP 重定向次数超限");
        }
        let command: string;
        if (tool.kind === "script") {
          const code = String(spec["code"] ?? "");
          if (!code.trim()) throw new Error("脚本 code 为空");
          command = `printf %s ${shellQuote(JSON.stringify(args))} | python3 -c ${shellQuote(code)}`;
        } else if (tool.kind === "shell" && tool.executable) {
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
