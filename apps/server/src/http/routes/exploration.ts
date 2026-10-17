// 探索图路由（按 expID 寻址，M5 新契约）：节点/边/活动分页/frontier + 活动实时 SSE。
// SSE 与 Go streamActivity 同构：先 `: connected`，回放 since 之后的 DB 历史，
// 再桥接 engine.bus 的 activity 事件；每帧 `id: <seq>\ndata: {json}\n\n`，20s 心跳 `: ping`。

import type { FastifyInstance } from "fastify";
import type { EngineActivity } from "../../engine/engine.js";

/** engine.bus activity 事件（EngineActivity + 落库后的自增 id）。 */
type BusActivity = EngineActivity & { id?: number };

const ACTIVITY_COLS = `id, node_id, worker, kind, tool, tool_use_id, is_error, summary, detail, main_seg, metadata, created_at`;

function num(v: unknown, def = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export function registerExplorationRoutes(app: FastifyInstance): void {
  const db = () => app.db;

  app.get("/api/exploration/:expID/nodes", async (req) => {
    const expID = num((req.params as { expID: string }).expID);
    const q = req.query as Record<string, unknown>;
    const kind = typeof q["kind"] === "string" && q["kind"] !== "" ? q["kind"] : null;
    const state = typeof q["state"] === "string" && q["state"] !== "" ? q["state"] : null;
    const limit = Math.min(2000, Math.max(1, num(q["limit"], 500)));
    const res = await db().query(
      `SELECT id, kind, payload, priority, state, COALESCE(origin,'') AS origin, COALESCE(owner,'') AS owner,
              COALESCE(blocked_reason,'') AS blocked_reason, created_at
       FROM exploration_nodes
       WHERE exploration_id=$1 AND ($2::text IS NULL OR kind=$2) AND ($3::text IS NULL OR state=$3)
       ORDER BY id DESC LIMIT $4`,
      [expID, kind, state, limit],
    );
    return {
      items: res.rows.map((r) => ({
        id: Number(r["id"]),
        kind: String(r["kind"]),
        payload: r["payload"] ?? {},
        priority: Number(r["priority"] ?? 0),
        state: String(r["state"]),
        origin: r["origin"] || undefined,
        owner: r["owner"] || undefined,
        blocked_reason: r["blocked_reason"] || undefined,
        created_at: r["created_at"] instanceof Date ? (r["created_at"] as Date).toISOString() : String(r["created_at"]),
      })),
      total: res.rows.length,
    };
  });

  app.get("/api/exploration/:expID/edges", async (req) => {
    const expID = num((req.params as { expID: string }).expID);
    const res = await db().query(
      `SELECT id, src_id, rel, dst_id, created_at FROM exploration_edges WHERE exploration_id=$1 ORDER BY id LIMIT 20000`,
      [expID],
    );
    return {
      items: res.rows.map((r) => ({
        id: Number(r["id"]),
        src_id: Number(r["src_id"]),
        rel: String(r["rel"]),
        dst_id: Number(r["dst_id"]),
        created_at: r["created_at"] instanceof Date ? (r["created_at"] as Date).toISOString() : String(r["created_at"]),
      })),
    };
  });

  // 活动分页（?since=<seq>&limit=&node=<intentID>）：前端活动流回放/增量拉取共用。
  app.get("/api/exploration/:expID/activity", async (req) => {
    const expID = num((req.params as { expID: string }).expID);
    const q = req.query as Record<string, unknown>;
    const since = Math.max(0, num(q["since"], 0));
    const limit = Math.min(1000, Math.max(1, num(q["limit"], 300)));
    const node = q["node"] !== undefined && q["node"] !== "" ? num(q["node"], 0) : null;
    const intent = q["intent"] !== undefined && q["intent"] !== "" ? num(q["intent"], 0) : null;
    const nodeFilter = node ?? intent;
    const res = await db().query(
      `SELECT ${ACTIVITY_COLS} FROM activity
       WHERE exploration_id=$1 AND id>$2 AND ($3::bigint IS NULL OR node_id=$3)
       ORDER BY id ASC LIMIT $4`,
      [expID, since, nodeFilter, limit],
    );
    const items = res.rows.map((r) => ({
      id: Number(r["id"]),
      node_id: r["node_id"] === null ? null : Number(r["node_id"]),
      worker: String(r["worker"] ?? ""),
      kind: String(r["kind"] ?? ""),
      tool: r["tool"] ?? null,
      tool_use_id: r["tool_use_id"] ?? null,
      is_error: r["is_error"] === true,
      summary: String(r["summary"] ?? ""),
      detail: r["detail"] ?? null,
      created_at: r["created_at"] instanceof Date ? (r["created_at"] as Date).toISOString() : String(r["created_at"]),
    }));
    return { items, cursor: items.length > 0 ? items[items.length - 1]!.id : since };
  });

  app.get("/api/exploration/:expID/frontier", async (req) => {
    const expID = num((req.params as { expID: string }).expID);
    const limit = Math.min(500, Math.max(1, num((req.query as Record<string, unknown>)["limit"], 50)));
    const items = await db().exploration(expID).frontier(limit);
    return { items };
  });

  // ─── 活动实时流（SSE）──────────────────────────────────────────────────────

  app.get("/api/exploration/activity/stream", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    // expID 显式给定时优先；否则把 task=<taskID> 换算成 exploration_id
    // （activity 按 exp 寻址——task 值直接当 expID 用会回放到错库的流）。
    let expID = num(q["expID"] ?? q["exp"], 0);
    if (expID <= 0 && q["task"] !== undefined && q["task"] !== "") {
      const taskID = num(q["task"], 0);
      const res = await db().query<{ exploration_id: number }>(
        `SELECT exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL`,
        [taskID],
      );
      const row = res.rows[0];
      if (!row) return reply.code(404).send({ error: `任务 #${taskID} 不存在` });
      expID = Number(row.exploration_id);
    }
    if (expID <= 0) {
      return reply.code(400).send({ error: "缺少或无效的 expID 查询参数" });
    }
    let since = Math.max(0, num(q["since"], 0));
    // 浏览器自动重连带 Last-Event-ID（最后收到的 id）——优先于 query，精确续传。
    const lastEventID = req.headers["last-event-id"];
    if (typeof lastEventID === "string" && lastEventID.trim() !== "") {
      since = Math.max(since, num(lastEventID.split(":")[0], since));
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    raw.write(": connected\n\n");

    const send = (payload: Record<string, unknown>): void => {
      raw.write(`id: ${String(payload["id"])}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const dto = (a: BusActivity): Record<string, unknown> => ({
      id: a.id ?? 0,
      seq: a.id ?? 0,
      ts: new Date().toISOString(),
      intent_id: a.nodeID == null ? undefined : String(a.nodeID),
      task_id: a.taskID,
      exp_id: a.expID,
      node_id: a.nodeID ?? null,
      worker: a.worker === "main" ? "mainagent" : a.worker ?? "",
      kind: a.kind,
      main_seg: a.mainSeg,
      metadata: a.metadata,
      tool_use_id: a.toolCallId,
      stream_id: a.streamID,
      tool: a.tool ?? null,
      is_error: a.isError ?? false,
      summary: a.summary ?? "",
      detail: a.detail ?? null,
      created_at: new Date().toISOString(),
    });

    // 回放历史（订阅先行防丢：回放期间的新事件靠 id 去重）。
    let last = since;
    let replaying = true;
    const buffered: BusActivity[] = [];
    const onActivity = (a: BusActivity): void => {
      if (a.expID !== expID) return;
      if (replaying) { buffered.push(a); return; }
      if ((a.id ?? 0) <= last) return;
      last = a.id ?? last;
      send(dto(a));
    };
    app.engine.bus.on("activity", onActivity);
    const onDelta = (delta: { expID: number; worker: string; nodeID?: number; mainSeg?: number; text: string; streamID: string; isThinking?: boolean }) => {
      if (delta.expID !== expID || delta.isThinking || replaying) return;
      raw.write(`event: delta\ndata: ${JSON.stringify({ worker: delta.worker === "main" ? "mainagent" : delta.worker,
        intent_id: delta.nodeID == null ? undefined : String(delta.nodeID), main_seg: delta.mainSeg,
        text: delta.text, stream_id: delta.streamID })}\n\n`);
    };
    app.engine.bus.on("delta", onDelta);
    try {
      // Page the complete gap; never advance the cursor past omitted history.
      for (;;) {
        const rows = await db().query(
          `SELECT ${ACTIVITY_COLS} FROM activity WHERE exploration_id=$1 AND id>$2 ORDER BY id ASC LIMIT 2000`, [expID, last]);
        for (const r of rows.rows) {
          const id = Number(r["id"]);
          if (id <= last) continue;
          last = id;
          const ts = r["created_at"] instanceof Date ? (r["created_at"] as Date).toISOString() : String(r["created_at"]);
          send({ ...r, id, seq: id, ts, exp_id: expID,
            intent_id: r["node_id"] == null ? undefined : String(r["node_id"]),
            main_seg: r["main_seg"] == null ? undefined : Number(r["main_seg"]),
            worker: r["worker"] === "main" ? "mainagent" : String(r["worker"] ?? "") });
        }
        if (rows.rows.length < 2000) break;
      }
      replaying = false;
      for (const activity of buffered.sort((a,b) => (a.id ?? 0) - (b.id ?? 0))) onActivity(activity);
    } catch {
      app.engine.bus.off("activity", onActivity);
      app.engine.bus.off("delta", onDelta);
      raw.end(); // reconnect from the last delivered ID, instead of silently dropping history
      return;
    }

    let polling=false;
    const poll=setInterval(async()=>{
      if(polling||replaying||raw.destroyed)return;polling=true;
      try{
        const rows=await db().query(`SELECT ${ACTIVITY_COLS} FROM activity WHERE exploration_id=$1 AND id>$2 ORDER BY id LIMIT 2000`,[expID,last]);
        for(const row of rows.rows){const id=Number(row.id);if(id<=last)continue;last=id;
          send({...row,id,seq:id,exp_id:expID,worker:row.worker==='main'?'mainagent':row.worker,intent_id:row.node_id==null?undefined:String(row.node_id)});
        }
      }catch{raw.end();}finally{polling=false;}
    },1000);
    const ping = setInterval(() => {
      raw.write(": ping\n\n"); // 注释行：不推进 Last-Event-ID、不伪造活动事件
    }, 20_000);
    const cleanup = (): void => {
      clearInterval(ping);
      clearInterval(poll);
      app.engine.bus.off("activity", onActivity);
      app.engine.bus.off("delta", onDelta);
    };
    req.raw.on("close", cleanup);
    raw.on("error", cleanup);
  });
}
