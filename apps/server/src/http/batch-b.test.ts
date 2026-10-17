// 批次 B 集成测试（连 PG：series-ts-pg）：
//   1) 资产审批族全链：attach → 审批视图(group_by=host) → revoke/approve/block → detach 墓碑 → 重挂
//   2) 范围授权：POST /api/tasks/:id/assets {scope}（addAgentScope manual + authorizeScopeAssets）
//   3) 拦截规则 create→match 命中→toggle→update→delete（缓存失效）
//   4) 拦截历史详情含 audit + execution 关联 activity tool_use/tool_result 对
//   5) tool-config 读写（settings.intercept_enabled_tools）
//   6) 企业 CRUD + 范围行 PATCH/DELETE + 批量删资产（DELETE /api/assets，含级联墓碑）

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { openDatabase, type Database } from "../db/index.js";
import { Engine, defaultEngineConfig, type ModelResolver } from "../engine/engine.js";
import { buildApp } from "./app.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { AUTH_PASSWORD_KEY, hashPassword } from "./auth.js";

const TEST_DSN = process.env.SERIES_TEST_PG_DSN ?? "postgres://series:series@127.0.0.1:5433/series_test?sslmode=disable";
const JWT_KEY = "batch-b-hmac-key-0123456789abcdef0123456789";
const PASSWORD = "batch-b-pass-1234";

let haveDB = true;
let db: Database | null = null;
let app: FastifyInstance;
let engine: Engine;
let dataDir: string;
let token = "";

const run = Date.now();
const taskIDs: number[] = [];
const expIDs: number[] = [];
const assetIDs: number[] = [];
const companyIDs: number[] = [];
const ruleIDs: number[] = [];
const pendingIDs: number[] = [];
let savedPasswordHash: string | null = null;
let savedEnabledTools: string | null = null;

const throwingResolver: ModelResolver = async () => {
  throw new Error("未配置激活的 LLM profile（批次B测试桩）");
};

beforeAll(async () => {
  process.env.SERIES_PG_DSN = TEST_DSN;
  try {
    db = await openDatabase();
  } catch {
    haveDB = false;
  }
  if (!haveDB) return;

  dataDir = mkdtempSync(path.join(tmpdir(), "series-batch-b-"));
  const skillsRoot = path.join(dataDir, "skills");
  mkdirSync(path.join(skillsRoot, "demo-skill"), { recursive: true });
  writeFileSync(path.join(skillsRoot, "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: 测试技能\n---\n# demo\n");

  savedPasswordHash = await db!.platform().getSetting(AUTH_PASSWORD_KEY);
  await db!.platform().setSetting(AUTH_PASSWORD_KEY, hashPassword(PASSWORD));
  savedEnabledTools = await db!.platform().getSetting("intercept_enabled_tools");

  engine = new Engine(db!, { ...defaultEngineConfig(), workers: 1, heartbeatMs: 60_000 }, throwingResolver, dataDir);
  app = buildApp({
    version: "test",
    startedAt: Date.now(),
    db: db!,
    engine,
    jwtKey: JWT_KEY,
    skillsRoot,
    dataDir,
  });

  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "SERIES", password: PASSWORD } });
  token = (login.json() as { token: string }).token;
});

afterAll(async () => {
  if (!haveDB) return;
  for (const id of taskIDs) await engine.stop(id).catch(() => undefined);
  for (const id of pendingIDs) await db!.query(`DELETE FROM intercept_pending WHERE id=$1`, [id]).catch(() => undefined);
  for (const id of ruleIDs) await db!.query(`DELETE FROM intercept_rules WHERE id=$1`, [id]).catch(() => undefined);
  for (const id of assetIDs) await db!.query(`DELETE FROM assets WHERE id=$1`, [id]).catch(() => undefined);
  for (const id of companyIDs) await db!.query(`DELETE FROM companies WHERE id=$1`, [id]).catch(() => undefined);
  for (const id of taskIDs) await db!.query(`DELETE FROM tasks WHERE id=$1`, [id]).catch(() => undefined);
  for (const id of expIDs) await db!.query(`DELETE FROM explorations WHERE id=$1`, [id]).catch(() => undefined);
  if (savedEnabledTools === null) {
    await db!.query(`DELETE FROM settings WHERE key='intercept_enabled_tools'`).catch(() => undefined);
  } else {
    await db!.platform().setSetting("intercept_enabled_tools", savedEnabledTools);
  }
  if (savedPasswordHash === null) {
    await db!.query(`DELETE FROM settings WHERE key=$1`, [AUTH_PASSWORD_KEY]).catch(() => undefined);
  } else {
    await db!.platform().setSetting(AUTH_PASSWORD_KEY, savedPasswordHash);
  }
  await db?.close().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
});

const authed = (method: string, url: string, payload?: unknown) =>
  app.inject({ method, url: url as `/api/${string}`, payload, headers: { "X-Series-Token": token } });

async function createTask(description: string): Promise<{ id: number; exploration_id: number }> {
  const res = await authed("POST", "/api/tasks", { description, goal: "批次B验证" });
  expect(res.statusCode).toBe(201);
  const task = res.json() as { id: string; exploration_id: number };
  const id = Number(task.id);
  taskIDs.push(id);
  expIDs.push(task.exploration_id);
  return { id, exploration_id: task.exploration_id };
}

type ApprovalItem = {
  asset_id: number;
  approval_state: string;
  blocked: boolean;
  block_kind?: string;
  source: string;
  group_key?: string;
  asset_ids?: number[];
};

describe.skipIf(!haveDB)("批次 B：资产审批族", () => {
  it("attach → 分组审批视图 → revoke → approve → block → detach 墓碑 → 重挂 全链", async () => {
    const task = await createTask("批次B 资产审批链路");
    const domain = `bb-${run}.example.com`;
    const assetID = await db!.assets().upsertRootDomain({ domain });
    assetIDs.push(assetID);

    // 挂载：manual 来源 + approved。
    const attach = await authed("POST", `/api/tasks/${task.id}/assets`, {
      asset_ids: [assetID],
      source_summary: "批次B手动挂载",
    });
    expect(attach.statusCode).toBe(200);
    expect(attach.json()).toMatchObject({ requested: 1, attached: 1, existing: 0 });
    // 重复挂载 → existing。
    const again = await authed("POST", `/api/tasks/${task.id}/assets`, {
      asset_ids: [assetID],
      source_summary: "批次B手动挂载",
    });
    expect(again.json()).toMatchObject({ requested: 1, attached: 0, existing: 1 });

    // 分组审批视图：group_by=host。
    const view = await authed("GET", `/api/tasks/${task.id}/asset-approvals?group_by=host`);
    expect(view.statusCode).toBe(200);
    const items = (view.json() as { items: ApprovalItem[] }).items;
    const group = items.find((i) => (i.asset_ids ?? []).includes(assetID));
    expect(group).toBeDefined();
    expect(group!["group_key"]).toBe(`${task.id}|host:${domain}`);
    expect(group!.approval_state).toBe("approved");
    expect(group!.blocked).toBe(false);

    // revoke（group_keys 形态）。
    const revoke = await authed("POST", `/api/tasks/${task.id}/asset-approvals/revoke`, {
      group_keys: [group!["group_key"]!],
      reason: "批次B撤回",
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toMatchObject({ ok: true, approval_state: "revoked" });
    let flat = await authed("GET", `/api/tasks/${task.id}/asset-approvals`);
    let row = ((flat.json() as { items: ApprovalItem[] }).items ?? []).find((i) => i.asset_id === assetID);
    expect(row!.approval_state).toBe("revoked");

    // approve（asset_ids 形态，复用 taskScope().approveTaskAssets）。
    const approve = await authed("POST", `/api/tasks/${task.id}/asset-approvals/approve`, {
      asset_ids: [assetID],
      reason: "批次B重新批准",
    });
    expect(approve.statusCode).toBe(200);
    flat = await authed("GET", `/api/tasks/${task.id}/asset-approvals`);
    row = ((flat.json() as { items: ApprovalItem[] }).items ?? []).find((i) => i.asset_id === assetID);
    expect(row!.approval_state).toBe("approved");

    // block：manual 墓碑 + 链接置 blocked。
    const block = await authed("POST", `/api/tasks/${task.id}/asset-approvals/block`, {
      asset_ids: [assetID],
      reason: "批次B封禁",
    });
    expect(block.statusCode).toBe(200);
    expect(block.json()).toMatchObject({ ok: true, approval_state: "blocked" });
    const tomb = await db!.query<{ block_kind: string }>(
      `SELECT block_kind FROM task_asset_blocks WHERE task_id=$1 AND asset_id=$2`,
      [task.id, assetID],
    );
    expect(tomb.rows[0]?.block_kind).toBe("manual");
    flat = await authed("GET", `/api/tasks/${task.id}/asset-approvals`);
    row = ((flat.json() as { items: ApprovalItem[] }).items ?? []).find((i) => i.asset_id === assetID);
    expect(row!.blocked).toBe(true);
    expect(row!.block_kind).toBe("manual");
    expect(row!.approval_state).toBe("blocked");

    // blocked 资产不能直接撤回（复用 revokeTaskAssets 的守卫）→ 409。
    const revokeBlocked = await authed("POST", `/api/tasks/${task.id}/asset-approvals/revoke`, {
      asset_ids: [assetID],
      reason: "不该成功",
    });
    expect(revokeBlocked.statusCode).toBe(409);

    // 批准清 manual 墓碑 → 恢复 approved。
    const unblock = await authed("POST", `/api/tasks/${task.id}/asset-approvals/approve`, { asset_ids: [assetID] });
    expect(unblock.statusCode).toBe(200);
    const tombs = await db!.query(`SELECT block_kind FROM task_asset_blocks WHERE task_id=$1 AND asset_id=$2`, [task.id, assetID]);
    expect(tombs.rows.length).toBe(0);

    // detach：deleted 墓碑 + 链接摘除。
    const detach = await authed("DELETE", `/api/tasks/${task.id}/assets/${assetID}`);
    expect(detach.statusCode).toBe(200);
    expect((detach.json() as { detached: number }).detached).toBe(1);
    flat = await authed("GET", `/api/tasks/${task.id}/asset-approvals`);
    row = ((flat.json() as { items: ApprovalItem[] }).items ?? []).find((i) => i.asset_id === assetID);
    expect(row!.source).toBe("deleted");
    expect(row!.blocked).toBe(true);
    expect(row!.block_kind).toBe("deleted");

    // 重挂清 deleted 墓碑（删除封禁资产通过重新关联恢复）。
    const reattach = await authed("POST", `/api/tasks/${task.id}/assets`, {
      asset_ids: [assetID],
      source_summary: "批次B重新挂载",
    });
    expect(reattach.statusCode).toBe(200);
    expect(reattach.json()).toMatchObject({ attached: 1 });
    const left = await db!.query(`SELECT block_kind FROM task_asset_blocks WHERE task_id=$1 AND asset_id=$2`, [task.id, assetID]);
    expect(left.rows.length).toBe(0);
  });

  it("POST /api/tasks/:id/assets {scope}：按范围授权并挂回匹配资产", async () => {
    const task = await createTask("批次B 范围授权");
    const domain = `scope-${run}.example.org`;
    const assetID = await db!.assets().upsertRootDomain({ domain });
    assetIDs.push(assetID);

    const res = await authed("POST", `/api/tasks/${task.id}/assets`, {
      scope: [{ kind: "domain", value: domain }],
    });
    expect(res.statusCode).toBe(200);
    const mutation = res.json() as {
      requested: number;
      assets_linked: number;
      assets_existing: number;
      scopes_added: number;
      scopes_existing: number;
    };
    expect(mutation.requested).toBe(1);
    expect(mutation.scopes_added).toBe(1);
    expect(mutation.assets_linked).toBe(1);
    expect(mutation.assets_existing).toBe(0);

    // 范围行（kind=root_domain 存 eTLD+1）+ 资产均按 manual/approved 挂上。
    const scopeRow = await db!.query(`SELECT kind FROM task_scope WHERE task_id=$1 AND kind='root_domain' AND domain=$2`, [
      task.id,
      "example.org",
    ]);
    expect(scopeRow.rows.length).toBe(1);
    const link = await db!.query<{ approval_state: string; source: string }>(
      `SELECT approval_state, source FROM task_asset_links WHERE task_id=$1 AND asset_id=$2`,
      [task.id, assetID],
    );
    expect(link.rows[0]?.approval_state).toBe("approved");
    expect(link.rows[0]?.source).toBe("manual");

    // 重复登记：范围幂等 → scopes_existing。
    const dup = await authed("POST", `/api/tasks/${task.id}/assets`, { scope: [{ kind: "domain", value: domain }] });
    expect((dup.json() as { scopes_existing: number }).scopes_existing).toBe(1);

    // 非法范围 → 400。
    const bad = await authed("POST", `/api/tasks/${task.id}/assets`, { scope: [{ kind: "domain", value: "!!!" }] });
    expect(bad.statusCode).toBe(400);
  });

  it("审批模板：running 拒绝（409），created 放行", async () => {
    const task = await createTask("批次B 审批模板");
    const conflict = await authed("PUT", `/api/tasks/${task.id}/asset-approval-template`, {
      asset_approval_template: "explicit_targets",
    });
    expect(conflict.statusCode).toBe(409);
    await db!.query(`UPDATE tasks SET status='created' WHERE id=$1`, [task.id]);
    const ok = await authed("PUT", `/api/tasks/${task.id}/asset-approval-template`, {
      asset_approval_template: "explicit_targets",
    });
    expect(ok.statusCode).toBe(200);
    const row = await db!.query<{ t: string }>(`SELECT asset_approval_template AS t FROM tasks WHERE id=$1`, [task.id]);
    expect(row.rows[0]?.t).toBe("explicit_targets");
    const bad = await authed("PUT", `/api/tasks/${task.id}/asset-approval-template`, {
      asset_approval_template: "nope",
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe.skipIf(!haveDB)("批次 B：拦截规则 CRUD 与历史", () => {
  it("规则 create → match 命中 → toggle → update → delete（缓存失效）", async () => {
    // 用独立 marker 字符串匹配，避开内置种子规则（rm -rf / shutdown 等会被内置规则命中）。
    const marker = `batch-b-marker-${run}`;
    const create = await authed("POST", "/api/intercept/rules", {
      name: `batch-b-deny-${run}`,
      enabled: true,
      priority: 9999,
      match_target: "tool_input",
      match_type: "string",
      pattern: marker,
      action: "deny",
      message: "批次B禁止删除",
      timeout_enabled: false,
      timeout_seconds: 0,
      timeout_action: "deny",
    });
    expect(create.statusCode).toBe(201);
    const rule = create.json() as { id: number; pattern: string };
    ruleIDs.push(rule.id);

    // 缓存已失效：match 重新装载并命中（优先级最高）。
    app.interceptor.invalidate();
    const hit = await app.interceptor.match("bash", `echo ${marker}/xyz`);
    expect(hit).not.toBeNull();
    expect(hit!.ruleID).toBe(rule.id);
    expect(hit!.action).toBe("deny");
    const miss = await app.interceptor.match("bash", "echo plain-hello");
    expect(miss).toBeNull();

    // 坏正则 → 400。
    const bad = await authed("POST", "/api/intercept/rules", {
      name: "bad",
      match_target: "tool_input",
      match_type: "regex",
      pattern: "(?P<x>unclosed",
      action: "deny",
    });
    expect(bad.statusCode).toBe(400);

    // toggle 关闭 → 不再命中。
    const off = await authed("POST", `/api/intercept/rules/${rule.id}/toggle`, { enabled: false });
    expect(off.statusCode).toBe(200);
    app.interceptor.invalidate();
    expect(await app.interceptor.match("bash", `echo ${marker}/xyz`)).toBeNull();

    // update 改 pattern → 命中新形态。
    const upd = await authed("PUT", `/api/intercept/rules/${rule.id}`, {
      name: `batch-b-deny-${run}`,
      enabled: true,
      priority: 9999,
      match_target: "tool_input",
      match_type: "string",
      pattern: `${marker}-ask`,
      action: "ask",
      message: "",
      timeout_enabled: false,
      timeout_seconds: 0,
      timeout_action: "deny",
    });
    expect(upd.statusCode).toBe(200);
    expect((upd.json() as { pattern: string }).pattern).toBe(`${marker}-ask`);
    app.interceptor.invalidate();
    const hit2 = await app.interceptor.match("bash", `echo ${marker}-ask-now`);
    expect(hit2?.ruleID).toBe(rule.id);
    expect(hit2?.action).toBe("ask");

    // delete → 规则消失、不再命中。
    const del = await authed("DELETE", `/api/intercept/rules/${rule.id}`);
    expect(del.statusCode).toBe(200);
    expect((del.json() as { deleted: number }).deleted).toBe(1);
    app.interceptor.invalidate();
    expect(await app.interceptor.match("bash", `echo ${marker}-ask-now`)).toBeNull();
    const gone = await authed("PUT", `/api/intercept/rules/${rule.id}`, {
      name: "x",
      match_target: "tool_name",
      match_type: "string",
      pattern: "y",
      action: "deny",
    });
    expect(gone.statusCode).toBe(404);
  });

  it("历史详情含 audit + execution 关联 activity 的 tool_use/tool_result 对", async () => {
    const task = await createTask("批次B 拦截历史");
    const toolUseID = `batch-b-${run}`;
    const runID = `run-${run}`;
    const actUse = await db!.query<{ id: string }>(
      `INSERT INTO activity(exploration_id, worker, kind, tool, tool_use_id, is_error, summary)
       VALUES ($1, 'mainagent', 'tool_use', 'bash', $2, false, 'rm -rf /tmp/batch-b') RETURNING id`,
      [task.exploration_id, toolUseID],
    );
    const actRes = await db!.query<{ id: string }>(
      `INSERT INTO activity(exploration_id, worker, kind, tool, tool_use_id, is_error, summary)
       VALUES ($1, 'mainagent', 'tool_result', 'bash', $2, false, '已完成') RETURNING id`,
      [task.exploration_id, toolUseID],
    );

    const pendingID = await db!.interceptStore().createDecidedIntercept({
      ruleID: 0,
      convID: 0,
      taskID: String(task.id),
      agentName: "mainagent",
      toolName: "bash",
      input: { command: "rm -rf /tmp/batch-b" },
      status: "allowed",
      reason: "批次B规则放行",
      audit: {
        run_id: runID,
        tool_use_id: toolUseID,
        correlation: "exact",
        input_digest: `sha256:${run}`,
        user_message: "清理临时目录",
        context: [],
        captured_at: new Date().toISOString(),
        initial_action: "deny",
        initial_reason: "规则命中",
        effective_action: "allow",
        decision_reason: "人工允许执行",
        execution_status: "succeeded",
      },
    });
    pendingIDs.push(pendingID);

    // 历史列表：join 出的会话/规则字段存在。
    const history = await authed("GET", "/api/intercept/history");
    expect(history.statusCode).toBe(200);
    const histItems = (history.json() as { items: { id: number }[] }).items;
    expect(histItems.some((i) => i.id === pendingID)).toBe(true);

    // 分页 + filter（status=allowed & decision_source=unknown 命中本行）。
    const paged = await authed("GET", `/api/intercept/history?page=1&size=100&status=allowed&decision_source=unknown`);
    expect(paged.statusCode).toBe(200);
    const pageBody = paged.json() as { items: { id: number }[]; total: number; page: number };
    expect(pageBody.page).toBe(1);
    expect(pageBody.total).toBeGreaterThan(0);
    expect(pageBody.items.some((i) => i.id === pendingID)).toBe(true);
    const badStatus = await authed("GET", "/api/intercept/history?status=bogus");
    expect(badStatus.statusCode).toBe(400);

    // 详情含 audit JSONB。
    const detail = await authed("GET", `/api/intercept/history/${pendingID}`);
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json() as { audit: { run_id?: string; tool_use_id?: string } | null; conv_title: string; rule_name: string };
    expect(detailBody.audit?.run_id).toBe(runID);
    expect(detailBody.audit?.tool_use_id).toBe(toolUseID);
    expect(detailBody).toHaveProperty("conv_title");
    expect(detailBody).toHaveProperty("rule_name");

    // execution：tool_use/tool_result 对 + main 会话定位。
    const exec = await authed("GET", `/api/intercept/history/${pendingID}/execution`);
    expect(exec.statusCode).toBe(200);
    const execBody = exec.json() as {
      conversation_id: number | null;
      task_id: string | null;
      session: string;
      seq: number;
      items: { kind: string; tool_use_id: string }[];
    };
    expect(execBody.task_id).toBe(String(task.id));
    expect(execBody.session).toBe("main:0");
    expect(execBody.seq).toBe(Number(actUse.rows[0]!.id));
    expect(execBody.items.map((i) => i.kind)).toEqual(["tool_use", "tool_result"]);
    expect(execBody.items.every((i) => i.tool_use_id === toolUseID)).toBe(true);

    // 任务内过滤：本任务包含该行，且行行 task_id 都指向本任务。
    const taskRows = await authed("GET", `/api/intercept/task/${task.id}`);
    expect(taskRows.statusCode).toBe(200);
    const taskItems = (taskRows.json() as { items: { id: number; task_id: string | null }[] }).items;
    expect(taskItems.some((i) => i.id === pendingID)).toBe(true);
    expect(taskItems.every((i) => i.task_id === String(task.id))).toBe(true);

    // conversation 查询参数按契约回 404（会话侧原始执行另走会话页）。
    const conv = await authed("GET", `/api/intercept/history/${pendingID}/execution?conversation=1`);
    expect(conv.statusCode).toBe(404);

    await db!.query(`DELETE FROM activity WHERE id=ANY($1::bigint[])`, [
      [Number(actUse.rows[0]!.id), Number(actRes.rows[0]!.id)],
    ]);
  });

  it("tool-config：读写 settings.intercept_enabled_tools", async () => {
    const put = await authed("PUT", "/api/intercept/tool-config", { enabled_tools: ["bash", "http"] });
    expect(put.statusCode).toBe(200);
    const get = await authed("GET", "/api/intercept/tool-config");
    expect(get.statusCode).toBe(200);
    const tools = (get.json() as { enabled_tools: string[] }).enabled_tools;
    expect(tools).toContain("bash");
    expect(tools).toContain("http");
    const raw = await db!.platform().getSetting("intercept_enabled_tools");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toContain("bash");
    const bad = await authed("PUT", "/api/intercept/tool-config", { enabled_tools: "bash" });
    expect(bad.statusCode).toBe(400);
  });
});

describe.skipIf(!haveDB)("批次 B：企业与批量删资产", () => {
  it("POST /companies（含 scope）→ 范围增删改 → 改名 → 删除", async () => {
    const name = `批次B企业-${run}`;
    const create = await authed("POST", "/api/companies", {
      name,
      scope: [
        { kind: "domain", value: `batchb-${run}.example.com` },
        { kind: "ip", value: "203.0.113.7" },
      ],
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as { id: number; scope_added: number; scope_invalid: number };
    expect(created.scope_added).toBe(2);
    expect(created.scope_invalid).toBe(0);
    companyIDs.push(created.id);

    // 重名 → 409。
    const dup = await authed("POST", "/api/companies", { name, scope: [] });
    expect(dup.statusCode).toBe(409);

    // 追加 cidr 范围。
    const add = await authed("POST", `/api/companies/${created.id}/scope`, {
      scope: [{ kind: "cidr", value: "203.0.113.0/24" }],
    });
    expect(add.statusCode).toBe(200);
    expect((add.json() as { added: number }).added).toBe(1);

    // reset 覆盖：先给非法规则 → 400 且旧范围保留；再合法覆盖。
    const badReset = await authed("POST", `/api/companies/${created.id}/scope`, {
      scope: [{ kind: "domain", value: "!!!" }],
      reset: true,
    });
    expect(badReset.statusCode).toBe(400);
    const still = await db!.assets().companies.getScope(created.id);
    expect(still.length).toBe(3);
    const reset = await authed("POST", `/api/companies/${created.id}/scope`, {
      scope: [{ kind: "domain", value: `reset-${run}.example.net` }],
      reset: true,
    });
    expect(reset.statusCode).toBe(200);
    expect((reset.json() as { added: number }).added).toBe(1);
    const afterReset = await db!.assets().companies.getScope(created.id);
    expect(afterReset.length).toBe(1);

    // 单行 PATCH 替换（新行 id）+ 按 新 id DELETE。
    const sid = afterReset[0]!.id;
    const patch = await authed("PATCH", `/api/companies/${created.id}/scope/${sid}`, {
      kind: "domain",
      value: `patched-${run}.example.net`,
    });
    expect(patch.statusCode).toBe(200);
    const patched = patch.json() as { id: number; raw: string };
    expect(patched.raw).toBe(`patched-${run}.example.net`);
    const delRow = await authed("DELETE", `/api/companies/${created.id}/scope/${patched.id}`);
    expect((delRow.json() as { deleted: number }).deleted).toBe(1);
    const delMissing = await authed("DELETE", `/api/companies/${created.id}/scope/${patched.id}`);
    expect(delMissing.statusCode).toBe(404);

    // 改名（nkey 随动）。
    const rename = await authed("PATCH", `/api/companies/${created.id}`, { name: `${name}-改名` });
    expect(rename.statusCode).toBe(200);
    const renamed = await db!.assets().companies.getCompany(created.id);
    expect(renamed?.name).toBe(`${name}-改名`);

    // 不连带删资产的企业删除。
    const del = await authed("DELETE", `/api/companies/${created.id}`, { delete_assets: false });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ deleted: 1, assets_deleted: 0 });
    const gone = await db!.assets().companies.getCompany(created.id);
    expect(gone).toBeNull();
  });

  it("DELETE /api/assets {ids}：批量删资产行 + 级联 task_asset_links + deleted 墓碑", async () => {
    const task = await createTask("批次B 批量删资产");
    const domain = `del-${run}.example.io`;
    const assetID = await db!.assets().upsertRootDomain({ domain });
    assetIDs.push(assetID);
    const attach = await authed("POST", `/api/tasks/${task.id}/assets`, {
      asset_ids: [assetID],
      source_summary: "批次B待删",
    });
    expect(attach.statusCode).toBe(200);

    const del = await authed("DELETE", "/api/assets", { ids: [assetID] });
    expect(del.statusCode).toBe(200);
    expect((del.json() as { deleted: number }).deleted).toBe(1);

    const asset = await db!.query(`SELECT type FROM assets WHERE id=$1`, [assetID]);
    expect(asset.rows.length).toBe(0);
    const link = await db!.query(`SELECT task_id FROM task_asset_links WHERE task_id=$1 AND asset_id=$2`, [task.id, assetID]);
    expect(link.rows.length).toBe(0);
    const tomb = await db!.query<{ block_kind: string }>(
      `SELECT block_kind FROM task_asset_blocks WHERE task_id=$1 AND asset_id=$2`,
      [task.id, assetID],
    );
    expect(tomb.rows[0]?.block_kind).toBe("deleted");

    // 墓碑在审批视图里可见（blocked、deleted 来源）。
    const view = await authed("GET", `/api/tasks/${task.id}/asset-approvals`);
    const row = ((view.json() as { items: ApprovalItem[] }).items ?? []).find((i) => i.asset_id === assetID);
    expect(row?.blocked).toBe(true);
    expect(row?.block_kind).toBe("deleted");

    // 空参 → 400；hosts 形态可用。
    const empty = await authed("DELETE", "/api/assets", {});
    expect(empty.statusCode).toBe(400);
    const hostDomain = `host-${run}.example.io`;
    const hostAsset = await db!.assets().upsertRootDomain({ domain: hostDomain });
    assetIDs.push(hostAsset);
    const delHost = await authed("DELETE", "/api/assets", { hosts: [hostDomain] });
    expect((delHost.json() as { deleted: number }).deleted).toBe(1);
  });
});
