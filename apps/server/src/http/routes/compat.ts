import {activityControlFields} from '../../engine/activity-presentation.js';
import {readActivityPage,readActivityContent,readSnapshotContent} from '../../db/activity-content.js';
import {aggregateUsage,unverifiedUsageHistory} from '../../db/usage-ledger.js';
import {READABLE_FINDINGS} from "./finding-projection.js";
import {modelTokenUsage} from '../model-token-usage.js';
import {executionSnapshot} from '../../engine/coordinator.js';
import { resolveModelProfiles } from "../../pi/modelResolver.js";

import type { FastifyInstance } from "fastify";
import { makeFindingsAssetTreeHandler, makeFindingsExportHandler, taskFindingsWhere } from "./findings-extra.js";

function mapActivity(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    seq: Number(row["id"]),
    metadata: row["metadata"] ?? {},
    ...Object.fromEntries(["turn_id","stream_id","channel","interrupted"].map(k=>[k,(row["metadata"] as Record<string,unknown>|undefined)?.[k]])),
    worker: row["worker"] === "main" ? "mainagent" : String(row["worker"] ?? ""),
    ts: row["created_at"] instanceof Date ? (row["created_at"] as Date).toISOString() : String(row["created_at"] ?? ""),
    kind: String(row["kind"] ?? ""),
    summary: String(row["summary"] ?? ""),
    is_error: row["is_error"] === true,
    ...Object.fromEntries(['detail','detail_total_chars','detail_truncated','detail_version','summary_truncated','metadata_truncated'].filter(k=>row[k]!==undefined).map(k=>[k,row[k]])),
  };
  if (row["node_id"] !== null && row["node_id"] !== undefined) out["intent_id"] = String(row["node_id"]);
  if (row["tool"]) out["tool"] = row["tool"];
  if (row["tool_use_id"]) out["tool_use_id"] = row["tool_use_id"];
  if (row["main_seg"] !== null && row["main_seg"] !== undefined) out["main_seg"] = Number(row["main_seg"]);
  for (const k of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"] as const) {
    if (row[k] !== null && row[k] !== undefined) out[k] = Number(row[k]);
  }
  return {...out,...activityControlFields(row)};
}

function mapFinding(row: Record<string, unknown>, task?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: String(row["node_id"] ?? row["id"]),
    ...(Number(row["id"])>0?{finding_id:String(row["id"])}:{}),
    vulnclass: String(row["vulnclass"] ?? ""),
    name: String(row["name"] ?? ""),
    severity: String(row["severity"] ?? "medium"),
    status: String(row["status"] ?? "pending"),
    summary: String(row["summary"] ?? ""),
    evidence: String(row["evidence"] ?? ""),
    ts: row["created_at"] instanceof Date ? (row["created_at"] as Date).toISOString() : String(row["created_at"] ?? ""),
    traffic_count: Number(row["traffic_count"] ?? 0),
    image_count: Number(row["image_count"] ?? 0),
    evidence_version: Number(row["evidence_version"] ?? 0),
    report_evidence_version: Number(row["report_evidence_version"] ?? 0),
    report_stale: Number(row["evidence_version"] ?? 0) > Number(row["report_evidence_version"] ?? 0),
  };
  if (row["task_id"]) out["task_id"] = String(row["task_id"]);
  if (task) {
    out["task_description"] = String(task["description"] ?? "");
  }
  return out;
}

export function registerCompatRoutes(app: FastifyInstance): void {
  const db = () => app.db;

  /** task id → exploration id（含存在性）。 */
  async function expOf(taskID: number): Promise<number> {
    const res = await db().query<{ exploration_id: number }>(
      `SELECT exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL`,
      [taskID],
    );
    const row = res.rows[0];
    if (!row) throw Object.assign(new Error("任务不存在"), { statusCode: 404 });
    return Number(row.exploration_id);
  }

  async function taskRow(taskID: number): Promise<Record<string, unknown> | undefined> {
    const res = await db().query(`SELECT * FROM tasks WHERE id=$1`, [taskID]);
    return res.rows[0];
  }


  function q2n(v: unknown, dflt: number): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  }

  // ─── 探索图（graph / nodes / node detail）─────────────────────────────────

  app.get('/api/exploration/streams/:stream',async req=>{
    const q=req.query as Record<string,string>,expID=await expOf(Number(q.task));
    return readSnapshotContent(db(),'task',expID,(req.params as {stream:string}).stream,q);
  });

  app.get("/api/exploration/activity", async (req) => {
    const q = req.query as Record<string, string>;
    const expID = await expOf(q2n(q["task"], 0));
    const params: unknown[] = [expID];
    let where = `exploration_id=$1 AND (kind<>'round' OR worker='planner') AND exploration_activity_readable($1,node_id,metadata)`;
    if (q["intent"]) {
      params.push(Number(q["intent"]));
      where += ` AND node_id=$${params.length}`;
    }
    if (q["since"] && Number(q["since"]) > 0) {
      params.push(Number(q["since"]));
      where += ` AND id > $${params.length}`;
    }
    const limit=Math.min(q2n(q["limit"], 200), 1000);
    const forward=q.since!==undefined;
    const rows = await readActivityPage(db(),'task',where,params,forward?'ASC':'DESC',limit);
    const ordered=forward?rows.rows:rows.rows.reverse();
    return { items: ordered.map(mapActivity), cursor: Number(ordered.at(-1)?.id ?? q.since ?? 0), has_more: rows.hasMore };
  });

  app.get("/api/exploration/activity/:id", async (req) => {
    const p = req.params as Record<string, string>;
    const q=req.query as Record<string,string>,params:unknown[]=[Number(p.id)];
    let where='id=$1 AND exploration_activity_readable(exploration_id,node_id,metadata)';
    if(q.task!==undefined){
      const taskID=Number(q.task);await expOf(taskID);params.push(taskID);
      where+=` AND exploration_id IN (SELECT exploration_id FROM tasks WHERE deleted_at IS NULL AND (id=$2 OR id IN (SELECT source_task_id FROM task_relations WHERE task_id=$2)))`;
    }
    return readActivityContent(db(),'task',where,params,q);
  });

  app.get("/api/exploration/activity/history", async (req) => {
    const q = req.query as Record<string, string>;
    const expID = await expOf(q2n(q["task"], 0));
    const session = q["session"] ?? "main";
    const before = q2n(q["before"], 0);
    const limit = Math.min(q2n(q["limit"], 200), 500);
    const snap = await db().query<{ m: string | null }>(`SELECT max(id) AS m FROM activity WHERE exploration_id=$1`, [expID]);
    const snapshot = Number(snap.rows[0]?.m ?? 0);
    const params: unknown[] = [expID, snapshot];
    let sessionWhere = ` AND exploration_activity_readable($1,node_id,metadata)`;
    if (session === "main" || /^main:\d+$/.test(session)) {
      params.push(session.startsWith("main:") ? Number(session.slice(5)) : Number(q["seg"]) || 0);
      sessionWhere += ` AND worker IN ('mainagent','main') AND COALESCE(main_seg,0)=$${params.length}`;
    }
    else if (session === "plan") sessionWhere += ` AND worker IN ('planner','goals')`;
    else if (session.startsWith("intent:")) {
      params.push(Number(session.slice("intent:".length)));
      sessionWhere += ` AND node_id=$${params.length}`;
    }
    if (session === "main" && q["seg"] !== undefined) {
      params.push(Number(q["seg"]) || 0);
      sessionWhere += ` AND COALESCE(main_seg,0)=$${params.length}`;
    }
    if (before > 0) {
      params.push(before);
      var rows = await readActivityPage(db(),'task',`exploration_id=$1 AND id <= $2 AND (kind<>'round' OR worker='planner')${sessionWhere} AND id < $${params.length}`,params,'DESC',limit);
    } else {
      var rows = await readActivityPage(db(),'task',`exploration_id=$1 AND id <= $2 AND (kind<>'round' OR worker='planner')${sessionWhere}`,params,'DESC',limit);
    }
    const items = rows.rows.map(mapActivity).reverse();
    return {
      items,
      snapshot_cursor: snapshot,
      earliest_cursor: items.length > 0 ? Number(rows.rows[rows.rows.length - 1]!["id"]) : 0,
      latest_cursor: items.length > 0 ? Number(rows.rows[0]!["id"]) : 0,
      has_newer: items.length > 0 ? Number(rows.rows[0]!["id"]) < snapshot : false,
      has_more: rows.hasMore,
    };
  });

  // 会话内关键词搜索（session-search 弹层）：session 过滤同 history（main→worker
  // mainagent/main、plan→planner、intent:N→node_id），summary ILIKE q，id 倒序翻页。
  app.get("/api/exploration/activity/search", async (req) => {
    const q = req.query as Record<string, string>;
    const expID = await expOf(q2n(q["task"], 0));
    const session = q["session"] ?? "main";
    const needle = (q["q"] ?? "").trim();
    const cursor = q2n(q["cursor"], 0);
    const limit = Math.min(Math.max(q2n(q["limit"], 20), 1), 100);
    const params: unknown[] = [expID];
    let where = `exploration_id=$1 AND exploration_activity_readable($1,node_id,metadata)`;
    if (session === "main") where += ` AND worker IN ('mainagent','main')`;
    else if (session === "plan") where += ` AND worker IN ('planner','goals')`;
    else if (session.startsWith("intent:")) {
      params.push(Number(session.slice("intent:".length)));
      where += ` AND node_id=$${params.length}`;
    }
    if (cursor > 0) {
      params.push(cursor);
      where += ` AND id < $${params.length}`;
    }
    if (needle !== "") {
      params.push(`%${needle}%`);
      where += ` AND summary ILIKE $${params.length}`;
    }
    const rows = await db().query(
      `SELECT id, kind, summary, metadata FROM activity WHERE ${where} ORDER BY id DESC LIMIT $${params.length + 1}`,
      [...params, limit + 1],
    );
    const items = rows.rows.slice(0, limit).map((r) => ({
      id: Number(r["id"]),
      kind: String(r["kind"] ?? ""),
      snippet: String(r["summary"] ?? "").slice(0, 240),
      ...activityControlFields(r),
    }));
    return { items, next_cursor: rows.rows.length > limit ? String(items[items.length - 1]!.id) : "" };
  });

  // 主对话分段：段 0 隐式（建任务即有），main_sessions 只存"新建会话"产生的 seq>=1 段。
  app.get("/api/exploration/main-sessions", async (req) => {
    const q = req.query as Record<string, string>;
    const expID = await expOf(q2n(q["task"], 0));
    const t = await db().query<{ created_at: Date }>(`SELECT created_at FROM explorations WHERE id=$1`, [expID]);
    const rows = await db().query<{ seq: number; created_at: Date }>(
      `SELECT seq, created_at FROM main_sessions WHERE exploration_id=$1 ORDER BY seq`,
      [expID],
    );
    const sessions = [
      { seq: 0, created_at: t.rows[0]?.created_at ?? new Date() },
      ...rows.rows.map((r) => ({ seq: Number(r["seq"]), created_at: r["created_at"] })),
    ];
    return { sessions, current: sessions[sessions.length - 1]!.seq };
  });

  app.get("/api/exploration/findings", async (req) => {
    const q = req.query as Record<string, string>;
    if (q.legacy_node) {
      const nodeID = Number(q.legacy_node);
      if (!/^\d+$/.test(q.legacy_node) || !Number.isSafeInteger(nodeID) || nodeID < 1) {
        throw Object.assign(new Error("发现节点编号无效"), { statusCode: 400 });
      }
      const context = q.context_task ?? q.task ?? "";
      const { where, params } = await taskFindingsWhere(db(), {}, context);
      const row = (await db().query(
        `SELECT * FROM ${READABLE_FINDINGS} f${where} AND f.node_id=$${params.length + 1}`,
        [...params, nodeID],
      )).rows[0];
      if (!row) throw Object.assign(new Error("发现不存在或不属于当前任务及直接来源任务"), { statusCode: 404 });
      const owner = Number(row.task_id);
      return {
        ...mapFinding(row, await taskRow(owner)), report: row.report,
        ...(owner !== Number(context) ? { inherited: true, source_task_id: String(owner) } : {}),
      };
    }
    const page = Math.max(q2n(q["page"], 1), 1);
    const limit = Math.min(Math.max(q2n(q["limit"], 20), 1), 100);
    let params: unknown[] = [];
    let where = ` WHERE true`;
    const contextTask = q["context_task"] ?? q["task"] ?? q["task_id"];
    if (q.context_task !== undefined) {
      ({ where, params } = await taskFindingsWhere(db(), q, q.context_task));
    } else {
      if (contextTask && Number(contextTask) > 0) {
        params.push(Number(contextTask));
        where += ` AND (f.task_id=$${params.length} OR f.task_id IN (SELECT source_task_id FROM task_relations WHERE task_id=$${params.length}))`;
      }
      if (q["severity"] && q["severity"] !== "all") {
        params.push(q["severity"].split(","));
        where += ` AND f.severity=ANY($${params.length}::text[])`;
      }
      if (q["status"] && q["status"] !== "all") {
        params.push(q["status"].split(","));
        where += ` AND f.status=ANY($${params.length}::text[])`;
      }
      if (q["q"]) {
        params.push(`%${q["q"]}%`);
        where += ` AND (f.summary ILIKE $${params.length} OR f.name ILIKE $${params.length} OR f.vulnclass ILIKE $${params.length})`;
      }
      if (q.vulnclass && q.vulnclass !== "all") {
        params.push(q.vulnclass);
        where += ` AND f.vulnclass=$${params.length}`;
      }
    }
    const total = await db().query<{ n: string }>(`SELECT count(*) AS n FROM ${READABLE_FINDINGS} f${where}`, params);
    const rows = await db().query(
      `SELECT f.*,(SELECT count(*) FROM finding_traffic_bindings b WHERE b.finding_id=f.id) AS traffic_count,(SELECT count(*) FROM finding_step_images im WHERE im.finding_id=f.id) AS image_count FROM ${READABLE_FINDINGS} f${where} ORDER BY f.created_at ${q.direction==='asc'?'ASC':'DESC'},f.id ${q.direction==='asc'?'ASC':'DESC'} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit],
    );
    const taskCache = new Map<number, Record<string, unknown>>();
    const assetIDs=[...new Set(rows.rows.flatMap(r=>Array.isArray(r.asset_ids)?r.asset_ids.map(Number):[]))];
    const assetMap=new Map((await db().assets().getByIDs(assetIDs)).map(a=>[a.id,{id:String(a.id),type:a.type,label:a.domain||a.ip||a.url||a.app_name||a.bundle_id||String(a.id)}]));
    const items = [];
    for (const r of rows.rows) {
      const tid = Number(r["task_id"] ?? 0);
      if (tid > 0 && !taskCache.has(tid)) taskCache.set(tid, (await taskRow(tid)) ?? {});
      const item=mapFinding(r,taskCache.get(tid));
      item.assets=(Array.isArray(r.asset_ids)?r.asset_ids:[]).map(id=>assetMap.get(Number(id))).filter(Boolean);
      if(contextTask && Number(contextTask)!==tid){item.inherited=true;item.source_task_id=String(tid);}
      items.push(item);
    }
    return { items, total: Number(total.rows[0]?.n ?? 0), page, page_size: limit };
  });

  app.get("/api/exploration/findings/stats", async () => {
    const rows = await db().query(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE status='pending') AS pending,
              count(*) FILTER (WHERE severity='critical') AS critical,
              count(*) FILTER (WHERE severity='high') AS high,
              count(*) FILTER (WHERE severity='medium') AS medium,
              count(*) FILTER (WHERE severity='low') AS low,
              array_agg(DISTINCT vulnclass) FILTER (WHERE vulnclass <> '') AS vulnclasses
       FROM ${READABLE_FINDINGS} findings WHERE true`,
    );
    const r = rows.rows[0] ?? {};
    const tasks = await db().query(
      `SELECT f.task_id::text AS id, t.description AS description, count(*) AS count FROM ${READABLE_FINDINGS} f
       LEFT JOIN tasks t ON t.id=f.task_id WHERE true GROUP BY f.task_id, t.description ORDER BY count DESC LIMIT 50`,
    );
    return {
      total: Number(r["total"] ?? 0),
      pending: Number(r["pending"] ?? 0),
      critical: Number(r["critical"] ?? 0),
      high: Number(r["high"] ?? 0),
      medium: Number(r["medium"] ?? 0),
      low: Number(r["low"] ?? 0),
      vulnclasses: (r["vulnclasses"] as string[]) ?? [],
      tasks: tasks.rows,
    };
  });

  app.get("/api/exploration/findings/groups", async (req) => {
    const q = req.query as Record<string, string>;
    const page = Math.max(q2n(q["page"], 1), 1);
    const limit = Math.min(Math.max(q2n(q["limit"], 20), 1), 100);
    const rows = await db().query(
      `SELECT f.task_id::text AS task_id, COALESCE(t.name,'') AS task_name, COALESCE(t.description,'') AS task_description,
              COALESCE(t.status,'') AS task_status, count(*) AS count,
              count(*) FILTER (WHERE f.severity='critical') AS critical,
              count(*) FILTER (WHERE f.severity='high') AS high,
              count(*) FILTER (WHERE f.severity='medium') AS medium,
              count(*) FILTER (WHERE f.severity='low') AS low,
              max(f.created_at)::text AS last_found_at
       FROM ${READABLE_FINDINGS} f LEFT JOIN tasks t ON t.id=f.task_id WHERE true
       GROUP BY f.task_id, t.name, t.description, t.status ORDER BY max(f.created_at) DESC LIMIT $1 OFFSET $2`,
      [limit, (page - 1) * limit],
    );
    const findingTotal = await db().query<{ n: string }>(`SELECT count(*) AS n FROM ${READABLE_FINDINGS} findings WHERE true`);
    return {
      items: rows.rows.map((r) => ({
        task_id: r["task_id"],
        task_name: r["task_name"],
        task_description: r["task_description"],
        task_status: r["task_status"],
        count: Number(r["count"]),
        critical: Number(r["critical"]),
        high: Number(r["high"]),
        medium: Number(r["medium"]),
        low: Number(r["low"]),
        last_found_at: r["last_found_at"],
      })),
      total: rows.rows.length,
      finding_total: Number(findingTotal.rows[0]?.n ?? 0),
      page,
      page_size: limit,
    };
  });

  async function findingByAnyId(idStr: string, record=false): Promise<Record<string, unknown>> {
    const id = Number(idStr);
    if (!/^\d+$/.test(idStr) || !Number.isSafeInteger(id) || id < 1) {
      throw Object.assign(new Error("漏洞编号无效"), { statusCode: 400 });
    }
    let res = await db().query(record?`SELECT * FROM findings WHERE id=$1`:`SELECT * FROM findings WHERE node_id=$1`, [id]);
    if (res.rows.length === 0 && !record) res = await db().query(`SELECT * FROM findings WHERE id=$1`, [id]);
    const row = res.rows[0];
    if (!row) throw Object.assign(new Error("漏洞不存在"), { statusCode: 404 });
    return row;
  }

  app.get("/api/exploration/findings/:id", async (req) => {
    const p = req.params as Record<string, string>;
    const row = await findingByAnyIDGuard(p["id"]!,(req.query as Record<string,string>).id_kind==='record');
    const tid = Number(row["task_id"] ?? 0);
    const out = mapFinding(row, tid > 0 ? await taskRow(tid) : undefined);
    const context = (req.query as Record<string, string>).context_task;
    if (context !== undefined) {
      const scope = await taskFindingsWhere(db(), {}, context);
      const allowed = await db().query(`SELECT 1 FROM findings f${scope.where} AND f.id=$${scope.params.length + 1}`,
        [...scope.params, Number(row.id)]);
      if (!allowed.rowCount) throw Object.assign(new Error("漏洞不属于任务及直接来源任务"), { statusCode: 403 });
      if (Number(context) !== tid) { out.inherited = true; out.source_task_id = String(tid); }
    }
    out["report"] = String(row["report"] ?? "");
    out["reproduction"]=row.reproduction??null;out["report_sections"]=row.report_sections??null;out["report_revision"]=Number(row.report_revision??0);
    const assetIDs = Array.isArray(row["asset_ids"]) ? (row["asset_ids"] as number[]) : [];
    if (assetIDs.length > 0) {
      const assets = await db().assets().getByIDs(assetIDs);
      out["assets"] = assets.map((a) => ({
        id: String(a.id),
        type: a.type,
        label: a.domain || a.ip || a.url || a.app_name || a.bundle_id || String(a.id),
      }));
    } else {
      out["assets"] = [];
    }
    return out;
  });

  async function findingByAnyIDGuard(idStr: string, record=false): Promise<Record<string, unknown>> {
    const row=await findingByAnyId(idStr,record);
    if(!(await db().query('SELECT 1 WHERE finding_readable($1)',[Number(row.id)])).rowCount)throw Object.assign(new Error('漏洞不存在或未获授权'),{statusCode:404});
    return row;
  }

  function assertFindingWritableInContext(row: Record<string, unknown>, context: string | undefined) {
    if (context !== undefined && (!/^\d+$/.test(context) || Number(context) !== Number(row.task_id))) {
      throw Object.assign(new Error("只能修改当前任务的漏洞"), { statusCode: 403 });
    }
  }

  app.patch("/api/exploration/findings/:id", async (req) => {
    const p = req.params as Record<string, string>;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const row = await findingByAnyIDGuard(p["id"]!,(req.query as Record<string,string>).id_kind==='record');
    assertFindingWritableInContext(row, (req.query as Record<string, string>).context_task);
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, col] of [
      ["status", "status"],
      ["severity", "severity"],
      ["name", "name"],
      ["vulnclass", "vulnclass"],
      ["summary", "summary"],
      ["report", "report"],
    ] as const) {
      if (typeof b[k] === "string") {
        params.push(b[k]);
        sets.push(`${col}=$${params.length}`);
      }
    }
    if (sets.length > 0) {
      params.push(Number(row["id"]));
      await db().query(`UPDATE findings SET ${sets.join(", ")} WHERE id=$${params.length}`, params);
    }
    return findingByAnyId(p["id"]!,(req.query as Record<string,string>).id_kind==='record');
  });

  app.delete("/api/exploration/findings/:id", async (req) => {
    const p = req.params as Record<string, string>;
    const row = await findingByAnyIDGuard(p["id"]!,(req.query as Record<string,string>).id_kind==='record');
    assertFindingWritableInContext(row, (req.query as Record<string, string>).context_task);
    await db().query(`DELETE FROM findings WHERE id=$1`, [Number(row["id"])]);
    if (row["node_id"]) await db().query(`DELETE FROM exploration_nodes WHERE id=$1`, [Number(row["node_id"])]);
    return { deleted: true, id: Number(row["id"]) };
  });

  app.get("/api/tasks/:id/llm", async (req) => {
    const id=Number((req.params as {id:string}).id);
    const result=await resolveModelProfiles(db(),id,'mainagent');
    const task=await db().tasks().getTask(id);
    const rows=await db().query(`SELECT p.id,p.name,p.model,p.format,c.position,c.status,c.last_error,c.exhausted_at FROM task_llm_profiles c JOIN llm_profiles p ON p.id=c.profile_id WHERE c.task_id=$1 ORDER BY c.position`,[id]);
    return {profiles:rows.rows.map(r=>({...r,id:Number(r.id)})),default_profile_id:task?.llm_profile_id??null,
      active_llm_profile_id:result.profiles[0]?.id??null,failover_enabled:rows.rows.length>1};
  });
  app.get("/api/tasks/:id/llm/resolution", async (req) => {
    const id=Number((req.params as {id:string}).id);
    const roles=['mainagent','planner','worker'];
    return Object.fromEntries(await Promise.all(roles.map(async role=>[role,(await resolveModelProfiles(db(),id,role)).resolution])));
  });
  app.get("/api/tasks/:id/llm/attempts",async req=>{
    const id=Number((req.params as {id:string}).id);await expOf(id);
    const q=req.query as {before?:string};
    return {attempts:(await db().query(`SELECT id,role,profile_id,model,status,error,usage,purpose,created_at,finished_at FROM llm_request_attempts WHERE task_id=$1 AND ($2::bigint=0 OR id<$2) ORDER BY id DESC LIMIT 100`,[id,Number(q.before)||0])).rows};
  });

  app.patch("/api/tasks/:id/category", async (req) => {
    const p = req.params as Record<string, string>;
    const b = (req.body ?? {}) as Record<string, unknown>;
    await db().query(`UPDATE tasks SET category_id=$1 WHERE id=$2`, [b["category_id"] ?? null, Number(p["id"])]);
    return { ok: true };
  });

  // findings 补真（findings-extra 的工厂注册，替代原空壳）
  app.get("/api/exploration/findings/asset-tree", makeFindingsAssetTreeHandler(app));
  app.get("/api/exploration/findings/export", makeFindingsExportHandler(app));

  // ─── 仪表盘 / 审计 ────────────────────────────────────────────────────────

  app.get("/api/stats", async (req) => {
    const a = await db().query<{ n: string }>(`SELECT count(*) AS n FROM assets`);
    const f = await db().query<{ n: string }>(`SELECT count(*) AS n FROM findings WHERE status NOT IN ('false_positive','duplicate','ignored')`);
    const activeID = (req.query as {task?:string}).task ?? await db().platform().getSetting("active_task");
    let activeTask: Record<string, unknown> | undefined;
    if (activeID && Number(activeID) > 0) activeTask = await taskRow(Number(activeID));
    if(activeTask){
      const display=(await db().query('SELECT task_display_status($1) status,task_display_reason($1) status_reason FROM tasks WHERE id=$1',[Number(activeTask.id)])).rows[0];
      Object.assign(activeTask,{...display,paused:display?.status==='paused',queued:display?.status==='queued',pause_pending:display?.status==='pausing'});
      const scheduling=await executionSnapshot(db(),Number(activeTask.id));
      const counts=await db().exploration(Number(activeTask.exploration_id)).executionCounts();
      Object.assign(activeTask,{in_flight:scheduling.task_active,scheduling,goals_total:counts.goals,goals_met:counts.met,engine_mode:activeTask.paused||activeTask.pause_pending?'paused':scheduling.task_active+scheduling.planning+scheduling.ready>0?'exploring':'idle'});
    }
    const llm = await db().platform().activeProfile().catch(() => null);
    return {
      assets: Number(a.rows[0]?.n ?? 0),
      engine_mode: activeTask?.engine_mode??"idle",
      llm_configured: llm !== null,
      roe_enabled: false,
      findings_confirmed: Number(f.rows[0]?.n ?? 0),
      ...(activeTask ? { active_task: { ...activeTask, id: String(activeTask["id"]) } } : {}),
    };
  });

  app.get("/api/audit", async () => ({ entries: [], attributions: {} }));

  // Counts are unique physical requests. Task-bound conversations are not added twice.
  app.get('/api/exploration/tokens',async req=>{
    const q=req.query as Record<string,string>;
    const expID=await expOf(q2n(q.task,0));
    const task=(await db().query('SELECT id FROM tasks WHERE exploration_id=$1 AND deleted_at IS NULL',[expID])).rows[0];
    if(!task)throw Object.assign(new Error('任务不存在'),{statusCode:404});
    const scope={taskID:Number(task.id)};
    const [total,workers,sessions]=await Promise.all([aggregateUsage(db(),scope),aggregateUsage(db(),scope,'worker'),aggregateUsage(db(),scope,'session')]);
    const mainSegments=sessions.filter(r=>String(r.bucket).startsWith('main:'));
    return {total:total[0],workers:workers.map(r=>({...r,worker:r.bucket})),sessions:sessions.map(r=>({...r,session:r.bucket})),
      session_aliases:{main:{session:'main',is_alias:true,alias_of:mainSegments.map(r=>r.bucket),input_tokens:mainSegments.reduce((n,r)=>n+r.input_tokens,0),output_tokens:mainSegments.reduce((n,r)=>n+r.output_tokens,0),cache_read_tokens:mainSegments.reduce((n,r)=>n+r.cache_read_tokens,0),cache_write_tokens:mainSegments.reduce((n,r)=>n+r.cache_write_tokens,0)}},version:'usage-v2'};
  });
  const usageWindow=(q:Record<string,string>,defaultDays:number)=>({days:Math.min(Math.max(q2n(q.days,defaultDays),1),3650)});
  app.get('/api/tokens/usage',async req=>{
    const scope=usageWindow(req.query as Record<string,string>,365);
    const [total,profiles,daily,undated]=await Promise.all([aggregateUsage(db()),aggregateUsage(db(),{},'profile'),aggregateUsage(db(),scope,'profile_day'),aggregateUsage(db(),{timeKnown:false})]);
    return {version:'usage-v2',timezone:'Asia/Shanghai',total_scope:'retained_all_time',daily_days:scope.days,daily_complete:total[0]!.time_unknown_records===0,unassigned_time:undated[0],total:total[0],by_profile:profiles,daily,unverified_history:await unverifiedUsageHistory(db())};
  });
  app.get('/api/tokens/daily',async req=>(await aggregateUsage(db(),usageWindow(req.query as Record<string,string>,30),'day')).map(r=>({...r,day:r.bucket,date:r.bucket})));
  app.get('/api/tokens/conversations',async()=>{
    const usage=await aggregateUsage(db(),{},'conversation');
    const conversations=(await db().query('SELECT id,title,agent_key AS role,task_id FROM conversations')).rows;
    return usage.map(r=>{const c=conversations.find(c=>String(c.id)===r.bucket);return {...r,id:r.bucket,conversation_id:r.bucket,title:c?.title??'已删除',role:c?.role??r.role,deleted:!c,llm_profile_id:r.profile_id,task_id:r.task_id==null?null:String(r.task_id)};});
  });

  app.get("/api/llm/records/by-model", async (req) => {
    const q = req.query as Record<string, string>;
    const taskID=q.task===undefined?undefined:Number(q.task);
    if(taskID!==undefined){
      if(!Number.isSafeInteger(taskID)||taskID<1)throw Object.assign(new Error('任务 ID 无效'),{statusCode:400});
      await expOf(taskID);
    }
    return modelTokenUsage(db(),taskID);
  });
}
