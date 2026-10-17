// 拦截审批路由：规则列表/CRUD/开关 + pending 列表 + 人工 decide（原子结算，重复 → 409）+
// 历史（分页+filter）/详情（audit）/原始执行对 + 任务内过滤 + 全局工具拦截白名单。
// 规则 CRUD 后调 app.interceptor.invalidate() 使匹配缓存重载。
// decide 成功后经 app.pendingEvents 广播——TODO(M6)：等待中的 HandleAsk（审批门）订阅该通道唤醒。

import type { FastifyInstance, FastifyReply } from "fastify";
import {
  InterceptAlreadyDecidedError,
  compileInterceptRegex,
  type InterceptApprovalRow,
  type InterceptPending,
  type InterceptRule,
  type RuleInput,
} from "../../db/intercept.js";

function ruleDTO(r: InterceptRule): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    priority: r.priority,
    match_target: r.matchTarget,
    match_type: r.matchType,
    pattern: r.pattern,
    action: r.action,
    message: r.message,
    timeout_enabled: r.timeoutEnabled,
    timeout_seconds: r.timeoutSeconds,
    timeout_action: r.timeoutAction,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

function pendingDTO(p: InterceptPending): Record<string, unknown> {
  return {
    id: p.id,
    rule_id: p.ruleID,
    conversation_id: p.conversationID,
    task_id: p.taskID,
    agent_name: p.agentName,
    tool_name: p.toolName,
    tool_input: p.toolInput,
    status: p.status,
    decision_source: p.decisionSource,
    reason: p.reason,
    decided_at: p.decidedAt,
    created_at: p.createdAt,
  };
}

function approvalDTO(r: InterceptApprovalRow): Record<string, unknown> {
  return {
    ...pendingDTO(r),
    conv_title: r.convTitle,
    conv_agent_key: r.convAgentKey,
    rule_name: r.ruleName,
  };
}

/** 历史查询的展示上限（listAllIntercepts 需要 limit；过滤/分页在内存做）。 */
const HISTORY_FETCH_LIMIT = 50_000;

const VALID_STATUS = new Set(["pending", "allowed", "denied", "timeout"]);
const VALID_DECISION_SOURCE = new Set(["rule", "model", "unknown"]);

/** page/size/status/decision_source 解析；非法值 400。 */
function pageQuery(req: { query?: unknown }, reply: FastifyReply): { page: number; size: number; offset: number } | null {
  const q = req.query as Record<string, unknown>;
  const status = typeof q["status"] === "string" ? q["status"] : "";
  const source = typeof q["decision_source"] === "string" ? q["decision_source"] : "";
  if (status !== "" && !VALID_STATUS.has(status)) {
    void reply.code(400).send({ error: "无效审批状态" });
    return null;
  }
  if (source !== "" && !VALID_DECISION_SOURCE.has(source)) {
    void reply.code(400).send({ error: "无效判定来源" });
    return null;
  }
  const page = Math.max(1, Number(q["page"]) || 1);
  const size = Math.min(100, Math.max(1, Number(q["size"]) || 20));
  return { page, size, offset: (page - 1) * size };
}

function filterApprovalRows(rows: InterceptApprovalRow[], req: { query?: unknown }): InterceptApprovalRow[] {
  const q = req.query as Record<string, unknown>;
  const status = typeof q["status"] === "string" ? q["status"] : "";
  const source = typeof q["decision_source"] === "string" ? q["decision_source"] : "";
  return rows.filter(
    (r) => (status === "" || r.status === status) && (source === "" || r.decisionSource === source),
  );
}

/** 规则请求体（前端 snake_case 契约）→ RuleInput；非法值 null。 */
function parseRuleInput(body: unknown): RuleInput | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b["name"] === "string" ? b["name"].trim() : "";
  const matchTarget = typeof b["match_target"] === "string" ? b["match_target"] : "";
  const matchType = typeof b["match_type"] === "string" ? b["match_type"] : "";
  const pattern = typeof b["pattern"] === "string" ? b["pattern"] : "";
  const action = typeof b["action"] === "string" ? b["action"] : "";
  const timeoutAction = typeof b["timeout_action"] === "string" ? b["timeout_action"] : "deny";
  if (name === "") return { error: "规则名称不能为空" };
  if (matchTarget !== "tool_name" && matchTarget !== "tool_input") return { error: "match_target 必须是 tool_name|tool_input" };
  if (matchType !== "string" && matchType !== "regex") return { error: "match_type 必须是 string|regex" };
  if (action !== "allow" && action !== "deny" && action !== "ask") return { error: "action 必须是 allow|deny|ask" };
  if (timeoutAction !== "deny" && timeoutAction !== "allow") return { error: "timeout_action 必须是 deny|allow" };
  if (pattern === "") return { error: "pattern 不能为空" };
  if (matchType === "regex" && compileInterceptRegex(pattern) === null) return { error: `无效正则: ${pattern}` };
  return {
    name,
    matchTarget,
    matchType,
    pattern,
    action,
    message: typeof b["message"] === "string" ? b["message"] : "",
    priority: Math.trunc(Number(b["priority"]) || 0),
    enabled: b["enabled"] !== false,
    timeoutEnabled: b["timeout_enabled"] === true,
    timeoutSeconds: Math.max(0, Math.trunc(Number(b["timeout_seconds"]) || 0)),
    timeoutAction,
  };
}

/** activity 行 → 前端 Activity 面（与 compat.ts mapActivity 同形）。 */
function activityDTO(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    seq: Number(r["id"]),
    worker: String(r["worker"] ?? ""),
    ts: r["created_at"] instanceof Date ? (r["created_at"] as Date).toISOString() : String(r["created_at"] ?? ""),
    kind: String(r["kind"] ?? ""),
    summary: String(r["summary"] ?? ""),
    is_error: r["is_error"] === true,
  };
  if (r["node_id"] !== null && r["node_id"] !== undefined) out["intent_id"] = String(r["node_id"]);
  if (r["tool"]) out["tool"] = r["tool"];
  if (r["tool_use_id"]) out["tool_use_id"] = r["tool_use_id"];
  if (r["main_seg"] !== null && r["main_seg"] !== undefined) out["main_seg"] = Number(r["main_seg"]);
  if (r["detail"] !== null && r["detail"] !== undefined) out["detail"] = r["detail"];
  return out;
}

export function registerInterceptRoutes(app: FastifyInstance): void {
  const store = () => app.db.interceptStore();
  const db = () => app.db;

  // ─── 规则 CRUD（B2）───────────────────────────────────────────────────────

  app.get("/api/intercept/rules", async () => {
    const rules = await store().listInterceptRules();
    return { rules: rules.map(ruleDTO) };
  });

  app.post("/api/intercept/rules", async (req, reply) => {
    const input = parseRuleInput(req.body);
    if ("error" in input) return reply.code(400).send({ error: input.error });
    const rule = await store().createInterceptRule(input);
    app.interceptor.invalidate(); // CRUD 后失效匹配缓存（下次 match 重载）
    return reply.code(201).send(ruleDTO(rule));
  });

  app.put("/api/intercept/rules/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const input = parseRuleInput(req.body);
    if ("error" in input) return reply.code(400).send({ error: input.error });
    const rule = await store().updateInterceptRule(id, input);
    if (!rule) return reply.code(404).send({ error: "拦截规则不存在" });
    app.interceptor.invalidate();
    return ruleDTO(rule);
  });

  app.delete("/api/intercept/rules/:id", async (req) => {
    const id = Number((req.params as { id: string }).id);
    await store().deleteInterceptRule(id);
    app.interceptor.invalidate();
    return { deleted: 1 };
  });

  app.post("/api/intercept/rules/:id/toggle", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const enabled = (req.body as { enabled?: unknown } | undefined)?.["enabled"];
    if (typeof enabled !== "boolean") return reply.code(400).send({ error: "enabled 必须是布尔值" });
    const cur = await store().listInterceptRules();
    if (!cur.some((r) => r.id === id)) return reply.code(404).send({ error: "拦截规则不存在" });
    await store().toggleInterceptRule(id, enabled);
    app.interceptor.invalidate();
    return { ok: true, enabled };
  });

  // ─── pending 与人工 decide ────────────────────────────────────────────────

  app.get("/api/intercept/pending", async (req) => {
    const q = req.query as Record<string, unknown>;
    const task = typeof q["task"] === "string" ? q["task"] : "";
    const pending = await store().listPendingIntercepts(task);
    return { pending: pending.map(pendingDTO) };
  });

  app.get("/api/intercept/pending/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const p = await store().getInterceptPending(id);
    if (!p) return reply.code(404).send({ error: "审批记录不存在" });
    return pendingDTO(p);
  });

  app.post("/api/intercept/pending/:id/decide", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const decision = (req.body as { decision?: unknown })?.["decision"];
    if (decision !== "allowed" && decision !== "denied") {
      return reply.code(400).send({ error: "decision 必须是 allowed|denied" });
    }
    try {
      await app.interceptor.decide(id, decision === "allowed");
    } catch (err) {
      if (err instanceof InterceptAlreadyDecidedError) return reply.code(409).send({ error: err.message });
      throw err;
    }
    // TODO(M6)：审批门（HandleAsk）阻塞等待处订阅该事件唤醒；当前为进程内广播占位。
    app.pendingEvents.emit(`decided:${id}`, { id, allowed: decision === "allowed" });
    return { ok: true };
  });

  // ─── 历史（分页+filter）/ 详情（audit）/ 原始执行对（B2）─────────────────

  app.get("/api/intercept/history", async (req, reply) => {
    const pq = pageQuery(req, reply);
    if (!pq) return reply;
    const rows = await store().listAllIntercepts(HISTORY_FETCH_LIMIT);
    const filtered = filterApprovalRows(rows, req);
    const q = req.query as Record<string, unknown>;
    if (q["page"] === undefined && q["size"] === undefined && q["status"] === undefined && q["decision_source"] === undefined) {
      return { items: filtered.map(approvalDTO), total: filtered.length };
    }
    return {
      items: filtered.slice(pq.offset, pq.offset + pq.size).map(approvalDTO),
      total: filtered.length,
      page: pq.page,
      page_size: pq.size,
    };
  });

  app.get("/api/intercept/history/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const detail = await store().getInterceptDetail(id);
    if (!detail) return reply.code(404).send({ error: "审批记录不存在" });
    return { ...approvalDTO(detail), audit: detail.audit };
  });

  // 原始执行：audit 里 (run_id, tool_use_id) 关联的 activity tool_use/tool_result 对。
  app.get("/api/intercept/history/:id/execution", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const q = req.query as Record<string, unknown>;
    const detail = await store().getInterceptDetail(id);
    const audit = detail?.audit;
    if (!detail || !audit?.run_id || !audit.tool_use_id) {
      return reply.code(404).send({ error: "原始执行不存在或不可访问" });
    }
    if (q["conversation"] !== undefined) {
      return reply.code(404).send({ error: "原始执行不存在或不可访问" });
    }
    const head = await db().query<{ id: string; node_id: string | null; worker: string | null; main_seg: number | null }>(
      `SELECT id, node_id, worker, main_seg FROM activity
       WHERE tool_use_id=$1 AND kind='tool_use' ORDER BY id LIMIT 1`,
      [audit.tool_use_id],
    );
    const headRow = head.rows[0];
    if (!headRow) return reply.code(404).send({ error: "原始执行不存在或不可访问" });
    const pair = await db().query(
      `SELECT id, node_id, worker, kind, tool, tool_use_id, is_error, summary, detail, main_seg, created_at
       FROM activity WHERE tool_use_id=$1 AND kind IN ('tool_use','tool_result') ORDER BY id`,
      [audit.tool_use_id],
    );
    const nodeID = headRow.node_id !== null ? Number(headRow.node_id) : null;
    const session =
      nodeID !== null
        ? `intent:${nodeID}`
        : headRow.worker === "planner"
          ? "plan"
          : `main:${headRow.main_seg ?? 0}`;
    return {
      conversation_id: detail.conversationID,
      task_id: detail.taskID,
      session,
      seq: Number(headRow.id),
      items: pair.rows.map((r) => activityDTO(r as Record<string, unknown>)),
    };
  });

  app.get("/api/intercept/task/:taskID", async (req, reply) => {
    const taskID = decodeURIComponent((req.params as { taskID: string }).taskID);
    const pq = pageQuery(req, reply);
    if (!pq) return reply;
    const rows = await store().listTaskIntercepts(taskID);
    const filtered = filterApprovalRows(rows, req);
    const q = req.query as Record<string, unknown>;
    if (q["page"] === undefined && q["size"] === undefined && q["status"] === undefined && q["decision_source"] === undefined) {
      return { items: filtered.map(approvalDTO), total: filtered.length };
    }
    return {
      items: filtered.slice(pq.offset, pq.offset + pq.size).map(approvalDTO),
      total: filtered.length,
      page: pq.page,
      page_size: pq.size,
    };
  });

  // ─── 全局工具拦截白名单（settings.intercept_enabled_tools）───────────────

  app.get("/api/intercept/tool-config", async () => {
    return { enabled_tools: await app.interceptor.getEnabledTools() };
  });

  app.put("/api/intercept/tool-config", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(b["enabled_tools"]) || b["enabled_tools"].some((t) => typeof t !== "string")) {
      return reply.code(400).send({ error: "enabled_tools 必须是字符串数组" });
    }
    const tools = (b["enabled_tools"] as unknown[]).map(String);
    await app.interceptor.setEnabledTools(tools); // 持久化 settings + 失效缓存
    return { ok: true, enabled_tools: tools };
  });
}
