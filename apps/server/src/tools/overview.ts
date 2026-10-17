// graph_overview：planner/worker/mainagent 的态势输入。
// 有界 JSON 投影（替代 Go 的 lightformat 渲染协议）：
// goals / frontier / running / open_intents / recent_facts / recent_done / coverage / hints / digests。

import { domainTool, clampOutput } from "./define.js";
import type { ToolRunContext } from "./context.js";

interface OverviewOptions {
  /** worker 视角删除 coverage（Go 语义：worker 只看方向不看度量）。 */
  forWorker?: boolean;
}

export async function buildGraphOverview(
  c: ToolRunContext,
  opts: OverviewOptions = {},
): Promise<Record<string, unknown>> {
  const s = c.db.exploration(c.expID);

  const [goals, hints, digests] = await Promise.all([
    s.listByKind("goal", 30),
    s.listByKind("hint", 10),
    s.listByKind("digest", 15),
  ]);
  const frontier = await s.frontier(30);
  const counts = await s.executionCounts();

  const running = await c.db.query(
    `SELECT id, payload->>'summary' AS summary, owner FROM exploration_nodes
     WHERE exploration_id=$1 AND kind='intent' AND state='running' ORDER BY id LIMIT 10`,
    [c.expID],
  );
  const recentFacts = await c.db.query(
    `SELECT id, payload->>'summary' AS summary, payload->>'confidence' AS confidence,
            payload->>'from_intent' AS from_intent, created_at
     FROM exploration_nodes WHERE exploration_id=$1 AND kind='fact' AND state='confirmed'
       AND NOT EXISTS (SELECT 1 FROM exploration_edges e JOIN exploration_nodes d ON d.id=e.src_id
        WHERE e.dst_id=exploration_nodes.id AND e.rel='covers' AND d.kind='digest' AND d.state='active')
     ORDER BY id DESC LIMIT 20`,
    [c.expID],
  );
  const recentDone = await c.db.query(
    `SELECT id, payload->>'summary' AS summary, state FROM exploration_nodes
     WHERE exploration_id=$1 AND kind='intent' AND state IN ('done','exhausted','blocked','stopped')
       AND NOT EXISTS (SELECT 1 FROM exploration_edges e JOIN exploration_nodes d ON d.id=e.src_id
        WHERE e.dst_id=exploration_nodes.id AND e.rel='covers' AND d.kind='digest' AND d.state='active')
     ORDER BY id DESC LIMIT 12`,
    [c.expID],
  );
  const findingsTotal = await c.db.query<{ n: string }>(
    `SELECT count(*) AS n FROM findings WHERE task_id=$1`,
    [c.taskID],
  );

  const overview: Record<string, unknown> = {
    goals: goals.map((g) => ({ id: g.id, text: g.payload["text"], state: g.state })),
    frontier_open: frontier.length,
    open_intents: frontier.slice(0, 30).map((n) => ({
      id: n.id,
      summary: n.payload["summary"],
      priority: n.priority,
    })),
    running_intents: running.rows.map((r: Record<string, unknown>) => ({
      id: Number(r["id"]),
      summary: r["summary"],
      owner: r["owner"],
    })),
    done_intents_total: counts.goals >= 0 ? Number(recentDone.rows.length) : 0,
    recent_done_intents: recentDone.rows.map((r: Record<string, unknown>) => ({
      id: Number(r["id"]),
      summary: r["summary"],
      state: r["state"],
    })),
    recent_facts: recentFacts.rows.map((r: Record<string, unknown>) => ({
      id: Number(r["id"]),
      summary: r["summary"],
      confidence: r["confidence"] ?? "medium",
      from_intent: r["from_intent"] === null ? null : Number(r["from_intent"]),
    })),
    facts_total_hint: "recent 20 shown; use node_detail for more",
    findings_total: Number(findingsTotal.rows[0]?.["n"] ?? 0),
    active_hints: hints.filter((h) => h.state === "active").map((h) => ({ id: h.id, text: h.payload["text"] })),
    cold_digests: digests
      .filter((d) => d.state === "active")
      .map((d) => ({ id: d.id, summary: d.payload["summary"], member_ids: d.payload["member_ids"] })),
    todos: c.todos ? c.todos.get(c.expID) : undefined,
  };

  if (!opts.forWorker) {
    const cov = await c.db.taskScope().taskCoverage(c.taskID, c.expID);
    overview["coverage"] = cov;
  }
  return overview;
}

interface GraphOverviewArgs {}

export function graphOverviewTool(ctx: ToolRunContext, opts: OverviewOptions = {}) {
  return domainTool<GraphOverviewArgs>(
    {
      name: "graph_overview",
      description:
        "读取当前探索态势：目标状态、frontier、在跑/近期意图、近期事实、漏洞数、覆盖度（planner 决策的输入）。" +
        "只读、可随时刷新。",
      promptSnippet: "读取探索态势总览",
      parameters: { type: "object", properties: {} },
      readOnly: true,
      async run(_args, c) {
        return buildGraphOverview(c, opts);
      },
    },
    ctx,
  );
}

export function renderOverviewText(overview: Record<string, unknown>): string {
  return clampOutput(JSON.stringify(overview, null, 1));
}
