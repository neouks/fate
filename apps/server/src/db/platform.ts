import {migrateConstraintProvenance} from './constraint-provenance.js';
import {migrateConstraintPrompts} from '../agent/constraint-migration.js';
import {migrateArtex} from './artex-migration.js';
import {migrateBuiltinPrompts} from '../agent/prompts.js';
// 平台配置 store：settings KV / agent 提示词 / 工具目录 / MCP / LLM profile / 内置种子。
// 平移自 Go 版 db/settings.go + db/config.go(settings·prompts·mcp·profiles 部分) + db/tools.go +
// db/db.go 的 seedBuiltins（六角色 agent、变量目录、内置拦截规则 v1/v2/v3、内置 MCP）。
// task_llm_profiles 链已按决策删除：profile 只有 CRUD + 激活/故障转移链读取。

import type { Database } from "./index.js";
import { jsonbClean, utf8Clean } from "./exploration.js";

// ─── settings 键与默认值（server/manager.go + intercept/intercept.go）─────────

/** 并发 worker 数（未设置/非法时默认 3）。 */
export const SETTING_WORKERS = "workers";
export const DEFAULT_WORKERS = 3;

/** 进入拦截规则系统的工具白名单（JSON 数组文本；未设置时用硬编码默认集）。 */
export const SETTING_INTERCEPT_ENABLED_TOOLS = "intercept_enabled_tools";
export const DEFAULT_INTERCEPT_ENABLED_TOOLS = [
  "Bash", "WebFetch", "web_search",
  "shell_open", "shell_send",
  "Write", "Edit", "MultiEdit",
];

/** LLM 兜底审批（judge）settings 键。 */
export const SETTING_JUDGE_ENABLED = "llm_judge_enabled";
export const SETTING_JUDGE_PROFILE_ID = "llm_judge_profile_id";
export const SETTING_JUDGE_PROMPT = "llm_judge_prompt";
export const SETTING_JUDGE_TIMEOUT_SECONDS = "llm_judge_timeout_seconds";
export const SETTING_JUDGE_FAIL_ACTION = "llm_judge_fail_action";
export const SETTING_JUDGE_ASK_TIMEOUT_SECONDS = "llm_judge_ask_timeout_seconds";
export const SETTING_JUDGE_ASK_TIMEOUT_ACTION = "llm_judge_ask_timeout_action";

export const DEFAULT_JUDGE_TIMEOUT_SECONDS = 15;
export const DEFAULT_JUDGE_FAIL_ACTION = "allow";
export const DEFAULT_JUDGE_ASK_TIMEOUT_SECONDS = 300;
export const DEFAULT_JUDGE_ASK_TIMEOUT_ACTION = "deny";

/** judge 解析后的配置。prompt 为空串表示未覆盖（内置模板随 M4 Reviewer 接线注入）。 */
export interface JudgeConfig {
  enabled: boolean;
  profileID: number; // 0 = 跟随全局激活配置
  prompt: string;
  timeoutSeconds: number;
  failAction: "allow" | "ask" | "deny";
  askTimeoutSeconds: number;
  askTimeoutAction: "allow" | "deny";
}

// ─── LLM profile 类型（db/config.go）─────────────────────────────────────────

export interface RetryRule {
  attempts: number; // 0=继承全局 / -1=关闭 / >0=该值
  interval_ms: number; // 0=默认指数退避 / >0=固定毫秒
}

export interface RetryOverride {
  connect: RetryRule;
  empty: RetryRule;
  stream: RetryRule;
}

export interface LLMProfile {
  supportsImages?: boolean;
  id: number;
  name: string;
  format: string;
  baseURL: string;
  proxy: string;
  model: string;
  apiKey: string; // 仅 activeProfile/profileByID/poolProfiles 填充；列表走 hint
  apiKeyHint: string;
  ratePerSecond: number;
  ratePerMinute: number;
  contextWindowK: number;
  thinkingType: string;
  reasoningEffort: string;
  isDefault: boolean;
  priority: number;
  poolExclude: boolean;
  streaming: boolean;
  maxTokens: number;
  maxTokensField: string;
  sessionHeaderKey: string;
  retry: RetryOverride;
}

/** SaveProfile 入参；缺省字段按零值语义写入。id 为 0/缺省 = 插入。 */
export interface LLMProfileInput {
  supportsImages?: boolean;
  id?: number;
  name: string;
  format: string;
  baseURL?: string;
  proxy?: string;
  model: string;
  /** 更新时留空 = 保留现有 key（Go 语义）。 */
  apiKey?: string;
  apiKeyHint?: string;
  ratePerSecond?: number;
  ratePerMinute?: number;
  contextWindowK?: number;
  thinkingType?: string;
  reasoningEffort?: string;
  priority?: number;
  poolExclude?: boolean;
  streaming?: boolean;
  maxTokens?: number;
  maxTokensField?: string;
  sessionHeaderKey?: string;
  retry?: Partial<{ connect: Partial<RetryRule>; empty: Partial<RetryRule>; stream: Partial<RetryRule> }>;
}

export class LLMProfileNotFoundError extends Error {
  constructor(id: number | string = "") {
    super(id === "" ? "LLM profile not found" : `LLM profile not found: ${id}`);
    this.name = "LLMProfileNotFoundError";
  }
}
export class ActiveLLMProfileDeleteError extends Error {
  constructor() {
    super("cannot delete the active LLM profile; activate another profile first");
    this.name = "ActiveLLMProfileDeleteError";
  }
}

const MAX_RETRY_ATTEMPTS = 20;
const MAX_RETRY_INTERVAL_MS = 3_600_000;

function clampRule(r: Partial<RetryRule> | undefined): RetryRule {
  let attempts = Math.trunc(r?.attempts ?? 0);
  if (attempts < -1) attempts = -1;
  if (attempts > MAX_RETRY_ATTEMPTS) attempts = MAX_RETRY_ATTEMPTS;
  let interval = Math.trunc(r?.interval_ms ?? 0);
  if (interval < 0) interval = 0;
  if (interval > MAX_RETRY_INTERVAL_MS) interval = MAX_RETRY_INTERVAL_MS;
  return { attempts, interval_ms: interval };
}

// ─── agent / prompt 类型（db/config.go）──────────────────────────────────────

export interface Agent {
  id: number;
  key: string;
  name: string;
  description: string;
  role: string;
  builtin: boolean;
  enabled: boolean;
  llmProfileID: number | null;
  maxTurns: number;
  runSeconds: number;
  webSearch: boolean;
  interactiveShell: boolean;
  wrapupPrompt: string;
  wrapupMaxTurns: number;
  taskTimeoutWrapupPrompt: string;
  taskTimeoutWrapupMaxTurns: number;
  triggerRunMode: string;
  triggerMergeMode: string;
  triggerMaxParallel: number;
}

export interface PromptVar {
  name: string;
  description: string;
  example: string;
  source: string;
}

export interface PromptVersion {
  version: number;
  template: string;
  note: string;
  createdAt: string;
}

// ─── 工具目录类型（db/tools.go）──────────────────────────────────────────────

export interface Tool {
  key: string;
  system: boolean;
  description: string;
  schema: Record<string, unknown>;
  agents: string[];
  enabled: boolean;
  kind: string; // builtin | shell | command | script | http
  exec: Record<string, unknown>;
  deferred: boolean;
  directory: string;
  usageHelp: string;
  whenToUse: string;
  executable: string;
}

/**
 * mergeToolMetadata 把 DB 保存的 schema 元数据合并进代码 schema（平移
 * agent/tool_contract.go 的核心）：只覆盖 description 与 default（结构由代码所有），
 * 递归下钻 properties/items。Go 版对 default 会做 schema 校验，DB 层平移直存，
 * 校验留在运行时装配处（M 后续接 actool 等价物）。
 */
export function mergeToolMetadata(
  code: Record<string, unknown> | null | undefined,
  saved: Record<string, unknown> | null | undefined,
): void {
  if (!code || !saved) return;
  if (typeof saved["description"] === "string") code["description"] = saved["description"];
  if ("default" in saved) code["default"] = saved["default"];
  const props = asRecord(code["properties"]);
  const oldProps = asRecord(saved["properties"]);
  if (props) {
    for (const key of Object.keys(props)) mergeToolMetadata(asRecord(props[key]), asRecord(oldProps?.[key]));
  }
  mergeToolMetadata(asRecord(code["items"]), asRecord(saved["items"]));
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 运行时装配层的工具描述符（对应 Go actool.CoreTool 的 Description/InputSchema 面）。 */
export interface ToolDescriptor {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

/** resolveToolsForAgent 的输出：DB 覆盖生效后的模型可见面。 */
export interface ResolvedTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  system: boolean;
}

// ─── MCP 类型（db/config.go）─────────────────────────────────────────────────

export interface MCPServer {
  id: number;
  name: string;
  transport: string;
  command: string;
  args: unknown; // JSONB（通常 string[]）
  env: unknown; // JSONB（通常 Record<string,string>）
  url: string;
  enabled: boolean;
  insecure: boolean;
}

// ─── 列清单 ──────────────────────────────────────────────────────────────────

const PROFILE_RETRY_COLS =
  `COALESCE(retry_connect_attempts,0) AS retry_connect_attempts,` +
  `COALESCE(retry_connect_interval_ms,0) AS retry_connect_interval_ms,` +
  `COALESCE(retry_empty_attempts,0) AS retry_empty_attempts,` +
  `COALESCE(retry_empty_interval_ms,0) AS retry_empty_interval_ms,` +
  `COALESCE(retry_stream_attempts,0) AS retry_stream_attempts,` +
  `COALESCE(retry_stream_interval_ms,0) AS retry_stream_interval_ms`;
const PROFILE_COLS = "supports_images," +
  `id,name,format,COALESCE(base_url,'') AS base_url,COALESCE(proxy,'') AS proxy,model,` +
  `COALESCE(api_key_hint,'') AS api_key_hint,` +
  `rate_per_second,rate_per_minute,context_window_k,COALESCE(reasoning_effort,'') AS reasoning_effort,is_default,` +
  `priority,pool_exclude,COALESCE(thinking_type,'') AS thinking_type,` +
  `COALESCE(streaming,true) AS streaming,COALESCE(max_tokens,0) AS max_tokens,` +
  `COALESCE(max_tokens_field,'') AS max_tokens_field,` +
  `COALESCE(session_header_key,'') AS session_header_key,` + PROFILE_RETRY_COLS;
const PROFILE_COLS_KEY = PROFILE_COLS.replace(
  "COALESCE(api_key_hint,'') AS api_key_hint",
  "COALESCE(api_key,'') AS api_key",
);

const AGENT_COLS =
  `id,key,name,COALESCE(description,'') AS description,role,builtin,enabled,COALESCE(max_turns,0) AS max_turns,` +
  `COALESCE(run_seconds,600) AS run_seconds,COALESCE(web_search,false) AS web_search,` +
  `COALESCE(interactive_shell,false) AS interactive_shell,` +
  `COALESCE(wrapup_prompt,'') AS wrapup_prompt,COALESCE(wrapup_max_turns,0) AS wrapup_max_turns,` +
  `COALESCE(task_timeout_wrapup_prompt,'') AS task_timeout_wrapup_prompt,` +
  `COALESCE(task_timeout_wrapup_max_turns,0) AS task_timeout_wrapup_max_turns,` +
  `COALESCE(trigger_run_mode,'serial') AS trigger_run_mode,` +
  `COALESCE(trigger_merge_mode,'all') AS trigger_merge_mode,` +
  `COALESCE(trigger_max_parallel,5) AS trigger_max_parallel,llm_profile_id`;

const TOOL_COLS =
  `key, system, description, schema, agents, enabled, kind, exec, deferred, directory, usage_help, when_to_use, executable`;

// ─── Store ───────────────────────────────────────────────────────────────────

export class PlatformStore {
  constructor(private db: Database) {}

  // ─── settings KV（db/settings.go）────────────────────────────────────────

  /** 读取 setting；未设置返回 null（Go: value, ok）。 */
  async getSetting(key: string): Promise<string | null> {
    const res = await this.db.query<{ value: string }>(`SELECT value FROM settings WHERE key=$1`, [key]);
    return res.rows[0]?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db.query(
      `INSERT INTO settings(key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value],
    );
  }

  /** 只在 key 尚未存在时写入（auth.password_hash 等只许首设的键）。 */
  async insertSettingIfAbsent(key: string, value: string): Promise<boolean> {
    const res = await this.db.query(
      `INSERT INTO settings(key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async getBool(key: string, def = false): Promise<boolean> {
    const v = await this.getSetting(key);
    if (v === null) return def;
    return v === "true" || v === "1";
  }

  async setBool(key: string, val: boolean): Promise<void> {
    await this.setSetting(key, val ? "true" : "false");
  }

  async getInt(key: string, def: number): Promise<number> {
    const v = await this.getSetting(key);
    if (v === null) return def;
    const n = Number(v.trim());
    return Number.isFinite(n) ? Math.trunc(n) : def;
  }

  async getChoice(key: string, def: string, allowed: string[]): Promise<string> {
    const v = await this.getSetting(key);
    if (v === null) return def;
    const t = v.trim();
    return allowed.includes(t) ? t : def;
  }

  // ─── 常用键的类型化访问器 ────────────────────────────────────────────────

  /** 并发 worker 数（默认 3；非法/非正数回退默认）。 */
  async workers(): Promise<number> {
    const v = await this.getSetting(SETTING_WORKERS);
    if (v === null) return DEFAULT_WORKERS;
    const n = Number(v.trim());
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_WORKERS;
    return Math.trunc(n);
  }

  /** 设置并发 worker 数；<=0 拒绝（Go manager.SetWorkers 语义）。 */
  async setWorkers(n: number): Promise<void> {
    if (n <= 0) throw new Error("workers 必须 >0");
    await this.setSetting(SETTING_WORKERS, String(Math.trunc(n)));
  }

  /** 拦截白名单工具列表；未保存过 → 硬编码默认集，坏 JSON → 空表（Go 语义）。 */
  async getEnabledTools(): Promise<string[]> {
    const v = await this.getSetting(SETTING_INTERCEPT_ENABLED_TOOLS);
    if (v === null) return [...DEFAULT_INTERCEPT_ENABLED_TOOLS];
    try {
      const names = JSON.parse(v) as unknown;
      if (!Array.isArray(names)) return [];
      return names.map(String);
    } catch {
      return [];
    }
  }

  async setEnabledTools(tools: string[]): Promise<void> {
    await this.setSetting(SETTING_INTERCEPT_ENABLED_TOOLS, JSON.stringify(tools));
  }

  /** judge 配置解析：缺省/非法键回退默认；prompt 空串=未覆盖（内置模板 M4 接线）。 */
  async judgeConfig(): Promise<JudgeConfig> {
    const cfg: JudgeConfig = {
      enabled: await this.getBool(SETTING_JUDGE_ENABLED, false),
      profileID: await this.getInt(SETTING_JUDGE_PROFILE_ID, 0),
      prompt: (await this.getSetting(SETTING_JUDGE_PROMPT))?.trim() ?? "",
      timeoutSeconds: await this.getInt(SETTING_JUDGE_TIMEOUT_SECONDS, DEFAULT_JUDGE_TIMEOUT_SECONDS),
      failAction: await this.getChoice(SETTING_JUDGE_FAIL_ACTION, DEFAULT_JUDGE_FAIL_ACTION, [
        "allow", "ask", "deny",
      ]) as JudgeConfig["failAction"],
      askTimeoutSeconds: await this.getInt(SETTING_JUDGE_ASK_TIMEOUT_SECONDS, DEFAULT_JUDGE_ASK_TIMEOUT_SECONDS),
      askTimeoutAction: await this.getChoice(SETTING_JUDGE_ASK_TIMEOUT_ACTION, DEFAULT_JUDGE_ASK_TIMEOUT_ACTION, [
        "allow", "deny",
      ]) as JudgeConfig["askTimeoutAction"],
    };
    if (cfg.timeoutSeconds <= 0) cfg.timeoutSeconds = DEFAULT_JUDGE_TIMEOUT_SECONDS;
    if (cfg.askTimeoutSeconds <= 0) cfg.askTimeoutSeconds = DEFAULT_JUDGE_ASK_TIMEOUT_SECONDS;
    return cfg;
  }

  /** 持久化 judge 配置。空 prompt 清除覆盖（重新用内置模板）。 */
  async setJudgeConfig(c: JudgeConfig): Promise<void> {
    await this.setBool(SETTING_JUDGE_ENABLED, c.enabled);
    await this.setSetting(SETTING_JUDGE_PROFILE_ID, String(c.profileID));
    await this.setSetting(SETTING_JUDGE_PROMPT, c.prompt.trim()); // 内置模板对比留在 M4（Reviewer 接线处）
    await this.setSetting(SETTING_JUDGE_TIMEOUT_SECONDS, String(c.timeoutSeconds));
    await this.setSetting(SETTING_JUDGE_FAIL_ACTION, c.failAction);
    await this.setSetting(SETTING_JUDGE_ASK_TIMEOUT_SECONDS, String(c.askTimeoutSeconds));
    await this.setSetting(SETTING_JUDGE_ASK_TIMEOUT_ACTION, c.askTimeoutAction);
  }

  // ─── agents / 提示词（db/config.go Agents·prompts 段）─────────────────────

  private mapAgent(row: Record<string, unknown>): Agent {
    return {
      id: Number(row["id"]),
      key: String(row["key"]),
      name: String(row["name"]),
      description: String(row["description"] ?? ""),
      role: String(row["role"]),
      builtin: row["builtin"] === true,
      enabled: row["enabled"] === true,
      llmProfileID: row["llm_profile_id"] === null || row["llm_profile_id"] === undefined
        ? null
        : Number(row["llm_profile_id"]),
      maxTurns: Number(row["max_turns"] ?? 0),
      runSeconds: Number(row["run_seconds"] ?? 600),
      webSearch: row["web_search"] === true,
      interactiveShell: row["interactive_shell"] === true,
      wrapupPrompt: String(row["wrapup_prompt"] ?? ""),
      wrapupMaxTurns: Number(row["wrapup_max_turns"] ?? 0),
      taskTimeoutWrapupPrompt: String(row["task_timeout_wrapup_prompt"] ?? ""),
      taskTimeoutWrapupMaxTurns: Number(row["task_timeout_wrapup_max_turns"] ?? 0),
      triggerRunMode: String(row["trigger_run_mode"] ?? "serial"),
      triggerMergeMode: String(row["trigger_merge_mode"] ?? "all"),
      triggerMaxParallel: Number(row["trigger_max_parallel"] ?? 5),
    };
  }

  async listAgents(): Promise<Agent[]> {
    const res = await this.db.query<Record<string, unknown>>(`SELECT ${AGENT_COLS} FROM agents ORDER BY id`);
    return res.rows.map((r) => this.mapAgent(r));
  }

  async getAgentByKey(key: string): Promise<Agent | null> {
    const res = await this.db.query<Record<string, unknown>>(`SELECT ${AGENT_COLS} FROM agents WHERE key=$1`, [key]);
    return res.rows[0] ? this.mapAgent(res.rows[0]) : null;
  }

  /** agent 当前生效的提示词模板（无版本返回 ""）。 */
  async currentPrompt(agentID: number): Promise<string> {
    const res = await this.db.query<{ template_text: string }>(
      `SELECT p.template_text FROM agents a JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.id=$1`,
      [agentID],
    );
    return res.rows[0]?.template_text ?? "";
  }

  /**
   * PromptOverride 钩子的 DB 侧（Go: agent.PromptOverride 按 agent key）：
   * 返回存储的模板；agent 不存在或无版本返回 null（调用方回退代码内置默认）。
   */
  async promptOverride(agentKey: string): Promise<string | null> {
    const a = await this.getAgentByKey(agentKey);
    if (!a) return null;
    const t = await this.currentPrompt(a.id);
    return t === "" ? null : t;
  }

  async promptVars(agentID: number): Promise<PromptVar[]> {
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT var_name,COALESCE(description,'') AS description,COALESCE(example,'') AS example,source
       FROM agent_prompt_vars WHERE agent_id=$1 ORDER BY var_name`,
      [agentID],
    );
    return res.rows.map((r) => ({
      name: String(r["var_name"]),
      description: String(r["description"] ?? ""),
      example: String(r["example"] ?? ""),
      source: String(r["source"]),
    }));
  }

  /** 追加新版本并把 current_prompt_id 指过去；返回新版本号。 */
  async savePrompt(agentID: number, template: string, note: string, by: string): Promise<number> {
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      const verRes = await client.query<{ ver: string }>(
        `SELECT COALESCE(max(version),0)+1 AS ver FROM agent_prompts WHERE agent_id=$1`,
        [agentID],
      );
      const ver = Number(verRes.rows[0]!.ver);
      const ins = await client.query<{ id: string }>(
        `INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by)
         VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,'')) RETURNING id`,
        [agentID, ver, utf8Clean(template), note, by],
      );
      await client.query(`UPDATE agents SET current_prompt_id=$1 WHERE id=$2`, [ins.rows[0]!.id, agentID]);
      await client.query("COMMIT");
      return ver;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 仅当 agent 从未有过任何版本时写入代码默认模板（用户编辑永不被覆盖）。 */
  async seedPromptIfEmpty(agentID: number, tmpl: string): Promise<void> {
    const res = await this.db.query<{ current_prompt_id: string | null }>(
      `SELECT current_prompt_id FROM agents WHERE id=$1`,
      [agentID],
    );
    if (res.rows[0]?.current_prompt_id != null) return; // 已 seed 或用户已编辑
    await this.savePrompt(agentID, tmpl, "内置默认", "system");
  }

  /** 显式「恢复为内置默认」：追加新版本并切过去。 */
  async resetPromptToDefault(agentID: number, tmpl: string): Promise<number> {
    return this.savePrompt(agentID, tmpl, "恢复为内置默认", "system");
  }

  async listPromptVersions(agentID: number): Promise<PromptVersion[]> {
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT version,template_text,COALESCE(note,'') AS note,created_at
       FROM agent_prompts WHERE agent_id=$1 ORDER BY version DESC`,
      [agentID],
    );
    return res.rows.map((r) => ({
      version: Number(r["version"]),
      template: String(r["template_text"]),
      note: String(r["note"] ?? ""),
      createdAt: r["created_at"] instanceof Date ? (r["created_at"] as Date).toISOString() : String(r["created_at"]),
    }));
  }

  // ─── 工具目录（db/tools.go）──────────────────────────────────────────────

  private mapTool(row: Record<string, unknown>): Tool {
    const agents = row["agents"];
    return {
      key: String(row["key"]),
      system: row["system"] === true,
      description: String(row["description"] ?? ""),
      schema: (row["schema"] as Record<string, unknown>) ?? {},
      agents: Array.isArray(agents) ? agents.map(String) : [],
      enabled: row["enabled"] === true,
      kind: String(row["kind"] ?? "builtin"),
      exec: (row["exec"] as Record<string, unknown>) ?? {},
      deferred: row["deferred"] === true,
      directory: String(row["directory"] ?? ""),
      usageHelp: String(row["usage_help"] ?? ""),
      whenToUse: String(row["when_to_use"] ?? ""),
      executable: String(row["executable"] ?? ""),
    };
  }

  async listTools(): Promise<Tool[]> {
    const res = await this.db.query<Record<string, unknown>>(`SELECT ${TOOL_COLS} FROM tools ORDER BY key`);
    return res.rows.map((r) => this.mapTool(r));
  }

  async getTool(key: string): Promise<Tool | null> {
    const res = await this.db.query<Record<string, unknown>>(`SELECT ${TOOL_COLS} FROM tools WHERE key=$1`, [key]);
    return res.rows[0] ? this.mapTool(res.rows[0]) : null;
  }

  /** 首插入 only：已有行（可能被 UI 改过）永不覆盖。 */
  async seedTool(key: string, desc: string, schema: Record<string, unknown>, agents: string[]): Promise<void> {
    await this.db.query(
      `INSERT INTO tools(key, system, description, schema, agents, enabled)
       VALUES ($1, true, $2, $3::jsonb, $4::jsonb, true)
       ON CONFLICT (key) DO NOTHING`,
      [key, utf8Clean(desc), jsonbClean(JSON.stringify(schema ?? {})), jsonbClean(JSON.stringify(agents ?? []))],
    );
  }

  /** 页面可编辑字段保存（key 不可改）。 */
  async updateTool(
    key: string,
    desc: string,
    schema: Record<string, unknown>,
    agents: string[],
    enabled: boolean,
  ): Promise<void> {
    await this.db.query(
      `UPDATE tools SET description=$2, schema=$3::jsonb, agents=$4::jsonb, enabled=$5 WHERE key=$1`,
      [key, utf8Clean(desc), jsonbClean(JSON.stringify(schema ?? {})), jsonbClean(JSON.stringify(agents ?? [])), enabled],
    );
  }

  /**
   * ToolResolve 核心（server/assembly.go + agent/toolcatalog.go 的 DB 侧）：
   * 按 DB tools 行对已装配工具做「按 agent 过滤 + 描述覆盖 + schema 元数据合并」。
   * 无 DB 行的工具（MCP/skill/host 工具）原样放行；禁用或未绑定该 agent 的丢弃。
   * system 工具结构由代码所有（schema 以代码版为底、合并保存的 description/default）；
   * 自定义工具以 DB 行为准。Go 版里按工具名保留代码契约描述/结构白名单与参数默认值
   * 注入属运行时装配层（actool），此处平移 DB 层核心。
   */
  async resolveToolsForAgent(agentKey: string, tools: ToolDescriptor[]): Promise<ResolvedTool[]> {
    const rows = await this.listTools();
    const byKey = new Map(rows.map((t) => [t.key, t]));
    const out: ResolvedTool[] = [];
    for (const t of tools) {
      const row = byKey.get(t.name);
      if (!row) {
        out.push({ name: t.name, description: t.description, schema: t.schema, system: false });
        continue;
      }
      if (!row.enabled || !row.agents.includes(agentKey)) continue; // 全局禁用或未绑定 → 丢弃
      const desc = row.description !== "" ? row.description : t.description;
      let schema: Record<string, unknown>;
      if (row.system) {
        schema = structuredClone(t.schema);
        mergeToolMetadata(schema, row.schema);
      } else {
        schema = row.schema;
      }
      out.push({ name: t.name, description: desc, schema, system: row.system });
    }
    return out;
  }

  // ─── MCP（db/config.go MCP 段）───────────────────────────────────────────

  private mapMCP(row: Record<string, unknown>): MCPServer {
    return {
      id: Number(row["id"]),
      name: String(row["name"]),
      transport: String(row["transport"]),
      command: String(row["command"] ?? ""),
      args: row["args"] ?? [],
      env: row["env"] ?? {},
      url: String(row["url"] ?? ""),
      enabled: row["enabled"] === true,
      insecure: row["insecure"] === true,
    };
  }

  async listMCP(): Promise<MCPServer[]> {
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT id,name,transport,COALESCE(command,'') AS command,args,env,
              COALESCE(url,'') AS url,enabled,insecure
       FROM mcp_servers ORDER BY id`,
    );
    return res.rows.map((r) => this.mapMCP(r));
  }

  /** 插入（id=0/缺省）或更新；返回行 id。 */
  async saveMCP(m: Omit<MCPServer, "id"> & { id?: number }): Promise<number> {
    const args = m.args === undefined || m.args === null ? "[]" : JSON.stringify(m.args);
    const env = m.env === undefined || m.env === null ? "{}" : JSON.stringify(m.env);
    if (!m.id || m.id === 0) {
      const res = await this.db.query<{ id: string }>(
        `INSERT INTO mcp_servers(name,transport,command,args,env,url,enabled,insecure)
         VALUES ($1,$2,NULLIF($3,''),$4::jsonb,$5::jsonb,NULLIF($6,''),$7,$8) RETURNING id`,
        [m.name, m.transport, m.command, jsonbClean(args), jsonbClean(env), m.url, m.enabled, m.insecure],
      );
      return Number(res.rows[0]!.id);
    }
    await this.db.query(
      `UPDATE mcp_servers SET name=$1,transport=$2,command=NULLIF($3,''),args=$4::jsonb,env=$5::jsonb,
       url=NULLIF($6,''),enabled=$7,insecure=$8 WHERE id=$9`,
      [m.name, m.transport, m.command, jsonbClean(args), jsonbClean(env), m.url, m.enabled, m.insecure, m.id],
    );
    return m.id;
  }

  async deleteMCP(id: number): Promise<void> {
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM agent_visibility WHERE resource_kind='mcp' AND resource_id=$1`, [id]);
      await client.query(`DELETE FROM mcp_servers WHERE id=$1`, [id]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** server 已发现的工具名缓存（发现前为空）。 */
  async mcpToolNames(serverID: number): Promise<string[]> {
    const res = await this.db.query<{ tool_name: string }>(
      `SELECT tool_name FROM mcp_tools_cache WHERE server_id=$1 ORDER BY tool_name`,
      [serverID],
    );
    return res.rows.map((r) => r.tool_name);
  }

  // ─── LLM profiles（db/config.go profiles 段；task_llm_profiles 链已删）────

  private mapProfile(row: Record<string, unknown>): LLMProfile {
    return {
      id: Number(row["id"]),
      name: String(row["name"]),
      format: String(row["format"]),
      baseURL: String(row["base_url"] ?? ""),
      proxy: String(row["proxy"] ?? ""),
      model: String(row["model"]),
      apiKey: String(row["api_key"] ?? ""), // 列表查询时该位实为 hint
      apiKeyHint: String(row["api_key_hint"] ?? ""),
      ratePerSecond: Number(row["rate_per_second"] ?? 0),
      ratePerMinute: Number(row["rate_per_minute"] ?? 0),
      contextWindowK: Number(row["context_window_k"] ?? 0),
      supportsImages: row["supports_images"]===true,
      reasoningEffort: String(row["reasoning_effort"] ?? ""),
      isDefault: row["is_default"] === true,
      priority: Number(row["priority"] ?? 0),
      poolExclude: row["pool_exclude"] === true,
      thinkingType: String(row["thinking_type"] ?? ""),
      streaming: row["streaming"] !== false,
      maxTokens: Number(row["max_tokens"] ?? 0),
      maxTokensField: String(row["max_tokens_field"] ?? ""),
      sessionHeaderKey: String(row["session_header_key"] ?? ""),
      retry: {
        connect: { attempts: Number(row["retry_connect_attempts"] ?? 0), interval_ms: Number(row["retry_connect_interval_ms"] ?? 0) },
        empty: { attempts: Number(row["retry_empty_attempts"] ?? 0), interval_ms: Number(row["retry_empty_interval_ms"] ?? 0) },
        stream: { attempts: Number(row["retry_stream_attempts"] ?? 0), interval_ms: Number(row["retry_stream_interval_ms"] ?? 0) },
      },
    };
  }

  /** 列表（hint 版，不带 api key）。 */
  async listProfiles(): Promise<LLMProfile[]> {
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROFILE_COLS} FROM llm_profiles ORDER BY id`,
    );
    return res.rows.map((r) => {
      const p = this.mapProfile(r);
      p.apiKey = ""; // 列表面不泄漏 key
      p.apiKeyHint = String(r["api_key_hint"] ?? "");
      return p;
    });
  }

  /** 激活（默认）profile，带 api key；无激活返回 null。 */
  async activeProfile(): Promise<LLMProfile | null> {
    // is_default 优先；无标记时兜底取最新可用 profile（防测试/误操作清标记后引擎全停）。
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROFILE_COLS_KEY} FROM llm_profiles WHERE is_default LIMIT 1`,
    );
    if (res.rows[0]) return this.mapProfile(res.rows[0]);
    const fallback = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROFILE_COLS_KEY} FROM llm_profiles WHERE COALESCE(api_key,'')<>'' AND COALESCE(model,'')<>'' ORDER BY id DESC LIMIT 1`,
    );
    return fallback.rows[0] ? this.mapProfile(fallback.rows[0]) : null;
  }

  async profileByID(id: number): Promise<LLMProfile | null> {
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROFILE_COLS_KEY} FROM llm_profiles WHERE id=$1`,
      [id],
    );
    return res.rows[0] ? this.mapProfile(res.rows[0]) : null;
  }

  /** 故障转移链（运行顺序即策略）：激活 profile 领头，其余有 key 且未排除的按 priority DESC。 */
  async poolProfiles(): Promise<LLMProfile[]> {
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROFILE_COLS_KEY} FROM llm_profiles
       WHERE COALESCE(api_key,'') <> '' AND (is_default OR NOT pool_exclude)
       ORDER BY is_default DESC, priority DESC, id ASC`,
    );
    return res.rows.map((r) => this.mapProfile(r));
  }

  /** 插入（无 id）或更新。更新时 apiKey 留空=保留现有 key。 */
  async saveProfile(p: LLMProfileInput): Promise<number> {
    const id=await this.saveProfileBase(p);
    if(p.supportsImages!==undefined)await this.db.query("UPDATE llm_profiles SET supports_images=$2 WHERE id=$1",[id,p.supportsImages]);
    return id;
  }
  private async saveProfileBase(p: LLMProfileInput): Promise<number> {
    const sessionHeaderKey = (p.sessionHeaderKey ?? "").trim();
    let hint = p.apiKeyHint ?? "";
    if ((p.apiKey ?? "").length >= 4) hint = "…" + p.apiKey!.slice(-4);
    const connect = clampRule(p.retry?.connect);
    const empty = clampRule(p.retry?.empty);
    const stream = clampRule(p.retry?.stream);
    const retryVals = [
      connect.attempts, connect.interval_ms, empty.attempts, empty.interval_ms,
      stream.attempts, stream.interval_ms,
    ];
    if (!p.id || p.id === 0) {
      const res = await this.db.query<{ id: string }>(
        `INSERT INTO llm_profiles(name,format,base_url,proxy,model,api_key,api_key_hint,rate_per_second,
           rate_per_minute,context_window_k,reasoning_effort,priority,pool_exclude,thinking_type,streaming,
           max_tokens,max_tokens_field,session_header_key,retry_connect_attempts,retry_connect_interval_ms,
           retry_empty_attempts,retry_empty_interval_ms,retry_stream_attempts,retry_stream_interval_ms)
         VALUES ($1,$2,NULLIF($3,''),NULLIF($4,''),$5,NULLIF($6,''),NULLIF($7,''),$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
         RETURNING id`,
        [
          p.name, p.format, p.baseURL ?? "", p.proxy ?? "", p.model, p.apiKey ?? "", hint,
          p.ratePerSecond ?? 0, p.ratePerMinute ?? 0, p.contextWindowK ?? 0, p.reasoningEffort ?? "",
          p.priority ?? 0, p.poolExclude ?? false, p.thinkingType ?? "", p.streaming ?? true,
          p.maxTokens ?? 0, p.maxTokensField ?? "", sessionHeaderKey, ...retryVals,
        ],
      );
      return Number(res.rows[0]!.id);
    }
    if ((p.apiKey ?? "") === "") {
      await this.db.query(
        `UPDATE llm_profiles SET name=$1,format=$2,base_url=NULLIF($3,''),proxy=NULLIF($4,''),model=$5,
           rate_per_second=$6,rate_per_minute=$7,context_window_k=$8,reasoning_effort=$9,priority=$10,
           pool_exclude=$11,thinking_type=$12,streaming=$13,max_tokens=$14,max_tokens_field=$15,
           session_header_key=$16,retry_connect_attempts=$17,retry_connect_interval_ms=$18,
           retry_empty_attempts=$19,retry_empty_interval_ms=$20,retry_stream_attempts=$21,retry_stream_interval_ms=$22
         WHERE id=$23`,
        [
          p.name, p.format, p.baseURL ?? "", p.proxy ?? "", p.model,
          p.ratePerSecond ?? 0, p.ratePerMinute ?? 0, p.contextWindowK ?? 0, p.reasoningEffort ?? "",
          p.priority ?? 0, p.poolExclude ?? false, p.thinkingType ?? "", p.streaming ?? true,
          p.maxTokens ?? 0, p.maxTokensField ?? "", sessionHeaderKey, ...retryVals, p.id,
        ],
      );
      return p.id;
    }
    await this.db.query(
      `UPDATE llm_profiles SET name=$1,format=$2,base_url=NULLIF($3,''),proxy=NULLIF($4,''),model=$5,
         api_key=$6,api_key_hint=$7,rate_per_second=$8,rate_per_minute=$9,context_window_k=$10,
         reasoning_effort=$11,priority=$12,pool_exclude=$13,thinking_type=$14,streaming=$15,max_tokens=$16,
         max_tokens_field=$17,session_header_key=$18,retry_connect_attempts=$19,retry_connect_interval_ms=$20,
         retry_empty_attempts=$21,retry_empty_interval_ms=$22,retry_stream_attempts=$23,retry_stream_interval_ms=$24
       WHERE id=$25`,
      [
        p.name, p.format, p.baseURL ?? "", p.proxy ?? "", p.model, p.apiKey, hint,
        p.ratePerSecond ?? 0, p.ratePerMinute ?? 0, p.contextWindowK ?? 0, p.reasoningEffort ?? "",
        p.priority ?? 0, p.poolExclude ?? false, p.thinkingType ?? "", p.streaming ?? true,
        p.maxTokens ?? 0, p.maxTokensField ?? "", sessionHeaderKey, ...retryVals, p.id,
      ],
    );
    return p.id;
  }

  /** 设为全局默认（单默认不变式；事务内两步）。 */
  async setActiveProfile(id: number): Promise<void> {
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE llm_profiles SET is_default=false WHERE is_default`);
      const res = await client.query(`UPDATE llm_profiles SET is_default=true WHERE id=$1`, [id]);
      if ((res.rowCount ?? 0) !== 1) throw new LLMProfileNotFoundError(id);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 删除非激活 profile；激活中的拒绝（先激活别的）。task_llm_profiles 链已删，无链保存逻辑。 */
  async deleteProfile(id: number): Promise<void> {
    const cur = await this.db.query<{ is_default: boolean }>(`SELECT is_default FROM llm_profiles WHERE id=$1`, [id]);
    if (cur.rows.length === 0) throw new LLMProfileNotFoundError(id);
    if (cur.rows[0]!.is_default) throw new ActiveLLMProfileDeleteError();
    await this.db.query(`DELETE FROM llm_profiles WHERE id=$1`, [id]);
  }
}

// ─── 内置种子（db/db.go seedBuiltins 及其子种子）─────────────────────────────

/** 内置 agent + 提示词变量目录（docs §5(a)）。 */
interface BuiltinAgent {
  key: string;
  name: string;
  role: string;
  desc: string;
  vars: PromptVar[];
  /** 建行时的默认交互式 shell 开关；ON CONFLICT 不覆盖用户后续手动开关。 */
  interactiveShell: boolean;
  /** 建行时的单次 run 墙钟上限(秒)；null=用种子默认(1200)，0=不限时。 */
  runSeconds: number | null;
}

const BUILTIN_AGENTS: BuiltinAgent[] = [
  {
    key: "goals", name: "目标拆解", role: "goals",
    desc: "把渗透任务目标拆解成若干独立、可验证的子目标。",
    vars: [
      // Now 是全局 runtime 变量(server.globalPromptVars)，不再在各 agent 目录里重复定义。
      { name: "EngagementDescription", description: "任务描述（测试对象/背景）", example: "测试 example.com 站点", source: "exploration" },
    ],
    interactiveShell: false, runSeconds: null,
  },
  {
    key: "planner", name: "规划", role: "planner",
    desc: "读取态势、判定目标，只在确有未覆盖的新方向时补充探索意图（每任务一个规划循环）。",
    vars: [
      { name: "Goal", description: "任务总目标", example: "拿下 example.com 的管理员权限", source: "exploration" },
      { name: "AssetSummary", description: "资产计数/类型分布摘要(可选)", example: "domain:3 ip:5 site:2", source: "distilled" },
    ],
    interactiveShell: false, runSeconds: null,
  },
  {
    key: "mainagent", name: "主", role: "main",
    desc: "人机接口：观察进展，把人的意图落成 hint 或高优先级意图。",
    vars: [
      { name: "Goal", description: "当前任务目标", example: "拿下 example.com 的管理员权限", source: "exploration" },
      { name: "AssetSummary", description: "开局态势摘要(可选)", example: "domain:3 ip:5", source: "distilled" },
      { name: "FindingsSummary", description: "已确认漏洞摘要(可选)", example: "high:1 medium:2", source: "distilled" },
    ],
    interactiveShell: false, runSeconds: null,
  },
  {
    key: "worker", name: "执行", role: "worker",
    desc: "领取一条意图执行，把发现的事实/漏洞写回知识图谱后停止。",
    vars: [
      { name: "ProxyAddr", description: "记录代理地址(驱动 if 双文案)", example: "127.0.0.1:8080", source: "runtime" },
      { name: "WorkerName", description: "worker 自我标识(可选)", example: "worker-1", source: "runtime" },
    ],
    interactiveShell: false, runSeconds: null,
  },
  // Auto:内置「平台操作」agent。不参与渗透编排循环,经对话页驱动,用工具操作平台。
  {
    key: "auto", name: "Auto", role: "assistant",
    desc: "平台操作助手：用工具管理任务(建/看/暂停/给提示)与资产，并可创建/修改 skill、自定义工具、MCP。",
    vars: [], interactiveShell: false, runSeconds: null,
  },
  // 渗透测试:内置「独立渗透」agent。经对话页驱动,一人从侦察到收尾走完整条渗透链,自己规划自己执行自己验证。默认开启交互式 shell。
  {
    key: "pentest", name: "渗透测试", role: "assistant",
    desc: "独立渗透 agent：一人从侦察→找攻击面→深入利用→验证→收尾走完整条链，自己规划、自己执行、自己对抗式验证。",
    vars: [], interactiveShell: true, runSeconds: 0,
  },
];

/** 内置拦截规则 v3 的删除类接口路径正则（导出供无 DB 单测）。 */
export const DELETE_ENDPOINT_PATH_PATTERN = String.raw`(?i)/(?:(?:delete|remove|unlink|erase|destroy)[-\w]*|del)(?:[/?#"'\s]|$)`;

interface SeedRule {
  name: string;
  target: "tool_name" | "tool_input";
  type: "string" | "regex";
  pattern: string;
  action: "allow" | "deny" | "ask";
  message: string;
  priority: number;
}

/** v1：系统破坏性(100) / 数据库破坏性(90) / HTTP 破坏性(80)，共 17 条，全部 deny。 */
const INTERCEPT_RULES_V1: SeedRule[] = [
  // ── 系统破坏性命令 (priority 100) ──────────────────────────────────
  { name: "[内置] 递归强制删除 rm -rf", target: "tool_input", type: "regex", pattern: String.raw`(?i)\brm\b.{0,80}(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*|--recursive|--no-preserve-root)`, action: "deny", message: "禁止执行递归强制删除（rm -rf / rm --recursive），可能永久损坏系统或靶机环境", priority: 100 },
  { name: "[内置] 删除系统关键目录", target: "tool_input", type: "regex", pattern: String.raw`\brm\b[^"'\n]{0,60}["'\s](/|/etc|/bin|/usr|/boot|/var|/lib|/sys|/proc|/dev|/sbin|/root)`, action: "deny", message: "禁止删除系统关键路径", priority: 100 },
  { name: "[内置] 磁盘格式化 mkfs", target: "tool_input", type: "regex", pattern: String.raw`\bmkfs\b`, action: "deny", message: "禁止格式化磁盘（mkfs）", priority: 100 },
  { name: "[内置] 覆写磁盘设备 dd", target: "tool_input", type: "regex", pattern: String.raw`\bdd\b[^|\n]{0,100}\bof=\s*/dev/[a-zA-Z]`, action: "deny", message: "禁止使用 dd 覆写磁盘设备", priority: 100 },
  { name: "[内置] Fork 炸弹", target: "tool_input", type: "regex", pattern: String.raw`:\(\)\s*\{[^}]*:\|:`, action: "deny", message: "禁止执行 Fork 炸弹", priority: 100 },
  { name: "[内置] 关机 / 重启", target: "tool_input", type: "regex", pattern: String.raw`\b(?:shutdown|reboot|halt|poweroff|init\s+[06])\b`, action: "deny", message: "禁止执行关机或重启命令", priority: 100 },
  { name: "[内置] 杀死全部进程", target: "tool_input", type: "regex", pattern: String.raw`\bkill\s+-9\s+-1\b|\bkillall\s+-9\b`, action: "deny", message: "禁止 kill -9 -1 或 killall -9（杀死所有进程）", priority: 100 },
  { name: "[内置] 磁盘擦除 shred / wipe", target: "tool_input", type: "regex", pattern: String.raw`\b(?:shred|wipe)\b[^|\n]{0,80}/dev/[a-zA-Z]`, action: "deny", message: "禁止对磁盘设备执行 shred/wipe 擦除", priority: 100 },
  { name: "[内置] 清空防火墙规则", target: "tool_input", type: "regex", pattern: String.raw`\biptables\s+(?:-F|--flush)\b|\bnft\s+flush\s+ruleset\b`, action: "deny", message: "禁止清空防火墙规则（iptables -F / nft flush）", priority: 100 },
  // ── 数据库破坏性操作 (priority 90) ─────────────────────────────────
  { name: "[内置] SQL DROP DATABASE / TABLE / SCHEMA", target: "tool_input", type: "regex", pattern: String.raw`(?i)\bDROP\s+(?:DATABASE|TABLE|SCHEMA|INDEX|VIEW|TABLESPACE|USER|ROLE)\b`, action: "deny", message: "禁止执行 DROP 操作，可能不可逆地销毁数据库对象", priority: 90 },
  { name: "[内置] SQL TRUNCATE", target: "tool_input", type: "regex", pattern: String.raw`(?i)\bTRUNCATE\s+(?:TABLE\s+)?\w`, action: "deny", message: "禁止执行 TRUNCATE，可能清空数据表所有数据", priority: 90 },
  { name: "[内置] MongoDB drop / dropDatabase", target: "tool_input", type: "regex", pattern: String.raw`(?i)\.(?:dropDatabase|dropCollection|drop)\s*\(`, action: "deny", message: "禁止执行 MongoDB drop 操作", priority: 90 },
  { name: "[内置] Redis FLUSHALL / FLUSHDB", target: "tool_input", type: "regex", pattern: String.raw`(?i)\b(?:FLUSHALL|FLUSHDB)\b`, action: "deny", message: "禁止执行 Redis FLUSHALL / FLUSHDB，可能清空全部缓存数据", priority: 90 },
  // ── HTTP 破坏性请求 (priority 80) ──────────────────────────────────
  { name: "[内置] curl / wget 发送 DELETE 请求", target: "tool_input", type: "regex", pattern: String.raw`(?i)\bcurl\b[^|\n&;"]{0,300}(?:-X\s*DELETE|--request\s+DELETE|-XDELETE)|\bwget\b[^|\n&;"]{0,300}--method[=\s]+DELETE`, action: "deny", message: "禁止通过 curl/wget 发送 HTTP DELETE 请求，可能删除目标系统数据", priority: 80 },
  { name: "[内置] Python HTTP 客户端 DELETE（requests/httpx/aiohttp）", target: "tool_input", type: "regex", pattern: String.raw`(?i)\b(?:requests|httpx|aiohttp|urllib\.request)\.delete\s*\(|session\.delete\s*\(|client\.delete\s*\(`, action: "deny", message: "禁止使用 Python HTTP 客户端发送 DELETE 请求", priority: 80 },
  { name: "[内置] 脚本中声明 HTTP DELETE 方法（JS/通用）", target: "tool_input", type: "regex", pattern: String.raw`(?i)axios\.delete\s*\(|method\s*[:=]\s*['"]DELETE['"]`, action: "deny", message: "禁止在脚本中声明并发送 HTTP DELETE 请求", priority: 80 },
  { name: "[内置] 批量清空 / 清除接口路径", target: "tool_input", type: "regex", pattern: String.raw`(?i)/(?:clear|wipe|flush|purge|truncate|drop|destroy|factory[-_]reset|reset[-_]all)(?:[/?#"'\s]|$)`, action: "deny", message: "禁止调用批量清空或销毁类接口（/clear /wipe /flush /purge 等）", priority: 80 },
];

/** 内置 skill 目录名 → 默认可见的内置 agent key（api-recon；其余 skill 默认不可见）。 */
const BUILTIN_SKILL_VISIBILITY: Record<string, string[]> = {
  "api-recon": ["auto", "pentest", "worker"],
};

/**
 * seedBuiltins：内置 agents + 变量目录、交互式 shell 默认开关（一次性）、browser→playwright
 * 迁移、内置 MCP 三件套、skill 可见性、内置拦截规则 v1/v2/v3。幂等：ON CONFLICT /
 * settings 旗标门控，用户改动永不被覆盖。在 openDatabase 迁移后调用一次。
 */
/** 内置工具种子：领域工具（按角色工厂名单）+ pi 内置本地工具。幂等首插。 */
export async function seedBuiltinTools(db: Database): Promise<void> {
  const P = ["planner"], W = ["worker"], M = ["mainagent"], G = ["goals"];
  const SHARED = ["planner", "worker", "mainagent"];
  const ALL = ["planner", "worker", "mainagent", "goals"];
  const seeds: Array<[string, string, string[]]> = [
    ["bash", "执行 shell 命令（经出口网关做任务级授权）", ALL],
    ["read", "读取文件", [...ALL,"auto","reporter","pentest","retester"]],
    ["write", "写入文件", ["worker"]],
    ["edit", "编辑文件（字符串替换）", ["worker"]],
    ["graph_overview", "读取探索态势总览（目标/frontier/在跑/近期事实/覆盖度）", SHARED],
    ["node_detail", "钻取节点详情与血缘", SHARED],
    ["search_worker_traces", "检索其他 work 的执行过程观察", SHARED],
    ["get_worker_trace", "读取指定 work 的执行轨迹与结论", SHARED],
    ["record_fact", "写回探索事实（含负面结论，带证据与置信度）", W],
    ["insert_assets", "登记发现的资产（域名/IP/服务/端点/应用）", W],
    ["report_finding", "报告确认的漏洞（须可复现）", W],
    ["list_findings", "查询已报漏洞", ["worker", "planner", "mainagent"]],
    ["list_assets", "查询资产库", SHARED],
    ["list_untested_assets", "列出范围内未测资产", ["planner", "mainagent"]],
    ["add_intent", "派发探索意图（先查重）", ["planner", "mainagent"]],
    ["prove_goal", "证明目标达成并收官", P],
    ["kill_work", "终止在跑意图", ["planner", "mainagent"]],
    ["steer_work", "运行中纠偏（不打断）", ["planner", "mainagent"]],
    ["add_task_scope", "扩展任务测试范围", P],
    ["todo_write", "更新攻击链待办（跨轮共享）", P],
    ["dispatch_intents", "下发待执行意图", M],
    ["set_goals", "设定/替换任务目标", ["mainagent", "goals"]],
    ["set_constraints", "登记操作约束（allow/deny）", ["mainagent", "goals"]],
    ["register_user_target", "登记用户明确授权的目标", G],
  ];
  for (const [key, desc, agents] of seeds) {
    await db.query(
      `INSERT INTO tools(key, system, description, schema, agents, enabled, kind) VALUES ($1, true, $2, '{}'::jsonb, $3::jsonb, true, 'builtin') ON CONFLICT (key) DO NOTHING`,
      [key, desc, JSON.stringify(agents)],
    );
  }
}

export async function seedBuiltins(db: Database): Promise<void> {
  // New roles are insert-only: operator prompts, budgets and bindings survive upgrades.
  await db.query(`INSERT INTO agents(key,name,role,builtin,enabled,trigger_run_mode,trigger_merge_mode,trigger_max_parallel)
    VALUES ('reporter','Reporter','assistant',false,true,'parallel','none',5),('retester','Retester','assistant',false,true,'parallel','none',5) ON CONFLICT(key) DO NOTHING`);
  await seedBuiltinTools(db);
  await db.transaction(async tx=>{
    // Retire the active catalog entries, preserving customized historical metadata.
    const retired=['checkpoint_intent','complete_intent'];
    await tx.query(`INSERT INTO settings(key,value)
      SELECT 'pi_worker_removed_tools_previous',jsonb_agg(to_jsonb(t) ORDER BY key)::text
      FROM tools t WHERE system AND kind='builtin' AND key=ANY($1::text[]) HAVING count(*)>0
      ON CONFLICT(key) DO NOTHING`,[retired]);
    await tx.query("DELETE FROM tools WHERE system AND kind='builtin' AND key=ANY($1::text[])",[retired]);
  });
  const store = new PlatformStore(db);
  const extensionTools:Array<[string,string,string[]]>=[
   ...['shell_open','shell_send','shell_read','shell_close','shell_list'].map(key=>[key,'当前 PI 执行会话的交互终端',['worker','planner','mainagent']] as [string,string,string[]]),
   ['context_search','检索授权探索节点、执行结果与冷图原文',['worker','planner','mainagent','pentest','auto','goals','reporter','retester']],
   ['context_get','按稳定引用分页读取节点详情与血缘',['worker','planner','mainagent','pentest','auto','goals','reporter','retester']],
   ['read_tool_output','续读完整工具 JSON 原文',['goals','planner','mainagent','worker','auto','pentest','reporter','retester']],
   ['http_request','执行授权 HTTP 请求并保存证据',['worker','pentest','retester']],
   ['traffic_body','分页读取流量证据',['worker','pentest','reporter','retester']],
   ['read_attachment','分页读取当前会话附件',['worker','mainagent','auto','pentest','reporter','retester']],
   ['record_finding_retest_result','保存明确的复测结论',['retester']],
   ['get_finding_retest_context','读取原漏洞与复测约束',['retester']],
   ['get_finding','读取漏洞和证据版本',['reporter','retester','auto','pentest']],
   ['update_finding_report','以证据版本更新报告',['reporter','auto']],
   ['list_tasks','列出平台任务',['auto']],['get_task','查询任务状态',['auto']],
   ['record_conversation_fact','绑定任务的 Pentest 写回有来源的事实',['pentest']],['report_conversation_finding','绑定任务的 Pentest 原子提交有证据的漏洞',['pentest']],['resume_task','恢复任务并查询准入结果',['auto']],
   ['spawn_task','创建任务',['auto']],['pause_task','暂停任务',['auto']],['add_task_hint','给任务追加提示',['auto']],
  ];
  for(const [key,description,agents] of extensionTools)await db.query(`INSERT INTO tools(key,system,description,schema,agents,enabled,kind) VALUES($1,true,$2,'{}',$3::jsonb,true,'builtin') ON CONFLICT(key) DO NOTHING`,[key,description,JSON.stringify(agents)]);
  if(await store.getSetting('pi_extra_role_bindings_v1')!=='true'){
    const legacyShared=['planner','worker','mainagent'],legacyAll=[...legacyShared,'goals'];
    const bindings:Array<[string[],string[],string[]]>=[
      [['bash'],legacyAll,['pentest']],
      [['read'],legacyAll,['pentest','retester','auto','reporter']],
      [['write','edit'],['worker'],['pentest']],
      [['graph_overview','node_detail'],legacyShared,['pentest']],
      [['list_assets'],legacyShared,['pentest','retester','auto']],
      [['list_findings'],['worker','planner','mainagent'],['pentest','reporter','auto']],
    ];
    // Only recognize untouched legacy defaults; never broaden a custom binding.
    for(const [keys,before,added] of bindings)await db.query('UPDATE tools SET agents=agents||$3::jsonb WHERE key=ANY($1::text[]) AND agents=$2::jsonb AND enabled',[keys,JSON.stringify(before),JSON.stringify(added)]);
    await store.setSetting('pi_extra_role_bindings_v1','true');
  }
  if(await store.getSetting('pi_reporter_trigger_v1')!=='true'){
    await db.query(`INSERT INTO agent_triggers(agent_key,on_finding,finding_message) SELECT 'reporter',true,'根据本次漏洞及其证据完善报告，先读取证据版本再提交。' WHERE NOT EXISTS(SELECT 1 FROM agent_triggers WHERE agent_key='reporter')`);
    await store.setSetting('pi_reporter_trigger_v1','true');
  }


  // 1. 内置 agent（ON CONFLICT 只刷 name/description，interactive_shell/run_seconds 不覆盖用户改动）
  for (const a of BUILTIN_AGENTS) {
    const res = await db.query<{ id: string }>(
      `INSERT INTO agents(key, name, description, role, builtin, enabled, interactive_shell, run_seconds)
       VALUES ($1, $2, NULLIF($3,''), $4, true, true, $5, COALESCE($6, 1200))
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
       RETURNING id`,
      [a.key, a.name, a.desc, a.role, a.interactiveShell, a.runSeconds],
    );
    const agentID = Number(res.rows[0]!.id);
    for (const v of a.vars) {
      await db.query(
        `INSERT INTO agent_prompt_vars(agent_id, var_name, description, example, source)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (agent_id, var_name) DO UPDATE
           SET description = EXCLUDED.description, example = EXCLUDED.example, source = EXCLUDED.source`,
        [agentID, v.name, v.description, v.example, v.source],
      );
    }
  }

  // 2. 清掉已更名变量的目录残留（EngagementTitle→Description；Now 升为全局 runtime 变量）
  await db.query(`DELETE FROM agent_prompt_vars WHERE var_name IN ('EngagementTitle', 'CoverageGaps', 'Now')`);

  // 3. 运行时 agent(planner/worker/mainagent/auto) 的交互式 shell 默认开——只做一次，
  //    之后尊重用户 toggle-off（settings 旗标门控）。goals(一次性拆解器)保持关。
  if ((await store.getSetting("interactive_shell_default_v1")) !== "true") {
    await db.query(`UPDATE agents SET interactive_shell=true WHERE key IN ('planner','worker','mainagent','auto')`);
    await store.setSetting("interactive_shell_default_v1", "true");
  }

  // 4. 历史 Playwright 行名 "browser" → "playwright"：仅当规范名空闲时原地改名（保留
  //    id/缓存/可见性/用户配置）；两名并存则都不动。
  await db.query(
    `UPDATE mcp_servers SET name='playwright'
     WHERE name='browser' AND NOT EXISTS (SELECT 1 FROM mcp_servers WHERE name='playwright')`,
  );

  await migrateBuiltinPrompts(db);
  await migrateConstraintProvenance(db);
  await migrateConstraintPrompts(db);
  await migrateArtex(db);

  // 5. 内置 MCP 只是配置预设：disabled 且不授予任何 agent。ON CONFLICT 保证重启不覆盖用户改动。
  await db.query(
    `INSERT INTO mcp_servers(name, transport, command, args, env, enabled)
     VALUES
       ('playwright', 'stdio', 'npx', '["@playwright/mcp","--headless"]', '{}', false),
       ('web_search', 'stdio', 'npx', '["-y","@zhafron/mcp-web-search"]', '{}', false),
       ('chrome-devtools', 'stdio', 'npx', '["-y","chrome-devtools-mcp","--slim","--headless"]', '{}', false)
     ON CONFLICT (name) DO NOTHING`,
  );
  // 注：ScopeSentry 占位 MCP（空 URL、disabled）由 schema.sql §F 直接播种，psql 裸初始化也有。

  // 6. 内置 skill 可见性（插缺不覆盖：用户关掉的不会被重启复活）
  for (const [skillName, agentKeys] of Object.entries(BUILTIN_SKILL_VISIBILITY)) {
    for (const key of agentKeys) {
      await db.query(
        `INSERT INTO agent_skill_visibility(agent_id, skill_name, enabled)
         SELECT id, $2, true FROM agents WHERE key=$1
         ON CONFLICT (agent_id, skill_name) DO NOTHING`,
        [key, skillName],
      );
    }
  }

  // 7. 内置拦截规则 v1/v2/v3：各自 settings 旗标门控（旧库也补种；用户改动不覆盖）
  await seedInterceptRulesV1(db, store);
  await seedInterceptRulesV2(db, store);
  await seedInterceptRulesV3(db, store);
}

async function seedInterceptRulesV1(db: Database, store: PlatformStore): Promise<void> {
  if ((await store.getSetting("intercept_default_rules_v1")) === "done") return;
  for (const r of INTERCEPT_RULES_V1) {
    await db.query(
      `INSERT INTO intercept_rules(name, enabled, priority, match_target, match_type, pattern, action, message, timeout_enabled, timeout_seconds, timeout_action)
       VALUES ($1, true, $2, $3, $4, $5, $6, $7, false, 60, 'deny')
       ON CONFLICT DO NOTHING`,
      [r.name, r.priority, r.target, r.type, r.pattern, r.action, r.message],
    );
  }
  await store.setSetting("intercept_default_rules_v1", "done");
}

/** v2：guard.go 两条硬编码安全模式转普通规则；外泄管道规则默认 DISABLED（CTF/渗透场景误伤）。 */
async function seedInterceptRulesV2(db: Database, store: PlatformStore): Promise<void> {
  if ((await store.getSetting("intercept_default_rules_v2")) === "done") return;
  const rules = [
    {
      name: "[内置] 破坏性系统命令",
      pattern: String.raw`(?i)\b(rm\s+-rf\s+/|mkfs|dd\s+if=|:\(\)\s*\{|shutdown|reboot|>\s*/dev/sd)`,
      action: "deny",
      message: "破坏性命令被拒绝（rm -rf / / mkfs / dd / fork bomb / 关机重启 / 覆写磁盘设备）",
      enabled: true,
      priority: 100,
    },
    {
      name: "[内置] 数据外泄管道",
      pattern: String.raw`(?i)(curl|wget|nc|ncat)\b[^|]*\b(\|\s*(curl|wget|nc))`,
      action: "deny",
      message: "疑似数据外泄管道被拒绝（命令输出经 curl/wget/nc 外传）",
      enabled: false,
      priority: 80,
    },
  ];
  for (const r of rules) {
    await db.query(
      `INSERT INTO intercept_rules(name, enabled, priority, match_target, match_type, pattern, action, message, timeout_enabled, timeout_seconds, timeout_action)
       VALUES ($1, $2, $3, 'tool_input', 'regex', $4, $5, $6, false, 60, 'deny')
       ON CONFLICT DO NOTHING`,
      [r.name, r.enabled, r.priority, r.pattern, r.action, r.message],
    );
  }
  await store.setSetting("intercept_default_rules_v2", "done");
}

/** v3：删除类接口路径规则（v1 只拦 DELETE 方法与若干路径词根，GET/POST 打删除接口此前漏网）。 */
async function seedInterceptRulesV3(db: Database, store: PlatformStore): Promise<void> {
  if ((await store.getSetting("intercept_default_rules_v3")) === "done") return;
  const name = "[内置] 删除类接口路径";
  await db.query(
    `INSERT INTO intercept_rules(name, enabled, priority, match_target, match_type, pattern, action, message, timeout_enabled, timeout_seconds, timeout_action)
     SELECT $1, true, 80, 'tool_input', 'regex', $2, 'deny', $3, false, 60, 'deny'
     WHERE NOT EXISTS (SELECT 1 FROM intercept_rules WHERE name = $1)`,
    [
      name,
      DELETE_ENDPOINT_PATH_PATTERN,
      "禁止调用删除类接口（/delete /remove /unlink /erase 等），不论使用哪种 HTTP 方法——多数应用的删除接口用 GET/POST 就能触发，同样会真实删除目标数据",
    ],
  );
  await store.setSetting("intercept_default_rules_v3", "done");
}
