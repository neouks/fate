// 领域工具定义 helper：JSON Schema 字面量 → pi ToolDefinition。
// 统一负责：输出 clamp（有界 JSON）、错误 → isError 工具结果（模型可消化）、
// 只读/幂等标注。轻量化：不做 detailWindow 续读协议，超长输出直接截断并提示
// 用更窄的查询重试。

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolRunContext } from "./context.js";

export const MAX_TOOL_OUTPUT = 24_000;

export function clampOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  return (
    text.slice(0, MAX_TOOL_OUTPUT) +
    `\n[输出超出 ${MAX_TOOL_OUTPUT} 字符被截断；请缩小查询范围（更具体的 id/更窄的关键词/分页）后重试]`
  );
}

export interface DomainToolSpec<T> {
  name: string;
  description: string;
  /** 一句话工具清单摘要（进 system prompt 的 Available tools 段）。 */
  promptSnippet?: string;
  /** JSON Schema（对象类型，properties/required）。 */
  parameters: Record<string, unknown>;
  readOnly?: boolean;
  idempotent?: boolean;
  /** 返回 string 原样输出；对象则 JSON 序列化（经 clamp）。 */
  run: (args: T, ctx: ToolRunContext) => Promise<string | Record<string, unknown>>;
}

export function domainTool<T>(spec: DomainToolSpec<T>, ctx: ToolRunContext) {
  return defineTool({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    promptSnippet: spec.promptSnippet,
    parameters: spec.parameters as never,
    annotations: {
      readOnlyHint: spec.readOnly === true,
      idempotentHint: spec.idempotent === true,
    },
    async execute(_toolCallId: string, params: T) {
      try {
        const out = await spec.run(params, ctx);
        const text = typeof out === "string" ? out : JSON.stringify(out, null, 1);
        return { content: [{ type: "text" as const, text: clampOutput(text) }], details: undefined };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `工具执行失败: ${msg}` }],
          isError: true,
          details: undefined,
        };
      }
    },
  });
}
