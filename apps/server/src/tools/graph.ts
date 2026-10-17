import { resolveGraphNode } from "../db/graph_view.js";
// 探索图读写工具：record_fact（写通道纪律核心）、node_detail、
// search_worker_traces / get_worker_trace（worker 间过程级信息交换）。

import { domainTool } from "./define.js";
import type { ToolRunContext } from "./context.js";
import { KindFact, RelYields, nodeAllowsPendingAssets } from "../db/exploration.js";

// ─── record_fact：worker 写回事实（intent --yields--> fact）─────────────────

interface RecordFactArgs { summary: string; evidence?: string; confidence?: "low" | "medium" | "high"; asset_ids?: number[]; }

export function recordFactTool(ctx: ToolRunContext) {
  return domainTool<RecordFactArgs>(
    {
      name: "record_fact",
      description:
        "把本意图的探索结论写成一条事实节点（fact）。只写增量：合并多个观察为一条、只记录新信息。" +
        "负面结果（不存在/不可利用）同样有价值。必须附证据与置信度。",
      promptSnippet: "写回探索事实（正面/负面结论都要，带证据）",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "一句话事实结论（自包含，不引用'上文'）" },
          evidence: { type: "string", description: "支撑该结论的关键证据原文（命令输出/响应片段）" },
          confidence: { type: "string", enum: ["low", "medium", "high"], description: "置信度，默认 medium" },
          asset_ids: {
            type: "array",
            items: { type: "integer" },
            description: "该事实涉及的资产 id；缺省继承意图锚定的资产",
          },
        },
        required: ["summary"],
      },
      async run(args, c) {
        const s = c.db.exploration(c.expID);
        // 写通道纪律：worker 只能写回自己领取的意图。
        const intentID = c.intentID;
        if (!intentID) throw new Error("record_fact 仅在 worker 执行意图时可用");
        const intent = await s.getNode(intentID);
        if (!intent || intent.kind !== "intent") throw new Error(`意图 #${intentID} 不存在`);
        if (intent.payload["cancelled_by_user"] === true) throw new Error("意图已被用户取消，停止写回");

        // 锚点：显式指定优先，否则继承意图锚。
        const anchors =
          args.asset_ids && args.asset_ids.length > 0 ? args.asset_ids : await s.anchorAssetIDs(intentID);
        // 授权校验（worker 口径：mainagent 签发的 pending 资产可用）。
        if (anchors.length > 0) {
          await c.db.taskScope().validateIntentAssets(c.taskID, intent, anchors);
        }

        const payload: Record<string, unknown> = {
          summary: args.summary,
          from_intent: intentID,
        };
        if (args.evidence) payload["evidence"] = args.evidence;
        payload["confidence"] = args.confidence ?? "medium";

        const factID = await s.addNode(KindFact, payload, 0, "confirmed", c.workerName ?? c.role, anchors);
        await s.link(intentID, RelYields, factID);
        if (anchors.length > 0) {
          await c.db.taskScope().markTaskAssetsTested(c.taskID, anchors, c.workerName ?? c.role);
        }
        return { fact_id: factID, anchored_assets: anchors.length };
      },
    },
    ctx,
  );
}

// ─── node_detail：任意节点钻取 ───────────────────────────────────────────────

interface NodeDetailArgs { node_id: number; }

export function nodeDetailTool(ctx: ToolRunContext) {
  return domainTool<NodeDetailArgs>(
    {
      name: "node_detail",
      description: "查看探索图中一个节点的完整详情：payload、状态、上下游边（血缘）、锚定资产。",
      promptSnippet: "钻取节点详情与血缘",
      parameters: {
        type: "object",
        properties: { node_id: { type: "integer", description: "节点 id" } },
        required: ["node_id"],
      },
      readOnly: true,
      async run(args, c) {
        const resolved = await resolveGraphNode(c.db, c.taskID, c.expID, args.node_id, c.role === 'worker');
        const { node } = resolved;
        const s = c.db.exploration(resolved.expID);
        const edges = await c.db.query(
          `SELECT src_id, rel, dst_id FROM exploration_edges
           WHERE exploration_id=$1 AND (src_id=$2 OR dst_id=$2) ORDER BY id`,
          [resolved.expID, args.node_id],
        );
        const anchors = await s.anchorAssetIDs(args.node_id);
        const anchorAssets =
          anchors.length > 0
            ? (await c.db.assets().getByIDs(anchors)).map((a) => ({
                id: a.id,
                type: a.type,
                host: a.domain || a.ip || a.url || a.app_name || a.bundle_id,
              }))
            : [];
        return {
          source_task_id: resolved.taskID, inherited: resolved.inherited,
          node: { id: node.id, kind: node.kind, state: node.state, payload: node.payload, created_at: node.created_at },
          edges: edges.rows,
          anchors: anchorAssets,
        };
      },
    },
    ctx,
  );
}

// ─── search_worker_traces：跨 work 过程检索 ────────────────────────────────

interface SearchTracesArgs { query: string; limit?: number; }

export function searchWorkerTracesTool(ctx: ToolRunContext) {
  return domainTool<SearchTracesArgs>(
    {
      name: "search_worker_traces",
      description:
        "在本任务其他 work 的执行过程（activity 轨迹）里按关键字检索——很多有价值的观察（报错、响应片段、隐藏参数）" +
        "不会升格为正式 fact，但留在过程里。命中项带 intent_id/step_id，可用 get_worker_trace 取完整内容。" +
        "自动排除你自己这条意图的步骤。",
      promptSnippet: "检索其他 work 的执行过程观察",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "关键字（不区分大小写）" },
          limit: { type: "integer", description: "默认 10，上限 20" },
        },
        required: ["query"],
      },
      readOnly: true,
      async run(args, c) {
        const limit = Math.min(Math.max(args.limit ?? 10, 1), 20);
        const q = `%${args.query.replace(/[%_\\]/g, (m) => "\\" + m)}%`;
        const res = await c.db.query(
          `SELECT id, node_id, worker, kind, tool, summary,
                  substring(COALESCE(detail, summary) FROM greatest(1, strpos(lower(COALESCE(detail, summary)), lower($2)) - 60) FOR 240) AS context
           FROM activity
           WHERE exploration_id=$1 AND node_id IS NOT NULL AND node_id IS DISTINCT FROM $3
             AND kind NOT IN ('usage','round')
             AND (summary ILIKE $2 OR detail ILIKE $2)
           ORDER BY id DESC LIMIT $4`,
          [c.expID, q, c.intentID ?? -1, limit],
        );
        return {
          matches: res.rows.map((r: Record<string, unknown>) => ({
            step_id: Number(r["id"]),
            intent_id: r["node_id"] === null ? null : Number(r["node_id"]),
            worker: r["worker"],
            kind: r["kind"],
            tool: r["tool"],
            summary: r["summary"],
            context: r["context"],
          })),
          hint: "用 get_worker_trace(intent_id, step_ids=[...]) 获取完整步骤内容",
        };
      },
    },
    ctx,
  );
}

// ─── get_worker_trace：某条 work 的过程详情（含最终结论）───────────────────

interface GetTraceArgs { intent_id: number; step_ids?: number[]; include_output?: boolean; offset?: number; after_id?: number; }

export function getWorkerTraceTool(ctx: ToolRunContext) {
  return domainTool<GetTraceArgs>(
    {
      name: "get_worker_trace",
      description:
        "查看某个 work（意图）的执行轨迹：先无 step_ids 列出步骤摘要（看动作与观察，不含模型内心），" +
        "再带 step_ids（≤5 个）取完整内容；include_output=true 额外返回该 work 的最终总结。" +
        "planner 用它判断 exhausted/blocked 意图的实际进度；worker 用它复用他人过程细节。",
      promptSnippet: "读取指定 work 的执行轨迹与结论",
      parameters: {
        type: "object",
        properties: {
          intent_id: { type: "integer", description: "意图 id" },
          step_ids: {
            type: "array",
            items: { type: "integer" },
            maxItems: 5,
            description: "要取完整内容的步骤 id 列表（省略则只列摘要）",
          },
          offset: { type: "integer", minimum: 0, description: "步骤正文字符偏移，使用 next_offset 继续读取" },
          after_id: { type: "integer", minimum: 0, description: "步骤列表游标" },
          include_output: { type: "boolean", description: "是否附最终总结，默认 false" },
        },
        required: ["intent_id"],
      },
      readOnly: true,
      async run(args, c) {
        const s = c.db.exploration(c.expID);
        const intent = await s.getNode(args.intent_id);
        if (!intent || intent.kind !== "intent") throw new Error(`意图 #${args.intent_id} 不存在`);

        const listRows = await c.db.query(
          `SELECT id, kind, tool, is_error, summary, created_at FROM activity
           WHERE exploration_id=$1 AND node_id=$2 AND kind NOT IN ('usage','round') AND id>$3
           ORDER BY id LIMIT 51`,
          [c.expID, args.intent_id, args.after_id ?? 0],
        );
        const steps = listRows.rows.slice(0,50).map((r: Record<string, unknown>) => ({
          step_id: Number(r["id"]),
          kind: r["kind"],
          tool: r["tool"],
          is_error: r["is_error"] === true,
          summary: r["summary"],
        }));

        const detail: Record<string, unknown>[] = [];
        if (args.step_ids && args.step_ids.length > 0) {
          const rows = await c.db.query(
            `SELECT id, kind, tool, summary, detail FROM activity
             WHERE exploration_id=$1 AND node_id=$2 AND id=ANY($3::bigint[]) ORDER BY id`,
            [c.expID, args.intent_id, args.step_ids.slice(0,5)],
          );
          for (const r of rows.rows) {
            const body = (r["detail"] as string | null) ?? (r["summary"] as string | null) ?? "";
            detail.push({
              step_id: Number(r["id"]),
              kind: r["kind"],
              tool: r["tool"],
              body: body.slice(Math.max(0,args.offset ?? 0), Math.max(0,args.offset ?? 0)+3000),
              total_chars: body.length,
              next_offset: (args.offset ?? 0)+3000<body.length ? (args.offset ?? 0)+3000 : null,
            });
          }
        }

        let output: string | undefined;
        if (args.include_output) {
          const row = await c.db.query(
            `SELECT summary FROM activity WHERE exploration_id=$1 AND node_id=$2 AND kind='result' ORDER BY id DESC LIMIT 1`,
            [c.expID, args.intent_id],
          );
          output = (row.rows[0]?.["summary"] as string | undefined) ?? undefined;
        }

        return {
          intent: { id: intent.id, state: intent.state, summary: intent.payload["summary"] },
          steps,
          next_cursor: listRows.rows.length>50 ? Number(listRows.rows[49]!.id) : null,
          detail,
          final_output: output,
        };
      },
    },
    ctx,
  );
}

export { nodeAllowsPendingAssets };
