// 批次 B：资产审批族（授权 tab 调用面）+ 企业 CRUD + 批量删资产。
// 契约对齐 web/src/lib/api.ts：
//   GET  /api/tasks/:id/asset-approvals?group_by=host      分组审批视图（pending/approved/revoked/blocked）
//   POST /api/tasks/:id/asset-approvals/:operation         approve|revoke|block（asset_ids 或 group_keys）
//   PUT  /api/tasks/:id/asset-approval-template            审批模板（created/queued 才可改）
//   POST /api/tasks/:id/assets                             attach {asset_ids,source_summary} | {scope:[...]}
//   POST /api/tasks/:id/assets/detach                      批量解挂 {asset_ids}
//   DEL  /api/tasks/:id/assets/:assetId                    解挂单个（写 deleted 墓碑）
//   POST /api/companies[/:id/scope[/:sid]] PATCH/DELETE    企业与范围行 CRUD
//   DEL  /api/assets                                       批量删资产（ids|hosts，级联 task_asset_links+墓碑）
// 复用 db 层现成方法：TaskScopeStore.approveTaskAssets/revokeTaskAssets/addAgentScope、
// CompanyStore.createCompanyWithScope/addScopeInputsChecked/recomputeAttribution、parseScopeInput。

import type { FastifyInstance, FastifyReply } from "fastify";
import type { ScopeInput } from "../../db/assets.js";
import {
  CompanyNameConflictError,
  CompanyNotFoundError,
  parseScopeInput,
} from "../../db/assets.js";
import {
  TaskAssetBlockedError,
  TaskAssetInvalidError,
  TaskAssetNotFoundError,
  TaskAssetTaskNotFoundError,
  normalizeTaskAssetIDs,
} from "../../db/task_scope.js";
import { validAssetApprovalTemplate } from "../../db/tasks.js";

/** 企业范围编辑互斥锁（db/companies.go companyScopeMutationLock；与 store 内字面量一致）。 */
const COMPANY_SCOPE_MUTATION_LOCK = 7337741003;

const HOST_ASSET_TYPES = ["root_domain", "subdomain", "ip"];

function str(v: unknown, def = ""): string {
  return typeof v === "string" ? v : def;
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v ?? "");
}

function isoOrNull(v: unknown): string | undefined {
  return v === null || v === undefined ? undefined : iso(v);
}

interface ApprovalRow {
  asset_id: number;
  asset_type: string;
  name: string;
  source: string;
  source_summary: string;
  source_node_id?: number;
  source_task_id: number;
  inherited: boolean;
  read_only: boolean;
  created_at: string;
  approval_state: string;
  approved_at?: string;
  approved_by?: string;
  approval_reason?: string;
  blocked: boolean;
  blocked_at?: string;
  block_reason?: string;
  blocked_by?: string;
  block_kind?: string;
  block_direct?: boolean;
  // 分组视图内部字段（DTO 前剥离）。
  record_type: string;
  origins?: { activity_id?: number }[];
  group_key?: string;
  asset_ids?: number[];
  record_types?: string[];
  sources?: string[];
  mixed_state?: boolean;
}

/** 链接行 + 墓碑行的任务资产审批视图（与 mock handler 的 mockTaskAssetApprovals 同形）。 */
async function approvalRows(app: FastifyInstance, taskID: number): Promise<ApprovalRow[]> {
  const db = app.db;
  const linked = await db.query(
    `SELECT DISTINCT ON (a.id)
            a.id AS asset_id, a.type AS asset_type,
            COALESCE(NULLIF(a.url,''),NULLIF(a.domain,''),NULLIF(a.ip,''),NULLIF(a.app_name,''),NULLIF(a.root_domain,''),'') AS name,
            COALESCE(a.record_type,'') AS record_type,
            a.last_seen,
            l.task_id AS owner_task_id, l.source, COALESCE(l.source_summary,'') AS source_summary,
            l.source_node_id, l.approved_at, COALESCE(l.approved_by,'') AS approved_by,
            COALESCE(l.approval_reason,'') AS approval_reason, l.source_origin,
            task_asset_effective_approval_state($1, a.id) AS effective_state,
            task_asset_blocked($1, a.id) AS blocked,
            b.blocked_at, COALESCE(b.reason,'') AS block_reason,
            COALESCE(b.block_kind,'deleted') AS block_kind, COALESCE(b.blocked_by,'') AS blocked_by,
            COALESCE(b.asset_id = a.id, false) AS block_direct
     FROM task_asset_links l
     JOIN assets a ON a.id = l.asset_id
     LEFT JOIN LATERAL (
       SELECT tb.blocked_at, tb.reason, tb.block_kind, tb.blocked_by, tb.asset_id
       FROM task_asset_blocks tb
       WHERE tb.task_id = $1
         AND (tb.asset_id = a.id OR tb.asset_key = task_asset_identity_key(a)
           OR (tb.asset_type IN ('root_domain','subdomain','ip') AND tb.host_key <> ''
               AND task_asset_host_within(task_asset_host(a), tb.host_key)))
       ORDER BY (tb.asset_id = a.id) DESC, tb.blocked_at DESC
       LIMIT 1
     ) b ON TRUE
     WHERE a.type IN ('root_domain','subdomain','ip')
       AND (l.task_id = $1 OR l.task_id IN (SELECT source_task_id FROM task_relations WHERE task_id = $1))
     ORDER BY a.id, (l.task_id = $1) DESC, l.created_at DESC`,
    [taskID],
  );
  const rows: ApprovalRow[] = linked.rows.map((r) => {
    const ownerTask = Number(r["owner_task_id"]);
    const inherited = ownerTask !== taskID;
    const rawOrigin = r["source_origin"];
    let origins: { activity_id?: number }[] | undefined;
    if (Array.isArray(rawOrigin)) origins = rawOrigin as { activity_id?: number }[];
    else if (rawOrigin && typeof rawOrigin === "object") origins = [rawOrigin as { activity_id?: number }];
    return {
      asset_id: Number(r["asset_id"]),
      asset_type: String(r["asset_type"]),
      name: String(r["name"] ?? ""),
      source: String(r["source"] ?? "legacy"),
      source_summary: String(r["source_summary"] ?? ""),
      source_node_id: r["source_node_id"] === null || r["source_node_id"] === undefined ? undefined : Number(r["source_node_id"]),
      source_task_id: ownerTask,
      inherited,
      read_only: inherited,
      created_at: iso(r["last_seen"]),
      approval_state: String(r["effective_state"] ?? "approved"),
      approved_at: isoOrNull(r["approved_at"]),
      approved_by: String(r["approved_by"] ?? "") || undefined,
      approval_reason: String(r["approval_reason"] ?? "") || undefined,
      blocked: r["blocked"] === true || String(r["effective_state"] ?? "") === "blocked",
      blocked_at: isoOrNull(r["blocked_at"]),
      block_reason: String(r["block_reason"] ?? "") || undefined,
      blocked_by: String(r["blocked_by"] ?? "") || undefined,
      block_kind: String(r["block_kind"] ?? "deleted"),
      block_direct: r["block_direct"] === true,
      record_type: String(r["record_type"] ?? ""),
      origins,
    };
  });

  // 已解挂/已删资产的墓碑行（不再出现在链接视图里，仍需展示 blocked 以便重新关联）。
  const tombs = await db.query(
    `SELECT tb.asset_id, tb.asset_type, tb.blocked_at, COALESCE(tb.reason,'') AS block_reason,
            COALESCE(tb.block_kind,'deleted') AS block_kind, COALESCE(tb.blocked_by,'') AS blocked_by,
            COALESCE(NULLIF(a.url,''),NULLIF(a.domain,''),NULLIF(a.ip,''),NULLIF(a.app_name,''),
                     NULLIF(tb.host_key,''),NULLIF(tb.asset_key,''),'') AS name
     FROM task_asset_blocks tb
     LEFT JOIN assets a ON a.id = tb.asset_id
     WHERE tb.task_id = $1 AND tb.asset_id IS NOT NULL AND tb.asset_type IN ('root_domain','subdomain','ip')
       AND NOT EXISTS (
         SELECT 1 FROM task_asset_links l2
         WHERE l2.asset_id = tb.asset_id
           AND (l2.task_id = $1 OR l2.task_id IN (SELECT source_task_id FROM task_relations WHERE task_id = $1))
       )`,
    [taskID],
  );
  for (const r of tombs.rows) {
    rows.push({
      asset_id: Number(r["asset_id"]),
      asset_type: String(r["asset_type"]),
      name: String(r["name"] ?? ""),
      source: "deleted",
      source_summary: "用户从当前任务删除",
      source_task_id: taskID,
      inherited: false,
      read_only: true,
      created_at: iso(r["blocked_at"]),
      approval_state: "blocked",
      blocked: true,
      blocked_at: iso(r["blocked_at"]),
      block_reason: String(r["block_reason"] ?? ""),
      blocked_by: String(r["blocked_by"] ?? "") || undefined,
      block_kind: String(r["block_kind"] ?? "deleted"),
      record_type: "",
    });
  }
  return rows;
}

function rank(v: ApprovalRow): number {
  if (v.blocked) return 3;
  if (v.approval_state === "revoked") return 2;
  if (v.approval_state === "pending") return 1;
  return 0;
}

/** group_by=host：按 (来源任务, 主机名) 聚合，与 mockApprovalGroups 同形。 */
function groupApprovalRows(rows: ApprovalRow[]): ApprovalRow[] {
  const groups = new Map<string, ApprovalRow>();
  for (const row of rows) {
    const host = row.name.toLowerCase().replace(/\.$/, "");
    const groupKey = `${row.source_task_id}|host:${host}`;
    const old = groups.get(groupKey);
    if (!old) {
      groups.set(groupKey, {
        ...row,
        group_key: groupKey,
        asset_ids: [row.asset_id],
        record_types: row.record_type ? [row.record_type] : [],
        sources: [row.source],
        mixed_state: false,
      });
      continue;
    }
    const rep = rank(old) >= rank(row) ? old : row;
    const ids = [...new Set([...(old.asset_ids ?? []), row.asset_id])];
    const mergedOrigins = [
      ...new Map([...(old.origins ?? []), ...(row.origins ?? [])].map((o) => [o.activity_id, o] as const)).values(),
    ];
    groups.set(groupKey, {
      ...rep,
      created_at: Date.parse(old.created_at) < Date.parse(row.created_at) ? old.created_at : row.created_at,
      origins: mergedOrigins.length > 0 ? mergedOrigins : undefined,
      group_key: groupKey,
      asset_ids: ids,
      record_types: [...new Set([...(old.record_types ?? []), ...(row.record_type ? [row.record_type] : [])])],
      sources: [...new Set([...(old.sources ?? []), row.source])],
      mixed_state: Boolean(old.mixed_state || rank(old) !== rank(row)),
    });
  }
  return [...groups.values()];
}

/** 审批行 DTO（剥掉分组内部字段后按需回填 group 面）。 */
function approvalDTO(r: ApprovalRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    asset_id: r.asset_id,
    asset_type: r.asset_type,
    name: r.name,
    source: r.source,
    source_summary: r.source_summary,
    source_node_id: r.source_node_id,
    source_task_id: r.source_task_id,
    inherited: r.inherited,
    read_only: r.read_only,
    created_at: r.created_at,
    approval_state: r.approval_state,
    approved_at: r.approved_at,
    approved_by: r.approved_by,
    approval_reason: r.approval_reason,
    blocked: r.blocked,
    blocked_at: r.blocked_at,
    block_reason: r.block_reason,
    blocked_by: r.blocked_by,
    block_kind: r.block_kind,
    block_direct: r.block_direct,
  };
  if (r.origins) out["origins"] = r.origins;
  if (r.group_key !== undefined) {
    out["group_key"] = r.group_key;
    out["asset_ids"] = r.asset_ids;
    out["record_types"] = r.record_types;
    out["sources"] = r.sources;
    out["mixed_state"] = r.mixed_state;
  }
  return out;
}

/** TaskAsset* 错误 → HTTP 状态映射（审批/attach 共用）。 */
function taskAssetErrorReply(err: unknown, reply: FastifyReply): unknown {
  if (err instanceof TaskAssetTaskNotFoundError) return reply.code(404).send({ error: "任务不存在" });
  if (err instanceof TaskAssetNotFoundError) return reply.code(404).send({ error: err.message });
  if (err instanceof TaskAssetBlockedError) return reply.code(409).send({ error: err.message });
  if (err instanceof TaskAssetInvalidError) return reply.code(400).send({ error: err.message });
  return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
}

async function taskExists(app: FastifyInstance, taskID: number): Promise<boolean> {
  const res = await app.db.query<{ ok: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM tasks WHERE id=$1 AND deleted_at IS NULL) AS ok`,
    [taskID],
  );
  return res.rows[0]?.ok === true;
}

export function registerApprovalRoutes(app: FastifyInstance): void {
  const db = () => app.db;
  const scopeStore = () => app.db.taskScope();

  // ─── B1：资产审批视图与变更 ────────────────────────────────────────────────

  app.get("/api/tasks/:id/asset-approvals", async (req, reply) => {
    const taskID = Number((req.params as { id: string }).id);
    if (!(await taskExists(app, taskID))) return reply.code(404).send({ error: "任务不存在" });
    const q = req.query as Record<string, unknown>;
    const rows = await approvalRows(app, taskID);
    const items = q["group_by"] === "host" ? groupApprovalRows(rows) : rows;
    return { items: items.map(approvalDTO) };
  });

  const mutateApprovals = async (req: { params: unknown; body?: unknown }, reply: FastifyReply): Promise<unknown> => {
    const p = req.params as { id: string; operation: string };
    const taskID = Number(p.id);
    const operation = p.operation;
    if (operation !== "approve" && operation !== "revoke" && operation !== "block") {
      return reply.code(404).send({ error: "未知审批操作" });
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const reason = typeof b["reason"] === "string" ? b["reason"] : "";
    let ids: number[];
    if (Array.isArray(b["group_keys"])) {
      if (b["asset_ids"] !== undefined || b["group_keys"].length === 0) {
        return reply.code(400).send({ error: "group_keys 与 asset_ids 二选一" });
      }
      const groups = groupApprovalRows(await approvalRows(app, taskID));
      const selected = (b["group_keys"] as unknown[]).map((key) => groups.find((g) => g.group_key === key));
      if (selected.some((g) => !g || g.read_only)) return reply.code(400).send({ error: "分组不存在或来源只读" });
      ids = selected.flatMap((g) => g?.asset_ids ?? []);
    } else if (Array.isArray(b["asset_ids"])) {
      ids = b["asset_ids"].map(Number);
    } else {
      return reply.code(400).send({ error: "asset_ids 必须包含 1-100 个正整数" });
    }

    try {
      if (operation === "approve") {
        await scopeStore().approveTaskAssets(taskID, ids, "user", reason);
      } else if (operation === "revoke") {
        await scopeStore().revokeTaskAssets(taskID, ids, "user", reason);
      } else {
        await blockTaskAssets(app, taskID, ids, reason);
      }
    } catch (err) {
      return taskAssetErrorReply(err, reply);
    }
    const rows = await approvalRows(app, taskID);
    const items = rows.filter((r) => ids.includes(r.asset_id));
    return {
      ok: true,
      asset_ids: ids,
      approval_state: operation === "approve" ? "approved" : operation === "block" ? "blocked" : "revoked",
      items: items.map(approvalDTO),
    };
  };
  app.post("/api/tasks/:id/asset-approvals/:operation", async (req, reply) => mutateApprovals(req, reply));

  // 封禁：manual 墓碑 + 链接置 blocked（Go BlockTaskAssets 语义；与 Approve 同锁串行）。
  async function blockTaskAssets(app2: FastifyInstance, taskID: number, assetIDs: number[], reason: string): Promise<void> {
    const ids = normalizeTaskAssetIDs(assetIDs);
    const why = reason.trim() === "" ? "用户封禁测试授权" : reason.trim();
    const client = await app2.db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock($1)`, [COMPANY_SCOPE_MUTATION_LOCK]);
      const task = await client.query<{ ok: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM tasks WHERE id=$1 AND deleted_at IS NULL) AS ok`,
        [taskID],
      );
      if (task.rows[0]?.ok !== true) throw new TaskAssetTaskNotFoundError();
      const assets = await client.query<Record<string, unknown>>(
        `SELECT a.id, a.type FROM task_asset_links l JOIN assets a ON a.id = l.asset_id
         WHERE l.task_id=$1 AND l.asset_id=ANY($2::bigint[]) FOR UPDATE OF l`,
        [taskID, ids],
      );
      const found = new Set(assets.rows.map((r) => Number(r["id"])));
      for (const id of ids) {
        if (!found.has(id)) throw new TaskAssetNotFoundError(`资产 ${id} 未关联当前任务`);
      }
      for (const r of assets.rows) {
        if (!HOST_ASSET_TYPES.includes(String(r["type"]))) {
          throw new TaskAssetInvalidError("服务和接口无需单独审批，请操作父域名/IP");
        }
      }
      await client.query(
        `INSERT INTO task_asset_blocks(task_id, asset_key, asset_type, host_key, asset_id, reason, blocked_at, blocked_by, block_kind)
         SELECT $1, task_asset_identity_key(a), a.type, task_asset_host(a), a.id, $3, now(), 'user', 'manual'
         FROM assets a WHERE a.id = ANY($2::bigint[])
         ON CONFLICT (task_id, asset_key) DO NOTHING`,
        [taskID, ids, why],
      );
      await client.query(
        `UPDATE task_asset_links SET approval_state='blocked', approved_by='user', approval_reason=$3
         WHERE task_id=$1 AND asset_id=ANY($2::bigint[])`,
        [taskID, ids, why],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // PUT（前端契约）/ PATCH（批次规格别名）：审批模板只允许未启动任务修改。
  const updateTemplate = async (req: { params: unknown; body?: unknown }, reply: FastifyReply): Promise<unknown> => {
    const taskID = Number((req.params as { id: string }).id);
    const value = str((req.body as Record<string, unknown> | undefined)?.["asset_approval_template"]);
    if (!validAssetApprovalTemplate(value)) return reply.code(400).send({ error: "无效审批模板" });
    const cur = await db().query<{ status: string }>(
      `SELECT status FROM tasks WHERE id=$1 AND deleted_at IS NULL`,
      [taskID],
    );
    if (cur.rows.length === 0) return reply.code(404).send({ error: "任务不存在" });
    if (!["created", "queued"].includes(cur.rows[0]!.status)) {
      return reply.code(409).send({ error: "任务已启动，不能修改审批模板" });
    }
    await db().query(`UPDATE tasks SET asset_approval_template=$2 WHERE id=$1`, [taskID, value]);
    return { asset_approval_template: value };
  };
  app.put("/api/tasks/:id/asset-approval-template", async (req, reply) => updateTemplate(req, reply));
  app.patch("/api/tasks/:id/asset-approval-template", async (req, reply) => updateTemplate(req, reply));

  // ─── B1：任务资产 attach / 范围登记 / detach ──────────────────────────────

  // POST /api/tasks/:id/assets — 双形态 body：{scope:[...]}（按范围授权）| {asset_ids, source_summary}（手动挂）。
  const postTaskAssets = async (req: { params: unknown; body?: unknown }, reply: FastifyReply): Promise<unknown> => {
    const taskID = Number((req.params as { id: string }).id);
    if (!(await taskExists(app, taskID))) return reply.code(404).send({ error: "任务不存在" });
    const b = (req.body ?? {}) as Record<string, unknown>;

    if (Array.isArray(b["scope"])) {
      const rules = b["scope"] as unknown[];
      if (rules.length === 0) return reply.code(400).send({ error: "请填写有效测试范围" });
      const reason = typeof b["reason"] === "string" && b["reason"] !== "" ? b["reason"] : "用户在测试资产页手工新增";
      // 先整体校验（企业范围同一套解析规则），再逐条写入——无效输入不落半截。
      for (let i = 0; i < rules.length; i++) {
        const item = rules[i] as { kind?: unknown; value?: unknown };
        const value = str(item?.["value"]);
        try {
          parseScopeInput({ kind: str(item?.["kind"]) || undefined, value });
        } catch (err) {
          return reply
            .code(400)
            .send({ error: `第 ${i + 1} 条范围无效：${err instanceof Error ? err.message : String(err)}` });
        }
      }
      const before = await db().query<{ ids: string; links: string }>(
        `SELECT (SELECT count(*) FROM task_scope WHERE task_id=$1)::text AS ids,
                (SELECT count(*) FROM task_asset_links WHERE task_id=$1)::text AS links`,
        [taskID],
      );
      const scopeRows: { kind: string; domain?: string; net?: string; company_id?: number | null }[] = [];
      for (let i = 0; i < rules.length; i++) {
        const item = rules[i] as { kind?: unknown; value?: unknown };
        const kindRaw = str(item?.["kind"]);
        const value = str(item?.["value"]).trim();
        // 企业范围 kind（domain）→ 任务范围 kind（root_domain）；其余同名复用 addAgentScope 的归一化。
        const kind = kindRaw === "domain" ? "root_domain" : kindRaw;
        try {
          const ts = await scopeStore().addAgentScope(taskID, kind, value, reason, "manual");
          scopeRows.push(ts);
        } catch (err) {
          return reply
            .code(400)
            .send({ error: `第 ${i + 1} 条范围无效：${err instanceof Error ? err.message : String(err)}` });
        }
      }
      const after = await db().query<{ ids: string; links: string }>(
        `SELECT (SELECT count(*) FROM task_scope WHERE task_id=$1)::text AS ids,
                (SELECT count(*) FROM task_asset_links WHERE task_id=$1)::text AS links`,
        [taskID],
      );
      const scopesAdded = Number(after.rows[0]?.ids ?? 0) - Number(before.rows[0]?.ids ?? 0);
      const linksBefore = Number(before.rows[0]?.links ?? 0);
      const linksAfter = Number(after.rows[0]?.links ?? 0);
      // 范围命中的已挂资产数（domain/net 条件 OR 连接）。
      const conds: string[] = [];
      const args: unknown[] = [taskID];
      for (const ts of scopeRows) {
        if (ts.kind === "company" && ts.company_id) {
          args.push(ts.company_id);
          conds.push(`a.company_id=$${args.length}`);
        } else if ((ts.kind === "root_domain" || ts.kind === "subdomain") && ts.domain) {
          args.push(ts.domain);
          conds.push(`a.root_domain=$${args.length} OR a.domain=$${args.length}`);
        } else if ((ts.kind === "ip" || ts.kind === "cidr") && ts.net) {
          args.push(ts.net);
          conds.push(`(try_inet(a.ip) IS NOT NULL AND $${args.length}::cidr >>= try_inet(a.ip))`);
        }
      }
      let assetsExisting = 0;
      if (conds.length > 0) {
        const matched = await db().query<{ n: string }>(
          `SELECT count(*) AS n FROM assets a WHERE (${conds.join(" OR (")})${")".repeat(conds.length - 1)}
           AND EXISTS(SELECT 1 FROM task_asset_links l WHERE l.task_id=$1 AND l.asset_id=a.id)`,
          args,
        );
        assetsExisting = Math.max(0, Number(matched.rows[0]?.n ?? 0) - (linksAfter - linksBefore));
      }
      return {
        requested: rules.length,
        assets_linked: linksAfter - linksBefore,
        assets_existing: assetsExisting,
        scopes_added: scopesAdded,
        scopes_existing: rules.length - scopesAdded,
      };
    }

    // attach：手动挂既有资产进任务（manual 来源 + approved + 清 manual 墓碑）。
    const rawIDs = Array.isArray(b["asset_ids"]) ? b["asset_ids"].map(Number) : [];
    const sourceSummary = str(b["source_summary"]).trim();
    let ids: number[];
    try {
      ids = normalizeTaskAssetIDs(rawIDs);
    } catch (err) {
      return taskAssetErrorReply(err, reply);
    }
    if (sourceSummary === "") return reply.code(400).send({ error: "请选择资产并填写来源说明" });
    const client = await db().pool.connect();
    let attached = 0;
    let existing = 0;
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock($1)`, [COMPANY_SCOPE_MUTATION_LOCK]);
      const task = await client.query<{ ok: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM tasks WHERE id=$1 AND deleted_at IS NULL) AS ok`,
        [taskID],
      );
      if (task.rows[0]?.ok !== true) throw new TaskAssetTaskNotFoundError();
      for (const id of ids) {
        const had = await client.query<{ ok: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM task_asset_links WHERE task_id=$1 AND asset_id=$2) AS ok`,
          [taskID, id],
        );
        await client.query(
          `UPDATE assets SET task_ids=CASE WHEN $1=ANY(task_ids) THEN task_ids ELSE array_append(task_ids,$1) END WHERE id=$2`,
          [taskID, id],
        );
        // 触发器 sync_task_asset_links 已按 system/agent 语义补链；这里覆写 manual 审批面。
        await client.query(
          `INSERT INTO task_asset_links(task_id,asset_id,source,source_summary,approval_state,approved_at,approved_by,approval_reason)
           VALUES ($1,$2,'manual',$3,'approved',now(),'user','手动关联')
           ON CONFLICT(task_id,asset_id) DO UPDATE SET source='manual',source_summary=EXCLUDED.source_summary,
             source_node_id=NULL,approval_state='approved',approved_at=now(),approved_by='user',approval_reason='手动关联'`,
          [taskID, id, sourceSummary],
        );
        // 重新关联即显式恢复授权：清该资产身份上的全部任务墓碑（manual 封禁与 deleted 删除）。
        await client.query(
          `DELETE FROM task_asset_blocks b USING assets a
           WHERE b.task_id=$1 AND a.id=$2
             AND (b.asset_id=a.id OR b.asset_key=task_asset_identity_key(a))`,
          [taskID, id],
        );
        if (had.rows[0]?.ok === true) existing++;
        else attached++;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      return taskAssetErrorReply(err, reply);
    }
    client.release();
    return { requested: ids.length, attached, existing };
  };
  app.post("/api/tasks/:id/assets", async (req, reply) => postTaskAssets(req, reply));
  app.post("/api/tasks/:id/assets/register-scopes", async (req, reply) => postTaskAssets(req, reply));

  // 解挂：删当前任务链接 + 从 task_ids 摘除 + 写 deleted 墓碑（继承来源只写墓碑）。
  async function detachAssets(taskID: number, assetIDs: number[]): Promise<number> {
    const client = await db().pool.connect();
    let detached = 0;
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock($1)`, [COMPANY_SCOPE_MUTATION_LOCK]);
      for (const id of assetIDs) {
        const row = await client.query<{ type: string; own: boolean; linked: boolean }>(
          `SELECT a.type,
             EXISTS(SELECT 1 FROM task_asset_links l2 WHERE l2.task_id=$1 AND l2.asset_id=a.id) AS own,
             EXISTS(SELECT 1 FROM task_asset_links l3
                    WHERE l3.asset_id=a.id
                      AND (l3.task_id=$1 OR l3.task_id IN (SELECT source_task_id FROM task_relations WHERE task_id=$1))) AS linked
           FROM assets a WHERE a.id=$2`,
          [taskID, id],
        );
        const asset = row.rows[0];
        if (!asset || !asset.linked) throw new TaskAssetNotFoundError(`资产 ${id} 未关联当前任务或来源任务`);
        await client.query(
          `INSERT INTO task_asset_blocks(task_id,asset_key,asset_type,host_key,asset_id,reason,blocked_at,blocked_by,block_kind)
           SELECT $1, task_asset_identity_key(a), a.type, task_asset_host(a), a.id, '用户从当前任务删除，禁止再次测试', now(), 'user', 'deleted'
           FROM assets a WHERE a.id=$2
           ON CONFLICT (task_id, asset_key) DO NOTHING`,
          [taskID, id],
        );
        if (asset.own === true) {
          await client.query(
            `UPDATE assets SET task_ids=ARRAY(SELECT tid FROM unnest(task_ids) AS t(tid) WHERE tid<>$1) WHERE id=$2`,
            [taskID, id],
          );
          await client.query(`DELETE FROM task_asset_links WHERE task_id=$1 AND asset_id=$2`, [taskID, id]);
        }
        detached++;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return detached;
  }

  app.post("/api/tasks/:id/assets/detach", async (req, reply) => {
    const taskID = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(b["asset_ids"])) return reply.code(400).send({ error: "asset_ids 不能为空" });
    try {
      const ids = normalizeTaskAssetIDs(b["asset_ids"].map(Number));
      const detached = await detachAssets(taskID, ids);
      return { detached };
    } catch (err) {
      return taskAssetErrorReply(err, reply);
    }
  });

  app.delete("/api/tasks/:id/assets/:assetId", async (req, reply) => {
    const taskID = Number((req.params as { id: string }).id);
    const assetId = Number((req.params as { assetId: string }).assetId);
    try {
      const detached = await detachAssets(taskID, [assetId]);
      return { detached };
    } catch (err) {
      return taskAssetErrorReply(err, reply);
    }
  });

  // ─── B3：企业与资产 ────────────────────────────────────────────────────────

  app.post("/api/companies", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = str(b["name"]).trim();
    if (name === "") return reply.code(400).send({ error: "企业名称不能为空" });
    const scope = Array.isArray(b["scope"]) ? (b["scope"] as ScopeInput[]) : [];
    try {
      const res = await db().assets().companies.createCompanyWithScope(name, "", scope, "用户创建企业");
      return reply.code(201).send({
        id: res.id,
        created: true,
        scope_added: res.added,
        scope_skipped: res.skipped,
        scope_invalid: res.invalid,
        scope_errors: res.validationErrors,
      });
    } catch (err) {
      if (err instanceof CompanyNameConflictError) return reply.code(409).send({ error: "企业已存在" });
      throw err;
    }
  });

  // POST /api/companies/:id/scope — 追加；reset=true 覆盖（无效规则先拒绝，不动旧范围）。
  app.post("/api/companies/:id/scope", async (req, reply) => {
    const companyID = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(b["scope"])) return reply.code(400).send({ error: "scope 不能为空" });
    const inputs = b["scope"] as ScopeInput[];
    const reason = str(b["reason"]);
    const reset = b["reset"] === true;
    if (reset) {
      let invalid = 0;
      const errors: string[] = [];
      for (let i = 0; i < inputs.length; i++) {
        try {
          parseScopeInput(inputs[i]!);
        } catch (err) {
          invalid++;
          errors.push(`${inputs[i]!.value}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (invalid > 0) return reply.code(400).send({ error: "企业范围包含无效规则，未覆盖原有范围", errors });
    }
    try {
      const exists = await db().query<{ ok: boolean }>(`SELECT EXISTS(SELECT 1 FROM companies WHERE id=$1) AS ok`, [
        companyID,
      ]);
      if (exists.rows[0]?.ok !== true) return reply.code(404).send({ error: "企业不存在" });
      if (reset) {
        const client = await db().pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SELECT pg_advisory_xact_lock($1)`, [COMPANY_SCOPE_MUTATION_LOCK]);
          await client.query(`DELETE FROM company_scope WHERE company_id=$1`, [companyID]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
      }
      const res = await db().assets().companies.addScopeInputsChecked(companyID, inputs, reason);
      return { added: res.added, skipped: res.skipped, invalid: res.invalid, errors: res.validationErrors };
    } catch (err) {
      if (err instanceof CompanyNotFoundError) return reply.code(404).send({ error: "企业不存在" });
      throw err;
    }
  });

  // PATCH /api/companies/:id/scope/:sid — 单行替换（删旧插新 + 重建派生归属）。
  app.patch("/api/companies/:id/scope/:sid", async (req, reply) => {
    const p = req.params as { id: string; sid: string };
    const companyID = Number(p.id);
    const sid = Number(p.sid);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const input: ScopeInput = { kind: str(b["kind"]) || undefined, value: str(b["value"]) };
    let rule;
    try {
      rule = parseScopeInput(input);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    const reason = str(b["reason"]);
    const client = await db().pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock($1)`, [COMPANY_SCOPE_MUTATION_LOCK]);
      const del = await client.query(`DELETE FROM company_scope WHERE id=$1 AND company_id=$2 RETURNING id`, [sid, companyID]);
      if (del.rows.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "范围行不存在" });
      }
      const ins = await client.query<Record<string, unknown>>(
        `INSERT INTO company_scope(company_id, kind, domain, net, raw, reason)
         VALUES ($1, $2, $3, $4::cidr, $5, NULLIF($6,'')) RETURNING id, kind,
           COALESCE(domain,'') AS domain, COALESCE(net::text,'') AS net, COALESCE(value,'') AS value, raw`,
        [
          companyID,
          rule.kind,
          rule.domain ?? null,
          rule.net ?? null,
          rule.raw,
          reason,
        ],
      );
      await client.query("COMMIT");
      await db().assets().companies.recomputeAttribution();
      const r = ins.rows[0]!;
      return {
        id: Number(r["id"]),
        company_id: companyID,
        kind: String(r["kind"]),
        domain: String(r["domain"]),
        net: String(r["net"]),
        value: String(r["value"]),
        raw: String(r["raw"]),
        reason,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });

  app.delete("/api/companies/:id/scope/:sid", async (req, reply) => {
    const p = req.params as { id: string; sid: string };
    const del = await db().query(`DELETE FROM company_scope WHERE id=$1 AND company_id=$2 RETURNING id`, [
      Number(p.sid),
      Number(p.id),
    ]);
    if (del.rows.length === 0) return reply.code(404).send({ error: "范围行不存在" });
    await db().assets().companies.recomputeAttribution();
    return { deleted: del.rows.length };
  });

  // PATCH /api/companies/:id — 最小改名（nkey 随动，唯一冲突 → 409）。
  app.patch("/api/companies/:id", async (req, reply) => {
    const companyID = Number((req.params as { id: string }).id);
    const name = str((req.body as Record<string, unknown> | undefined)?.["name"]).trim();
    if (name === "") return reply.code(400).send({ error: "企业名称不能为空" });
    const nkey = name.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
    try {
      const res = await db().query(`UPDATE companies SET name=$2, nkey=$3 WHERE id=$1 RETURNING id, COALESCE(logo,'') AS logo`, [
        companyID,
        name,
        nkey,
      ]);
      if (res.rows.length === 0) return reply.code(404).send({ error: "企业不存在" });
      return { id: Number(res.rows[0]!["id"]), name, logo: String(res.rows[0]!["logo"]) };
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return reply.code(409).send({ error: "企业已存在" });
      throw err;
    }
  });

  app.delete("/api/companies/:id", async (req, reply) => {
    const companyID = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const exists = await db().query<{ ok: boolean }>(`SELECT EXISTS(SELECT 1 FROM companies WHERE id=$1) AS ok`, [
      companyID,
    ]);
    if (exists.rows[0]?.ok !== true) return reply.code(404).send({ error: "企业不存在" });
    let assetsDeleted = 0;
    if (b["delete_assets"] === true) {
      await db().query(
        `INSERT INTO task_asset_blocks(task_id,asset_key,asset_type,host_key,asset_id,reason,blocked_at,blocked_by,block_kind)
         SELECT l.task_id, task_asset_identity_key(a), a.type, task_asset_host(a), a.id, '资产已删除，禁止再次测试', now(), 'user', 'deleted'
         FROM task_asset_links l JOIN assets a ON a.id=l.asset_id WHERE a.company_id=$1
         ON CONFLICT (task_id, asset_key) DO NOTHING`,
        [companyID],
      );
      const del = await db().query(`DELETE FROM assets WHERE company_id=$1 RETURNING id`, [companyID]);
      assetsDeleted = del.rows.length;
    }
    await db().query(`DELETE FROM companies WHERE id=$1`, [companyID]);
    return { deleted: 1, assets_deleted: assetsDeleted };
  });

  // DELETE /api/assets — 批量删资产（ids 或 hosts），级联 task_asset_links 前先写 deleted 墓碑。
  app.delete("/api/assets", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ids = new Set<number>((Array.isArray(b["ids"]) ? b["ids"] : []).map(Number).filter((n) => Number.isInteger(n) && n > 0));
    const hosts = (Array.isArray(b["hosts"]) ? b["hosts"] : []).map(String).filter((h) => h.trim() !== "");
    if (ids.size === 0 && hosts.length === 0) return reply.code(400).send({ error: "ids 或 hosts 不能为空" });
    if (hosts.length > 0) {
      const res = await db().query<{ id: string }>(
        `SELECT id FROM assets WHERE domain=ANY($1::text[]) OR ip=ANY($1::text[]) OR url=ANY($2::text[])`,
        [hosts, hosts.map((h) => `http://${h}/`)],
      );
      for (const r of res.rows) ids.add(Number(r.id));
    }
    if (ids.size === 0) return { deleted: 0 };
    const idList = [...ids];
    await db().query(
      `INSERT INTO task_asset_blocks(task_id,asset_key,asset_type,host_key,asset_id,reason,blocked_at,blocked_by,block_kind)
       SELECT l.task_id, task_asset_identity_key(a), a.type, task_asset_host(a), a.id, '资产已删除，禁止再次测试', now(), 'user', 'deleted'
       FROM task_asset_links l JOIN assets a ON a.id=l.asset_id WHERE a.id=ANY($1::bigint[])
       ON CONFLICT (task_id, asset_key) DO NOTHING`,
      [idList],
    );
    const del = await db().query(`DELETE FROM assets WHERE id=ANY($1::bigint[]) RETURNING id`, [idList]);
    return { deleted: del.rows.length };
  });
}
