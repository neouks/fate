import { setTimeout as delay } from "node:timers/promises";
// 拦截审批门：把 InterceptStore 的规则引擎接到 agent 工具调用前（等价 Go guard.applyIntercept）。
// 顺序：工具不在拦截范围 → 放行；规则匹配 allow → 放行；deny → block；
// ask → 落 intercept_pending 并轮询人工决定（allow → 放行，deny/超时 → block）。
// 规则未命中 → 放行（LLM Judge 裁决延后接线，见 README 延后项）。

import type { Database } from "../db/index.js";
import { Interceptor } from "../db/intercept.js";
import type { ToolGuard } from "../pi/runner.js";

/** 每个进程一个 Interceptor（规则缓存跨 run 复用；DB 变更由 invalidate 失效——路由层调用）。 */
const interceptors = new WeakMap<Database, Interceptor>();
export function interceptorFor(db: Database): Interceptor {
  let ic = interceptors.get(db);
  if (!ic) {
    ic = new Interceptor(db);
    interceptors.set(db, ic);
  }
  return ic;
}

const ASK_POLL_MS = 1000;
const ASK_TIMEOUT_MS = 10 * 60_000;

export interface GateContext {
  taskID?: number;
  agentName: string;
  worker?: string;
}

export function interceptGate(db: Database, ctx: GateContext): ToolGuard {
  return async ({ toolName, args, signal }) => {
    signal?.throwIfAborted();
    const ic = interceptorFor(db);
    if (!(await ic.isToolEnabled(toolName))) return undefined;

    const input = typeof args === "string" ? args : JSON.stringify(args ?? {});
    const decision = await ic.match(toolName, input);
    if (!decision) return undefined; // 未命中规则 → 放行（Judge 延后）
    if (decision.action === "allow") return undefined;
    if (decision.action === "deny") {
      return { block: true, reason: `【SERIES 平台管控·非目标防御】拦截规则「${decision.ruleName}」拒绝该操作：${decision.message}` };
    }

    // ask：落 pending，轮询人工决定
    const pending = await db.interceptStore().createInterceptPending({
      ruleID: decision.ruleID,
      convID: 0,
      taskID: ctx.taskID !== undefined ? String(ctx.taskID) : "",
      agentName: ctx.worker ?? ctx.agentName,
      toolName,
      input: args,
      reason: decision.message,
      audit: null,
    });
    const timeoutMs = decision.timeoutEnabled && decision.timeoutSeconds > 0 ? decision.timeoutSeconds * 1000 : ASK_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { await delay(ASK_POLL_MS, undefined, { signal }); }
      catch {
        await db.interceptStore().decideInterceptPending(pending, "denied").catch(() => undefined);
        return { block: true, reason: "执行已取消，待审批操作未执行。" };
      }
      const row = await db.query<{ status: string }>(`SELECT status FROM intercept_pending WHERE id=$1`, [pending]);
      const status = row.rows[0]?.status;
      if (status === "allowed") return undefined;
      if (status === "denied") {
        return { block: true, reason: `【SERIES 平台管控·非目标防御】人工审批拒绝了该操作。跳过此操作，不要原样重试。` };
      }
      if (status === "timeout") {
        return { block: true, reason: `【SERIES 平台管控·非目标防御】审批等待超时，操作未执行。` };
      }
    }
    await db.interceptStore().decideInterceptPending(pending, "timeout").catch(() => undefined);
    if (decision.timeoutAction === "allow") return undefined;
    return { block: true, reason: `【SERIES 平台管控·非目标防御】审批等待超时，操作未执行。` };
  };
}
