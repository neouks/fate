// LLM profile → pi-ai provider/model 构造（index.ts 的模型解析器与 /api/llm/test 共享）。

import { createProvider } from "@earendil-works/pi-ai";
import * as anthropic from "@earendil-works/pi-ai/api/anthropic-messages";
import * as openaiResponses from "@earendil-works/pi-ai/api/openai-responses";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelSource } from "../agent/roles.js";

export interface ProfileLike {
  id: number;
  name: string;
  model: string;
  baseURL: string;
  apiKey: string;
  contextWindowK: number;
  maxTokens: number;
  thinkingType?: string;
  reasoningEffort?: string;
  format?: string;
}

export function buildModelSource(profile: ProfileLike): Promise<ModelSource> {
  const api = profile.format === "anthropic" ? "anthropic-messages" : profile.format === "openai-responses" ? "openai-responses" : "openai-completions";
  if (profile.format && !["openai", "anthropic", "openai-responses"].includes(profile.format)) throw new Error(`不支持的 LLM 协议：${profile.format}`);
  const effort = profile.reasoningEffort || profile.thinkingType || "off";
  const thinkingLevel = (["off", "minimal", "low", "medium", "high", "xhigh"].includes(effort) ? effort : effort === "disabled" ? "off" : "medium") as ModelSource["thinkingLevel"];
  const providerId = `series-p${profile.id}`;
  const contextWindow = profile.contextWindowK > 0 ? profile.contextWindowK * 1000 : 128_000;
  const model = {
    id: profile.model,
    name: profile.name !== "" ? profile.name : profile.model,
    api,
    provider: providerId,
    baseUrl: profile.baseURL,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: profile.maxTokens > 0 ? profile.maxTokens : 8192,
    // 思考档位：profile.thinking_type 非空即启用（pi 统一档位映射到 provider 原生参数）。
    reasoning: thinkingLevel !== "off",
  } as Record<string, unknown>;
  const provider = createProvider({
    id: providerId,
    name: profile.name !== "" ? profile.name : providerId,
    baseUrl: profile.baseURL,
    auth: {
      apiKey: {
        name: `SERIES_PROFILE_${profile.id}_KEY`,
        resolve: async () => ({ auth: { apiKey: profile.apiKey } }),
      },
    },
    models: [model as never],
    api: { [api]: (api === "anthropic-messages" ? anthropic : api === "openai-responses" ? openaiResponses : openaiCompletions) as never },
  });
  return (async () => {
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    await modelRuntime.registerNativeProvider(provider as never);
    return { modelRuntime, model: model as never, thinkingLevel } satisfies ModelSource;
  })();
}

/** 一次最小补全用于测试连接：返回 {ok, latency_ms, model, reply, error}。 */
export async function testProfileConnection(
  profile: ProfileLike,
): Promise<{ ok: boolean; latency_ms: number; model: string; reply?: string; error?: string }> {
  const start = Date.now();
  try {
    const source = await buildModelSource(profile);
    const models = source.modelRuntime as unknown as { completeSimple: (model: unknown, context: unknown, options?: unknown) => Promise<{ content?: Array<{ type: string; text?: string }> }> };
    const result = await models.completeSimple(
      source.model,
      { systemPrompt: "You are a connectivity probe. Reply with the single word: pong", messages: [{ role: "user", content: "ping" }] },
      { maxTokens: 512 },
    );
    const reply = (result.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
    return { ok: true, latency_ms: Date.now() - start, model: profile.model, reply };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - start, model: profile.model, error: err instanceof Error ? err.message : String(err) };
  }
}
