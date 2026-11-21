import { tokenBreakdown } from "./token-usage";
import type { ModelTokenStat, TokenTotal } from "./types";

export interface SessionUsage {
  total: TokenTotal;
  models: ModelTokenStat[];
  context: {
    tokens: number | null;
    model: string | null;
    profile_id: number | null;
    at: string | null;
    capacity?: number | null;
    state?: "empty" | "pending" | "compacted" | "recorded" | "unavailable";
  };
}
export type ModelRates = { input: string; output: string; cacheRead: string; cacheWrite: string };
export const emptyRates: ModelRates = { input: "", output: "", cacheRead: "", cacheWrite: "" };
export function rate(value: string): number | null {
  if (!value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
/** Cache is disjoint from uncached input. Missing prices/usage stay unknown. */
export function estimateCost(usage: TokenTotal, prices: ModelRates | undefined): number | null {
  if (!prices || usage.usage_complete === false) return null;
  const t = tokenBreakdown(usage);
  const pairs = [
    [t.uncached, prices.input],
    [t.output, prices.output],
    [t.cacheRead, prices.cacheRead],
    [t.cacheWrite, prices.cacheWrite],
  ] as const;
  let sum = 0;
  for (const [tokens, price] of pairs) {
    if (tokens === null) return null;
    if (tokens === 0) continue;
    const p = rate(price);
    if (p === null) return null;
    sum += (tokens * p) / 1_000_000;
  }
  return sum;
}
/** Local text heuristic; Chinese and other non-ASCII text use a separate weight. */
export function estimateDraftTokens(text: string): number {
  const chars = Array.from(text);
  const nonAscii = chars.filter((c) => (c.codePointAt(0) ?? 0) > 127).length;
  return Math.ceil((chars.length - nonAscii) / 4 + nonAscii * 1.5);
}
export function compactNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
export function formatUSD(value: number | null): string {
  return value === null ? "未估算" : `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

/** Normalize transport errors without exposing server internals in the composer. */
export function sessionRequestError(error: unknown, feature: string): string {
  const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
  const message = error instanceof Error ? error.message : "";
  if (status === 404 && /^(not found|.*route.*not found)$/i.test(message)) {
    return `当前服务尚未提供${feature}接口，请更新并重启后端后重试。`;
  }
  if (status === 404) return `${feature}不可用：任务、会话或模型配置已不存在，请刷新页面。`;
  if (status === 400) return `${feature}请求无效，请刷新页面后重试。`;
  if (status === 401 || status === 403) return `${feature}访问被拒绝，请重新登录。`;
  if (status === 409) return message || `${feature}暂时忙碌，请稍后重试。`;
  return `${feature}读取或保存失败，请检查服务连接后重试。`;
}
