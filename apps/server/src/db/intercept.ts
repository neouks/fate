// 拦截审批 store：规则 CRUD + 缓存匹配引擎、pending 创建/列表、Decide→ResolveIntercept
// 原子结算、CompleteIntercept 精确收尾、审计 JSONB merge。
// 平移自 Go 版 db/intercept.go + db/intercept_detail.go + intercept/intercept.go 的
// loadLocked/Match/IsToolEnabled/SetEnabledTools/Decide 核心。LLM Judge（Reviewer）不在此层，M4 接线。

import { createHash } from "node:crypto";
import type { Database } from "./index.js";
import { jsonbClean } from "./exploration.js";
import {
  PlatformStore,
  SETTING_INTERCEPT_ENABLED_TOOLS,
  DEFAULT_INTERCEPT_ENABLED_TOOLS,
} from "./platform.js";

// ─── 类型（db/intercept.go / intercept_detail.go）────────────────────────────

/** intercept_rules 一行。 */
export interface InterceptRule {
  id: number;
  name: string;
  enabled: boolean;
  priority: number;
  matchTarget: string; // tool_name | tool_input
  matchType: string; // string | regex
  pattern: string;
  action: string; // allow | deny | ask
  message: string;
  timeoutEnabled: boolean;
  timeoutSeconds: number;
  timeoutAction: string; // deny | allow
  createdAt: string;
  updatedAt: string;
}

/** 审查时捕获的有界会话事件（非模型推理）。 */
export interface InterceptContextEntry {
  kind: string;
  tool?: string;
  tool_use_id?: string;
  text: string;
  is_error?: boolean;
  truncated?: boolean;
}

/** 审批审计载荷；在审查时捕获，列表/轮询响应不含它（旧行无审计而非重构数据）。 */
export interface InterceptAudit {
  run_id?: string;
  tool_use_id?: string;
  correlation: string; // exact | ambiguous | unavailable
  input_digest: string;
  user_message: string;
  user_truncated?: boolean;
  context: InterceptContextEntry[];
  context_truncated?: boolean;
  captured_at: string;
  model_fallback?: boolean;
  model_input?: unknown;
  model_input_digest?: string;
  initial_action: string;
  initial_reason: string;
  effective_action?: string;
  decision_reason?: string;
  rule_name?: string;
  config_digest?: string;
  profile_id?: number;
  execution_status: string;
  output?: string;
  output_truncated?: boolean;
  execution_ended_at?: string;
}

/** intercept_pending 一行。 */
export interface InterceptPending {
  id: number;
  ruleID: number | null;
  conversationID: number | null;
  taskID: string | null;
  agentName: string;
  toolName: string;
  toolInput: unknown;
  status: string; // pending | allowed | denied | timeout
  decisionSource: string;
  reason: string;
  decidedAt: string | null;
  createdAt: string;
}

/** intercept_pending 关联会话/规则信息的展示行。 */
export interface InterceptApprovalRow extends InterceptPending {
  convTitle: string;
  convAgentKey: string;
  ruleName: string;
}

export interface InterceptDetail extends InterceptApprovalRow {
  audit: InterceptAudit | null;
}

/** Match 的产出（intercept.Decision 的规则命中面；模型兜底字段随 M4 Reviewer 补）。 */
export interface InterceptDecision {
  ruleName: string;
  configDigest: string;
  action: string; // "allow" | "deny" | "ask"
  message: string;
  ruleID: number;
  timeoutEnabled: boolean;
  timeoutSeconds: number;
  timeoutAction: string;
}

/** 审批已处理或不存在（HTTP 409 语义；Go: ErrAlreadyDecided）。 */
export class InterceptAlreadyDecidedError extends Error {
  constructor() {
    super("审批已处理或不存在，请刷新记录");
    this.name = "InterceptAlreadyDecidedError";
  }
}

// ─── 正则预编译（RE2 → JS 方言桥接）──────────────────────────────────────────

/**
 * 规则正则预编译。种子/用户规则用 RE2 方言的 `(?i)` 内联旗标，JS RegExp 不认——
 * 这里把内联旗标组提升为 RegExp flags（i/m/s），其余不可映射（如 U 非贪婪反转）或
 * 非法模式返回 null（调用方跳过该规则而不是崩溃，对应 Go loadLocked 的 continue）。
 */
export function compileInterceptRegex(pattern: string): RegExp | null {
  let unsupported = false;
  let flags = "";
  const src = pattern.replace(/\(\?([a-zA-Z]+)\)/g, (_m: string, fl: string) => {
    if (![...fl].every((c) => c === "i" || c === "m" || c === "s")) {
      unsupported = true;
      return "";
    }
    for (const c of new Set(fl)) {
      if (!flags.includes(c)) flags += c;
    }
    return "";
  });
  if (unsupported) return null;
  try {
    return new RegExp(src, flags);
  } catch {
    return null;
  }
}

function digestInput(b: string): string {
  return createHash("sha256").update(b, "utf8").digest("hex");
}

// ─── 列清单（node-pg 按列名映射，计算列必须 AS 别名）────────────────────────

const RULE_COLS =
  `id, name, enabled, priority, match_target, match_type, pattern, action, message, ` +
  `timeout_enabled, timeout_seconds, timeout_action, created_at, updated_at`;

const PENDING_COLS =
  `id, rule_id, conversation_id, task_id, agent_name, tool_name, tool_input, status, ` +
  `reason, decided_at, created_at, decision_source`;

/** 旧行无 decision_source 时按展示来源补齐（Go approvalDecisionSource）。 */
const APPROVAL_DECISION_SOURCE = `COALESCE(NULLIF(ip.decision_source,''), CASE
  WHEN ip.rule_id IS NOT NULL THEN 'rule'
  WHEN ip.reason LIKE '[模型]%' THEN 'model' ELSE 'unknown' END) AS decision_source`;

const APPROVAL_ROW_COLUMNS =
  `ip.id, ip.rule_id, ip.conversation_id, ip.task_id, ip.agent_name,
   ip.tool_name, ip.tool_input, ip.status, ip.reason, ip.decided_at, ip.created_at,
   ${APPROVAL_DECISION_SOURCE},
   COALESCE(c.title,'') AS conv_title,
   COALESCE(c.agent_key,'') AS conv_agent_key,
   COALESCE(ir.name,'') AS rule_name`;

const APPROVAL_ROW_JOINS = `
   FROM intercept_pending ip
   LEFT JOIN conversations c ON c.id = ip.conversation_id
   LEFT JOIN intercept_rules ir ON ir.id = ip.rule_id`;

const APPROVAL_ROW_SELECT = `SELECT ${APPROVAL_ROW_COLUMNS}${APPROVAL_ROW_JOINS}`;
const APPROVAL_ROW_SELECT_WITH_AUDIT = `SELECT ${APPROVAL_ROW_COLUMNS}, ip.audit${APPROVAL_ROW_JOINS}`;

// ─── 规则输入 ────────────────────────────────────────────────────────────────

export interface RuleInput {
  name: string;
  matchTarget: string;
  matchType: string;
  pattern: string;
  action: string;
  message: string;
  priority: number;
  enabled: boolean;
  timeoutEnabled: boolean;
  timeoutSeconds: number;
  timeoutAction: string;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export class InterceptStore {
  constructor(private db: Database) {}

  private mapRule(row: Record<string, unknown>): InterceptRule {
    return {
      id: Number(row["id"]),
      name: String(row["name"]),
      enabled: row["enabled"] === true,
      priority: Number(row["priority"]),
      matchTarget: String(row["match_target"]),
      matchType: String(row["match_type"]),
      pattern: String(row["pattern"]),
      action: String(row["action"]),
      message: String(row["message"] ?? ""),
      timeoutEnabled: row["timeout_enabled"] === true,
      timeoutSeconds: Number(row["timeout_seconds"]),
      timeoutAction: String(row["timeout_action"]),
      createdAt: this.toISO(row["created_at"]),
      updatedAt: this.toISO(row["updated_at"]),
    };
  }

  private toISO(v: unknown): string {
    return v instanceof Date ? v.toISOString() : String(v);
  }

  private mapPending(row: Record<string, unknown>): InterceptPending {
    return {
      id: Number(row["id"]),
      ruleID: row["rule_id"] === null || row["rule_id"] === undefined ? null : Number(row["rule_id"]),
      conversationID: row["conversation_id"] === null || row["conversation_id"] === undefined
        ? null
        : Number(row["conversation_id"]),
      taskID: (row["task_id"] as string | null) ?? null,
      agentName: String(row["agent_name"] ?? ""),
      toolName: String(row["tool_name"]),
      toolInput: row["tool_input"] ?? {},
      status: String(row["status"]),
      decisionSource: String(row["decision_source"] ?? ""),
      reason: String(row["reason"] ?? ""),
      decidedAt: row["decided_at"] instanceof Date ? (row["decided_at"] as Date).toISOString() : null,
      createdAt: this.toISO(row["created_at"]),
    };
  }

  private mapApproval(row: Record<string, unknown>): InterceptApprovalRow {
    return {
      ...this.mapPending(row),
      convTitle: String(row["conv_title"] ?? ""),
      convAgentKey: String(row["conv_agent_key"] ?? ""),
      ruleName: String(row["rule_name"] ?? ""),
    };
  }

  /** 全部规则，priority DESC 再 id（匹配顺序即策略）。 */
  async listInterceptRules(): Promise<InterceptRule[]> {
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT ${RULE_COLS} FROM intercept_rules ORDER BY priority DESC, id`,
    );
    return res.rows.map((r) => this.mapRule(r));
  }

  async createInterceptRule(input: RuleInput): Promise<InterceptRule> {
    const res = await this.db.query<Record<string, unknown>>(
      `INSERT INTO intercept_rules(name, enabled, priority, match_target, match_type, pattern, action, message, timeout_enabled, timeout_seconds, timeout_action)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${RULE_COLS}`,
      [
        input.name, input.enabled, input.priority, input.matchTarget, input.matchType,
        input.pattern, input.action, input.message, input.timeoutEnabled, input.timeoutSeconds, input.timeoutAction,
      ],
    );
    return this.mapRule(res.rows[0]!);
  }

  /** 替换规则的全部可编辑字段；行不存在返回 null。 */
  async updateInterceptRule(id: number, input: RuleInput): Promise<InterceptRule | null> {
    const res = await this.db.query<Record<string, unknown>>(
      `UPDATE intercept_rules
         SET name=$2, enabled=$3, priority=$4, match_target=$5,
             match_type=$6, pattern=$7, action=$8, message=$9,
             timeout_enabled=$10, timeout_seconds=$11, timeout_action=$12
       WHERE id=$1
       RETURNING ${RULE_COLS}`,
      [
        id, input.name, input.enabled, input.priority, input.matchTarget, input.matchType,
        input.pattern, input.action, input.message, input.timeoutEnabled, input.timeoutSeconds, input.timeoutAction,
      ],
    );
    return res.rows[0] ? this.mapRule(res.rows[0]) : null;
  }

  async deleteInterceptRule(id: number): Promise<void> {
    await this.db.query(`DELETE FROM intercept_rules WHERE id=$1`, [id]);
  }

  async toggleInterceptRule(id: number, enabled: boolean): Promise<void> {
    await this.db.query(`UPDATE intercept_rules SET enabled=$2 WHERE id=$1`, [id, enabled]);
  }

  // ─── pending（db/intercept.go）───────────────────────────────────────────

  /** ruleID=0 → NULL（LLM 兜底判定无归属规则）；convID=0 → NULL（后台任务）；taskID="" → NULL。 */
  async createInterceptPending(args: {
    ruleID: number;
    convID: number;
    taskID: string;
    agentName: string;
    toolName: string;
    input: unknown; // 工具入参（对象或 JSON 文本；空 → "{}"）
    reason: string; // 规则 message 或模型判定理由（前缀 [模型]）
    audit?: InterceptAudit | null;
  }): Promise<number> {
    let raw = typeof args.input === "string" ? args.input : JSON.stringify(args.input ?? {});
    if (raw === "") raw = "{}";
    const res = await this.db.query<{ id: string }>(
      `INSERT INTO intercept_pending(rule_id, conversation_id, task_id, agent_name, tool_name, tool_input, reason, decision_source, audit)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb) RETURNING id`,
      [
        args.ruleID === 0 ? null : args.ruleID,
        args.convID === 0 ? null : args.convID,
        args.taskID === "" ? null : args.taskID,
        args.agentName,
        args.toolName,
        jsonbClean(raw),
        args.reason,
        decisionSource(args.ruleID, args.reason),
        args.audit ? jsonbClean(JSON.stringify(args.audit)) : null,
      ],
    );
    return Number(res.rows[0]!.id);
  }

  /**
   * 直接以终态落一行（status='allowed'|'denied'，decided_at 记 now）：记录 allow/deny
   * 规则命中供观测——不阻塞、无需人工动作，与 createInterceptPending（从 pending 起）不同。
   */
  async createDecidedIntercept(args: {
    ruleID: number;
    convID: number;
    taskID: string;
    agentName: string;
    toolName: string;
    input: unknown;
    status: string;
    reason: string;
    audit?: InterceptAudit | null;
  }): Promise<number> {
    let raw = typeof args.input === "string" ? args.input : JSON.stringify(args.input ?? {});
    if (raw === "") raw = "{}";
    const res = await this.db.query<{ id: string }>(
      `INSERT INTO intercept_pending(rule_id, conversation_id, task_id, agent_name, tool_name, tool_input, status, reason, decided_at, decision_source, audit)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, NOW(), $9, $10::jsonb) RETURNING id`,
      [
        args.ruleID === 0 ? null : args.ruleID,
        args.convID === 0 ? null : args.convID,
        args.taskID === "" ? null : args.taskID,
        args.agentName,
        args.toolName,
        jsonbClean(raw),
        args.status,
        args.reason,
        decisionSource(args.ruleID, args.reason),
        args.audit ? jsonbClean(JSON.stringify(args.audit)) : null,
      ],
    );
    return Number(res.rows[0]!.id);
  }

  /** 未决审批，新→旧；task 非空时按 task_id 过滤。 */
  async listPendingIntercepts(task = ""): Promise<InterceptPending[]> {
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT ${PENDING_COLS} FROM intercept_pending
       WHERE status='pending' AND ($1='' OR task_id=$1) ORDER BY created_at DESC`,
      [task],
    );
    return res.rows.map((r) => this.mapPending(r));
  }

  async getInterceptPending(id: number): Promise<InterceptPending | null> {
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT ${PENDING_COLS} FROM intercept_pending WHERE id=$1`,
      [id],
    );
    return res.rows[0] ? this.mapPending(res.rows[0]) : null;
  }

  /** 单条详情（含审计载荷）。 */
  async getInterceptDetail(id: number): Promise<InterceptDetail | null> {
    const res = await this.db.query<Record<string, unknown>>(
      `${APPROVAL_ROW_SELECT_WITH_AUDIT} WHERE ip.id=$1`,
      [id],
    );
    if (!res.rows[0]) return null;
    const audit = res.rows[0]["audit"];
    return {
      ...this.mapApproval(res.rows[0]),
      audit: audit && typeof audit === "object" ? (audit as InterceptAudit) : null,
    };
  }

  /** 全量历史（新→旧，limit 截断）。 */
  async listAllIntercepts(limit: number): Promise<InterceptApprovalRow[]> {
    const res = await this.db.query<Record<string, unknown>>(
      `${APPROVAL_ROW_SELECT} ORDER BY ip.created_at DESC LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => this.mapApproval(r));
  }

  /** 某任务的全量拦截记录（新→旧）。 */
  async listTaskIntercepts(taskID: string): Promise<InterceptApprovalRow[]> {
    const res = await this.db.query<Record<string, unknown>>(
      `${APPROVAL_ROW_SELECT} WHERE ip.task_id=$1 ORDER BY ip.created_at DESC`,
      [taskID],
    );
    return res.rows.map((r) => this.mapApproval(r));
  }

  // ─── 原子结算（db/intercept_detail.go）───────────────────────────────────

  /**
   * ResolveIntercept：原子结算 pending。WHERE status='pending' 保证超时不能覆盖人工
   * 决定、重复 decide 不能改写历史。审计 merge：audit || patch（JSONB 深覆盖顶层键）；
   * allow 且关联非 exact（无法精确回填执行结果）时 execution_status 置 unknown。
   * 返回是否真正结算了（false = 已被别人结算过）。
   */
  async resolveIntercept(id: number, status: string, action: string, reason: string): Promise<boolean> {
    const execution = action === "allow" ? "awaiting_result" : "not_executed";
    const patch = jsonbClean(JSON.stringify({
      effective_action: action,
      decision_reason: reason,
      execution_status: execution,
    }));
    const res = await this.db.query(
      `UPDATE intercept_pending SET status=$2, decided_at=NOW(),
         audit=CASE WHEN audit IS NULL THEN NULL ELSE audit || $3::jsonb ||
           CASE WHEN $4='allow' AND audit->>'correlation' IS DISTINCT FROM 'exact'
           THEN '{"execution_status":"unknown"}'::jsonb ELSE '{}'::jsonb END END
       WHERE id=$1 AND status='pending'`,
      [id, status, patch, action],
    );
    return (res.rowCount ?? 0) === 1;
  }

  /**
   * CompleteIntercept：仅当放行后、精确关联到（run_id, tool_use_id）且仍在
   * awaiting_result 的那次调用，才把执行结果写回审计。被拦截的 tool_result 绝不会
   * 被呈现为一次失败的执行（三重 WHERE 挡住）。返回命中行数（0=未回填）。
   */
  async completeIntercept(
    id: number,
    runID: string,
    toolUseID: string,
    status: string,
    output: string,
    truncated: boolean,
  ): Promise<number> {
    const patch = jsonbClean(JSON.stringify({
      execution_status: status,
      output,
      output_truncated: truncated,
      execution_ended_at: new Date().toISOString(),
    }));
    const res = await this.db.query(
      `UPDATE intercept_pending SET audit=audit || $4::jsonb
       WHERE id=$1 AND audit->>'run_id'=$2 AND audit->>'tool_use_id'=$3
         AND audit->>'effective_action'='allow' AND audit->>'execution_status'='awaiting_result'`,
      [id, runID, toolUseID, patch],
    );
    return res.rowCount ?? 0;
  }

  /** 平铺更新状态（无 pending 守卫；Go DecideInterceptPending，超时收割用）。 */
  async decideInterceptPending(id: number, status: string): Promise<void> {
    await this.db.query(`UPDATE intercept_pending SET status=$2, decided_at=NOW() WHERE id=$1`, [id, status]);
  }
}

function decisionSource(ruleID: number, reason: string): string {
  if (ruleID !== 0) return "rule";
  if (reason.startsWith("[模型]")) return "model";
  return "unknown";
}

// ─── Interceptor：缓存 + 匹配 + 人工 decide（intercept/intercept.go 核心）────

/** 预编译规则（regex 规则带已编译 RegExp；坏正则在装载时被剔除）。 */
interface CompiledRule extends InterceptRule {
  re: RegExp | null;
}

/**
 * 规则缓存 + 匹配引擎：优先级降序首命中即停；enabled_tools 白名单控制哪些工具进入
 * 规则路径；任何 CRUD 后调用 invalidate() 使缓存重载。不含 ask 阻塞等待与 LLM Judge
 * （Reviewer / pending 通道唤醒属 HTTP 层，M4 接线）。
 */
export class Interceptor {
  private store: InterceptStore;
  private platform: PlatformStore;
  private rulesCache: CompiledRule[] | null = null;
  private enabledToolsCache: Set<string> | null = null;
  private loading: Promise<void> | null = null;

  constructor(db: Database) {
    this.store = new InterceptStore(db);
    this.platform = new PlatformStore(db);
  }

  /** 清空规则缓存与白名单缓存；下次 match/IsToolEnabled 重新装载。 */
  invalidate(): void {
    this.rulesCache = null;
    this.enabledToolsCache = null;
  }

  /** 装载：enabled 规则 + 正则预编译（坏则跳过），enabled_tools 白名单（未设置→默认集）。 */
  private async loadLocked(): Promise<void> {
    const rules = await this.store.listInterceptRules();
    const out: CompiledRule[] = [];
    for (const r of rules) {
      if (!r.enabled) continue;
      const cr: CompiledRule = { ...r, re: null };
      if (r.matchType === "regex") {
        const re = compileInterceptRegex(r.pattern);
        if (!re) continue; // 坏正则跳过，而不是让整层崩溃
        cr.re = re;
      }
      out.push(cr);
    }
    this.rulesCache = out;

    const val = await this.platform.getSetting(SETTING_INTERCEPT_ENABLED_TOOLS);
    if (val === null) {
      this.enabledToolsCache = new Set(DEFAULT_INTERCEPT_ENABLED_TOOLS);
    } else {
      try {
        const names = JSON.parse(val) as unknown;
        this.enabledToolsCache = new Set(Array.isArray(names) ? names.map(String) : []);
      } catch {
        this.enabledToolsCache = new Set();
      }
    }
  }

  private async ensureRules(): Promise<CompiledRule[]> {
    // Refresh at the authorization boundary, including updates from other processes.
    if (!this.loading) {
      this.loading = this.loadLocked().finally(() => {
        this.loading = null;
      });
    }
    await this.loading;
    return this.rulesCache ?? [];
  }

  private async ensureEnabledTools(): Promise<Set<string>> {
    // Enabled tools are policy, not a process-local configuration snapshot.
    if (!this.loading) {
      this.loading = this.loadLocked().finally(() => {
        this.loading = null;
      });
    }
    await this.loading;
    return this.enabledToolsCache ?? new Set();
  }

  /**
   * Match：按优先级降序评估规则表，返回首个命中的 enabled 规则的 Decision；
   * 无命中返回 null。规则 message 为空时按动作给默认文案。
   */
  async match(toolName: string, input: string): Promise<InterceptDecision | null> {
    let rules: CompiledRule[];
    try {
      rules = await this.ensureRules();
    } catch {
      return null; // 装载失败 → 视为无规则（Go: err != nil → no match）
    }
    if (rules.length === 0) return null;
    for (const r of rules) {
      if (ruleMatches(r, toolName, input)) {
        const msg = r.message !== "" ? r.message : defaultMessage(r.action, r.name);
        return {
          ruleName: r.name,
          configDigest: digestInput(JSON.stringify(ruleJSON(r))),
          action: r.action,
          message: msg,
          ruleID: r.id,
          timeoutEnabled: r.timeoutEnabled,
          timeoutSeconds: r.timeoutSeconds,
          timeoutAction: r.timeoutAction,
        };
      }
    }
    return null;
  }

  /** 工具是否在拦截白名单内（即是否进入规则匹配路径）。 */
  async isToolEnabled(name: string): Promise<boolean> {
    const set = await this.ensureEnabledTools().catch(() => null);
    return set !== null && set.has(name);
  }

  /** 当前白名单（未保存过 → 默认集副本）。 */
  async getEnabledTools(): Promise<string[]> {
    return this.platform.getEnabledTools();
  }

  /** 持久化白名单并失效缓存（下次调用取新表）。 */
  async setEnabledTools(tools: string[]): Promise<void> {
    await this.platform.setEnabledTools(tools);
    this.invalidate();
  }

  /**
   * 人工 decide：原子结算 pending。已被结算（人工/超时先到）抛
   * InterceptAlreadyDecidedError。pendingManager 通道唤醒属 HTTP 层，M4 接线。
   */
  async decide(pendingID: number, allowed: boolean): Promise<void> {
    const status = allowed ? "allowed" : "denied";
    const action = allowed ? "allow" : "deny";
    const reason = allowed ? "人工允许执行" : "人工拒绝执行";
    const resolved = await this.store.resolveIntercept(pendingID, status, action, reason);
    if (!resolved) throw new InterceptAlreadyDecidedError();
  }
}

function ruleMatches(r: CompiledRule, toolName: string, input: string): boolean {
  let subject: string;
  switch (r.matchTarget) {
    case "tool_name":
      subject = toolName;
      break;
    case "tool_input":
      subject = input;
      break;
    default:
      return false;
  }
  if (r.matchType === "regex") {
    return r.re !== null && r.re.test(subject);
  }
  return subject.includes(r.pattern);
}

function defaultMessage(action: string, name: string): string {
  switch (action) {
    case "deny":
      return `拦截规则 [${name}] 禁止执行此工具`;
    case "ask":
      return `拦截规则 [${name}] 要求用户审批，请等待`;
    default:
      return "";
  }
}

/** 规则的稳定 JSON 面（configDigest 输入）。 */
function ruleJSON(r: InterceptRule): Record<string, unknown> {
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
  };
}
