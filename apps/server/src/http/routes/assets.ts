// 资产/公司/任务范围/覆盖度路由。
// 资产列表/公司列表是只读投影（AssetStore 的写路径与 mapAsset 宽列留在工具侧使用），
// 直接 SQL 取需要的列；task scope 与 coverage 走 db.taskScope()。

import type { FastifyInstance } from "fastify";
import { TaskAssetInvalidError, TaskAssetTaskNotFoundError } from "../../db/task_scope.js";

export function registerAssetRoutes(app: FastifyInstance): void {
  const db = () => app.db;

  // GET /api/assets?type=&limit=&offset= — 分页资产列表（前端资产页/任务资产 Tab 共用）。
  // 任务视图参数（对齐 api.taskAssets / searchTaskAssets）：task_id=本任务链接过滤、
  // tested=true/false（task_asset_links.tested）、approval_state=（有效审批态，含继承）、
  // dsl=简单 ILIKE（domain/root_domain/ip/url/app_name/service_name）。
  app.get("/api/assets", async (req) => {
    const q = req.query as Record<string, unknown>;
    const type = typeof q["type"] === "string" && q["type"] !== "" ? q["type"] : null;
    const taskID = Number(q["task_id"]) || 0;
    const tested = q["tested"] === "true" ? true : q["tested"] === "false" ? false : null;
    const approval =
      typeof q["approval_state"] === "string" &&
      ["approved", "pending", "revoked", "blocked"].includes(q["approval_state"])
        ? q["approval_state"]
        : null;
    const dsl = typeof q["dsl"] === "string" ? q["dsl"].trim() : "";
    const limit = Math.min(500, Math.max(1, Number(q["limit"]) || 50));
    const offset = Math.max(0, Number(q["offset"]) || 0);

    const params: unknown[] = [];
    const push = (v: unknown): string => {
      params.push(v);
      return `$${String(params.length)}`;
    };
    // taskID 占位符只 push 一次，后续子查询复用（pg 参数可重复引用）。
    const tRef = taskID > 0 ? push(taskID) : "";
    let where = "TRUE";
    if (type !== null) where += ` AND a.type=${push(type)}`;
    if (taskID > 0) {
      where += ` AND EXISTS (SELECT 1 FROM task_asset_links l WHERE l.task_id=${tRef} AND l.asset_id=a.id)`;
    }
    // tested/approval 仅在任务视图下有意义（无任务上下文时忽略）。
    if (taskID > 0 && tested !== null) {
      where += ` AND COALESCE((SELECT l.tested FROM task_asset_links l WHERE l.task_id=${tRef} AND l.asset_id=a.id), false) = ${push(tested)}`;
    }
    if (taskID > 0 && approval !== null) {
      where += ` AND task_asset_effective_approval_state(${tRef}, a.id)=${push(approval)}`;
    }
    if (dsl !== "") {
      const like = push(`%${dsl}%`);
      where += ` AND (a.domain ILIKE ${like} OR a.root_domain ILIKE ${like} OR a.ip ILIKE ${like}
                     OR a.url ILIKE ${like} OR a.app_name ILIKE ${like} OR a.service_name ILIKE ${like})`;
    }

    // 任务视图补 per-task 列（tested/approval/来源），与前端 Asset 的任务扩展位对齐。
    const taskCols =
      taskID > 0
        ? `, (SELECT l.tested FROM task_asset_links l WHERE l.task_id=${tRef} AND l.asset_id=a.id) AS tested,
            (SELECT l.tested_at FROM task_asset_links l WHERE l.task_id=${tRef} AND l.asset_id=a.id) AS tested_at,
            (SELECT l.tested_by FROM task_asset_links l WHERE l.task_id=${tRef} AND l.asset_id=a.id) AS tested_by,
            (SELECT l.source FROM task_asset_links l WHERE l.task_id=${tRef} AND l.asset_id=a.id) AS task_source,
            (SELECT l.source_summary FROM task_asset_links l WHERE l.task_id=${tRef} AND l.asset_id=a.id) AS task_source_summary,
            task_asset_effective_approval_state(${tRef}, a.id) AS approval_state`
        : "";
    // 过滤参数与分页参数分开（count 语句只引用过滤占位符——pg 要求实参数量严格匹配）。
    const filterParams = [...params];
    const limitRef = push(limit);
    const offsetRef = push(offset);
    const assets = await db().query(
      `SELECT id, type, company_id, task_ids, COALESCE(domain,'') AS domain, COALESCE(root_domain,'') AS root_domain,
              COALESCE(ip,'') AS ip, port, COALESCE(icp,'') AS icp, COALESCE(app_name,'') AS app_name,
              COALESCE(url,'') AS url, COALESCE(service_type,'') AS service_type, COALESCE(service_name,'') AS service_name,
              COALESCE(page_title,'') AS page_title, status_code, last_seen${taskCols}
       FROM assets a WHERE ${where}
       ORDER BY last_seen DESC NULLS LAST, id DESC LIMIT ${limitRef} OFFSET ${offsetRef}`,
      params,
    );
    const total = await db().query<{ count: string }>(`SELECT count(*) AS count FROM assets a WHERE ${where}`, filterParams);
    return { count: assets.rows.length, total: Number(total.rows[0]?.count ?? 0), assets: assets.rows };
  });

  // GET /api/assets/counts — 按类型计数（资产页筛选徽标）。
  app.get("/api/assets/counts", async () => {
    const counts = await db().assets().countsByType();
    const out: Record<string, number> = {};
    for (const [type, n] of counts) out[type] = n;
    return out;
  });

  // GET /api/companies — 公司列表（含资产计数，前端企业页最小面）。
  app.get("/api/companies", async () => {
    const res = await db().query(
      `SELECT c.id, c.name, COALESCE(c.logo,'') AS logo,
              (SELECT count(*) FROM assets a WHERE a.company_id=c.id) AS asset_count
       FROM companies c ORDER BY c.id`,
    );
    return res.rows.map((r) => ({
      id: Number(r["id"]),
      name: String(r["name"]),
      logo: String(r["logo"] ?? ""),
      asset_count: Number(r["asset_count"] ?? 0),
    }));
  });

  // ─── 任务范围（scope）与覆盖度 ─────────────────────────────────────────────

  function scopeDTO(r: Record<string, unknown>): Record<string, unknown> {
    return {
      id: r["id"] === undefined ? undefined : Number(r["id"]),
      task_id: Number(r["task_id"] ?? 0),
      kind: String(r["kind"] ?? ""),
      company_id: r["company_id"] === null || r["company_id"] === undefined ? null : Number(r["company_id"]),
      company_name: r["company_name"] ?? "",
      domain: r["domain"] ?? "",
      net: r["net"] ?? "",
      value: r["value"] ?? "",
      source: r["source"] ?? "",
      reason: r["reason"] ?? "",
    };
  }

  app.get("/api/tasks/:id/scope", async (req, reply) => {
    const taskID = Number((req.params as { id: string }).id);
    const task = await db().tasks().getTask(taskID);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const rows = await db().taskScope().listTaskScope(taskID);
    return { scope: rows.map((r) => scopeDTO(r as unknown as Record<string, unknown>)) };
  });

  // POST /api/tasks/:id/scope — 手动新增测试范围 {kind,value,reason}。
  const addScope = async (
    req: { params: unknown; body?: unknown },
    reply: { code(c: number): { send(v: unknown): unknown } },
  ): Promise<unknown> => {
    const taskID = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const kind = typeof b["kind"] === "string" ? b["kind"] : "";
    const value = typeof b["value"] === "string" ? b["value"] : "";
    const reason = typeof b["reason"] === "string" ? b["reason"] : "";
    if (kind === "" || value === "") return reply.code(400).send({ error: "kind/value 不能为空" });
    try {
      // HTTP/UI 侧 = 操作者显式授权边界：source 'manual'（与资产授权同事务，对齐 Go 语义）。
      const ts = await db().taskScope().addAgentScope(taskID, kind, value, reason, "manual");
      return reply.code(201).send(scopeDTO(ts as unknown as Record<string, unknown>));
    } catch (err) {
      if (err instanceof TaskAssetTaskNotFoundError) return reply.code(404).send({ error: err.message });
      if (err instanceof TaskAssetInvalidError) return reply.code(400).send({ error: err.message });
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  };
  app.post("/api/tasks/:id/scope", async (req, reply) => addScope(req, reply));
  app.post("/api/task/:id/scope", async (req, reply) => addScope(req, reply)); // M5 规格单数路径别名

  app.delete("/api/tasks/:id/scope/:sid", async (req) => {
    const taskID = Number((req.params as { id: string }).id);
    const sid = Number((req.params as { sid: string }).sid);
    const ok = await db().taskScope().deleteTaskScope(taskID, sid);
    return { ok };
  });

  app.get("/api/tasks/:id/coverage", async (req, reply) => {
    const taskID = Number((req.params as { id: string }).id);
    const task = await db().tasks().getTask(taskID);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const cov = await db().taskScope().taskCoverage(taskID, task.exploration_id);
    return {
      enabled: cov.enabled,
      scope_rows: cov.scopeRows,
      denominator: cov.denominator,
      tested: cov.tested,
      pct: cov.pct,
      by_type: cov.byType.map((b) => ({ type: b.type, total: b.total, tested: b.tested })),
    };
  });
}
