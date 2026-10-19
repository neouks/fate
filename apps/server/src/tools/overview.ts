import {executionSnapshot} from '../engine/coordinator.js';
import { authorizedNodes, graphSources } from "../db/graph_view.js";
import {progressSummary,resultSummary,stopSummary} from '../agent/context-projection.js';
// graph_overview：planner/worker/mainagent 的态势输入。
// 有界 JSON 投影（替代 Go 的 lightformat 渲染协议）：
// goals / frontier / running / open_intents / recent_facts / recent_done / coverage / hints / digests。

import { domainTool, clampOutput } from "./define.js";
import type { ToolRunContext } from "./context.js";
import {workerCapabilities} from '../agent/worker-capabilities.js';

interface OverviewOptions {
  /** worker 视角删除 coverage（Go 语义：worker 只看方向不看度量）。 */
  forWorker?: boolean;
  localOnly?: boolean;
}

async function authorizedNodeCount(c:ToolRunContext,kind:string,states:string[],worker:boolean){
  const store=c.db.exploration(c.expID),statePlaceholders=states.map((_,i)=>`$${i+3}`).join(',');
  let after=0,total=0;
  for(;;){
    const rows=await c.db.query(`SELECT id FROM exploration_nodes WHERE exploration_id=$1 AND kind=$2 AND state IN (${statePlaceholders}) AND id>$${states.length+3} ORDER BY id LIMIT 500`,[c.expID,kind,...states,after]);
    if(!rows.rows.length)break;
    const ids=rows.rows.map(r=>Number(r.id));
    const nodes=await store.nodesByIDs(ids);
    total+=(await authorizedNodes(c.db,c.taskID,c.expID,nodes,worker)).length;
    after=ids.at(-1)!;
    if(rows.rows.length<500)break;
  }
  return total;
}

async function authorizedFindingCount(c:ToolRunContext,worker:boolean){
  const rows=await c.db.query('SELECT node_id,asset_ids FROM findings WHERE task_id=$1',[c.taskID]);
  const nodeIDs=rows.rows.flatMap(r=>r.node_id===null?[]:[Number(r.node_id)]);
  const nodes=await c.db.exploration(c.expID).nodesByIDs(nodeIDs);
  const allowed=new Set((await authorizedNodes(c.db,c.taskID,c.expID,nodes,worker)).map(n=>n.id));
  let total=rows.rows.filter(r=>r.node_id!==null&&allowed.has(Number(r.node_id))).length;
  const legacy=rows.rows.filter(r=>r.node_id===null).flatMap(r=>Array.isArray(r.asset_ids)?(r.asset_ids as unknown[]).map(Number):[]);
  if(legacy.length){
    const states=await c.db.taskScope().taskAssetApprovalStates(c.taskID,legacy);
    const allowedState=(id:number)=>states.get(id)==='approved'||(worker&&states.get(id)==='pending');
    total+=rows.rows.filter(r=>r.node_id===null).filter(r=>(Array.isArray(r.asset_ids)?(r.asset_ids as unknown[]).map(Number):[]).every(allowedState)).length;
  }
  return total;
}

export async function buildGraphOverview(
  c: ToolRunContext,
  opts: OverviewOptions = {},
): Promise<Record<string, unknown>> {
  const s = c.db.exploration(c.expID);

  let [goals, hints, digests] = await Promise.all([
    s.listByKind("goal", 30),
    s.listByKind("hint", 10),
    c.db.query("SELECT id FROM exploration_nodes WHERE exploration_id=$1 AND kind='digest' AND state='active' ORDER BY id DESC LIMIT 20",[c.expID]).then(r=>s.nodesByIDs(r.rows.map(n=>Number(n.id)))),
  ]);
  [goals,hints,digests] = await Promise.all([authorizedNodes(c.db,c.taskID,c.expID,goals,opts.forWorker),authorizedNodes(c.db,c.taskID,c.expID,hints,opts.forWorker),authorizedNodes(c.db,c.taskID,c.expID,digests,opts.forWorker)]);
  const frontier = await authorizedNodes(c.db,c.taskID,c.expID,await s.frontier(30),opts.forWorker);
  const [openCount,doneCount,factsCount,findingsCount]=await Promise.all([
    authorizedNodeCount(c,'intent',['open'],opts.forWorker===true),
    authorizedNodeCount(c,'intent',['done','exhausted','blocked','stopped'],opts.forWorker===true),
    authorizedNodeCount(c,'fact',['confirmed'],opts.forWorker===true),
    authorizedFindingCount(c,opts.forWorker===true),
  ]);

  const running = await c.db.query(
    `SELECT id, payload->>'summary' AS summary, payload->'progress' AS progress,owner FROM exploration_nodes
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
    `SELECT id, payload->>'summary' AS summary, payload->'execution_result' AS result,payload->'execution_stop' AS execution_stop,state FROM exploration_nodes
     WHERE exploration_id=$1 AND kind='intent' AND state IN ('done','exhausted','blocked','stopped')
       AND NOT EXISTS (SELECT 1 FROM exploration_edges e JOIN exploration_nodes d ON d.id=e.src_id
        WHERE e.dst_id=exploration_nodes.id AND e.rel='covers' AND d.kind='digest' AND d.state='active')
     ORDER BY id DESC LIMIT 12`,
    [c.expID],
  );
  for (const result of [running,recentFacts,recentDone]) {
    const nodes=await s.nodesByIDs(result.rows.map(r=>Number(r.id)));
    const allowed=new Set((await authorizedNodes(c.db,c.taskID,c.expID,nodes,opts.forWorker)).map(n=>n.id));
    result.rows=result.rows.filter(r=>allowed.has(Number(r.id)));
  }
  const overview: Record<string, unknown> = {
    scheduling:await executionSnapshot(c.db,c.taskID),
    ...(c.role === 'planner' && !opts.localOnly ? {worker_capabilities:await workerCapabilities(c)} : {}),
    goals: goals.map((g) => ({ id: g.id, text: String(g.payload["text"]??"").slice(0,180), state: g.state })),
    frontier_open: openCount,
    open_intents: frontier.slice(0, 30).map((n) => ({
      id: n.id,
      summary: String(n.payload["summary"]??"").slice(0,180),
      priority: n.priority,execution_stop:stopSummary(n.payload.execution_stop),
    })),
    running_intents: running.rows.map((r: Record<string, unknown>) => ({
      id: Number(r["id"]),
      summary: String(r["summary"]??"").slice(0,180),
      owner: r["owner"],
      progress:progressSummary(r['progress']),
    })),
    done_intents_total: doneCount,
    recent_done_intents: recentDone.rows.map((r: Record<string, unknown>) => ({
      id: Number(r["id"]),
      summary: String(r["summary"]??"").slice(0,180),
      state: r["state"],
      result:resultSummary(r['result']),execution_stop:stopSummary(r['execution_stop']),
    })),
    recent_facts: recentFacts.rows.map((r: Record<string, unknown>) => ({
      id: Number(r["id"]),
      summary: String(r["summary"]??"").slice(0,180),
      confidence: r["confidence"] ?? "medium",
      from_intent: r["from_intent"] === null ? null : Number(r["from_intent"]),
    })),
    facts_total: factsCount,
    facts_total_hint: "使用 list_facts 分页发现事实，node_detail 展开原文",
    findings_total: findingsCount,
    active_hints: hints.filter((h) => h.state === "active").map((h) => ({ id: h.id, text: String(h.payload["text"]??"").slice(0,180) })),
    cold_digests: digests
      .filter((d) => d.state === "active")
      .map((d) => ({ id: d.id, summary: String(d.payload["summary"] ?? "").slice(0,180), member_count: (d.payload["member_ids"] as unknown[] ?? []).length })),
    cold_digests_index: { tool: 'expand_index', task_id:c.taskID },
    todos: c.todos ? c.todos.get(c.expID).slice(0,20).map(t=>({...t,content:t.content.slice(0,180)})) : undefined,
    node_index:{tool:"expand_index",task_id:c.taskID},
  };

  if (!opts.forWorker) {
    const cov = await c.db.taskScope().taskCoverage(c.taskID, c.expID);
    overview["coverage"] = cov;
    const decisions=await c.db.query(`SELECT id,decision,created_at FROM planner_decisions d WHERE exploration_id=$1
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(d.decision->'basis_ids','[]')) b WHERE NOT EXISTS(
        SELECT 1 FROM exploration_nodes n WHERE n.id=b.value::bigint AND exploration_node_readable(n.exploration_id,n.id)
        AND (n.exploration_id=$1 OR n.exploration_id IN (SELECT src.exploration_id FROM task_relations r JOIN tasks src ON src.id=r.source_task_id WHERE r.task_id=$2 AND src.deleted_at IS NULL)))) ORDER BY id DESC LIMIT 5`,[c.expID,c.taskID]);
    overview.planning_decisions=decisions.rows;
  }
  if (!opts.localOnly) {
    const sources=await graphSources(c.db,c.taskID);
    overview.related_tasks=await Promise.all(sources.map(async source=>{
      const v=await buildGraphOverview({...c,taskID:source.taskID,expID:source.expID,todos:undefined},{...opts,localOnly:true});
      return {source_task_id:source.taskID,inherited:true,read_only:true,
        goals:(v.goals as unknown[]).slice(0,5),recent_facts:(v.recent_facts as unknown[]).slice(0,5),
        cold_digests:(v.cold_digests as unknown[]).slice(0,3),facts_total:v.facts_total,findings_total:v.findings_total,
        index:{tool:'expand_index',task_id:source.taskID}};
    }));
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
