import type { FastifyInstance } from "fastify";
import type { Database } from "../../db/index.js";
import { loadToolOutput } from "../../evidence/tool-outputs.js";

type Row = {
  id: string; kind: string; tool: string | null; call_id: string | null; is_error: boolean;
  detail: string | null; event: string | null; status: string | null; stop_reason: string | null;
  receipt: string | null; receipt_count: number; replayed: boolean; round_finished: boolean;
};
type Receipt = { intent_id?: unknown; created?: unknown; summary?: unknown };
type ReportItem = {
  intent_id: number | null; activity: string; status: "created" | "duplicate" | "replayed" | "failed" | "unknown" | "submitted" | "delivered";
  summary?: string;
};
type Call = { tool: string; use?: Row; result?: Row };
const terminal = new Set(["completed", "done", "stopped", "failed", "exhausted", "interrupted", "blocked", "paused", "timeout"]);
const pageSize = 10;
const parse = (value: string | null | undefined): unknown => {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
};
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const intentID = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

function actionName(tool: string) {
  if (["context_search", "context_get", "asset_search", "asset_get", "graph_overview"].includes(tool)) return "读取上下文";
  if (tool === "todo_write") return "更新待办";
  if (["record_plan", "record_planning_decision", "record_planner_decision", "plan_record"].includes(tool)) return "保存规划决策";
  if (["prove_goal", "goal_evidence", "set_goal_status"].includes(tool)) return "核对目标";
  if (tool === "add_intent") return "提交意图";
  if (tool === "steer_work") return "提交纠偏";
  return "其他工具调用";
}

async function readToolResult(db: Database, taskID: number, row?: Row): Promise<unknown> {
  const result = parse(row?.detail);
  const ref = object(result)?.output_ref;
  if (!row || typeof ref !== "string") return result;
  const { rowCount } = await db.query(`
    SELECT 1 FROM tool_output_artifacts
    WHERE id=$1 AND task_id=$2 AND tool=$3 AND tool_call_id=$4
      AND node_id IS NULL AND conversation_id IS NULL AND octet_length(body)<=131072`,
    [ref, taskID, row.tool, row.call_id]);
  if (!rowCount) return null;
  try { return parse(await loadToolOutput(db, ref, { taskID })); }
  catch (error) {
    if ([403, 404].includes((error as {statusCode?: number}).statusCode ?? 0)) return null;
    throw error;
  }
}

function page<T>(items: T[], offset: number, partial: boolean) {
  const window = items.slice(offset, offset + pageSize);
  return { items: window, total: items.length, partial, next_offset: offset + window.length < items.length ? offset + window.length : null };
}

export async function readPlannerReport(db: Database, taskID: number, turnID: string, offsets: {dispatch: number; steering: number}) {
  const { rows } = await db.query<Row>(`
    WITH task AS (
      SELECT exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL
    )
    SELECT a.id::text, a.kind, a.tool, a.tool_use_id AS call_id, a.is_error,
      CASE WHEN a.tool IN ('add_intent','steer_work') AND octet_length(a.detail)<=131072 THEN a.detail END AS detail,
      a.metadata->>'event_type' AS event, a.metadata->>'status' AS status,
      a.metadata->>'stop_reason' AS stop_reason,
      p.finished_at IS NOT NULL AS round_finished, receipt.body AS receipt, receipt.count AS receipt_count,
      CASE WHEN receipt.count=1 THEN EXISTS (
        SELECT 1 FROM activity prior
        WHERE prior.exploration_id=a.exploration_id AND prior.worker='planner' AND prior.kind='tool_result'
          AND NOT prior.is_error AND prior.tool='add_intent' AND prior.tool_use_id=a.tool_use_id AND prior.id<a.id
          AND prior.metadata->>'turn_id' IS DISTINCT FROM $2
          AND exploration_activity_readable(prior.exploration_id,prior.node_id,prior.metadata)
      ) ELSE false END AS replayed
    FROM task JOIN activity a USING(exploration_id)
    LEFT JOIN planner_display_rounds p ON p.exploration_id=a.exploration_id AND p.turn_id=$2
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS count, CASE WHEN count(*)=1 THEN min(body) END AS body
      FROM (
        SELECT CASE WHEN octet_length(result_text)<=131072 THEN result_text END AS body
        FROM planner_dispatch_calls
        WHERE exploration_id=a.exploration_id AND tool_call_id=a.tool_use_id LIMIT 2
      ) matching
    ) receipt ON a.tool='add_intent' AND a.kind IN ('tool_use','tool_result')
    WHERE a.worker='planner' AND a.metadata->>'turn_id'=$2
      AND (a.kind IN ('tool_use','tool_result') OR a.metadata->>'event_type' IN
        ('turn_start','planner_round_start','planner_round_title','lifecycle','outcome','runner_settled'))
      AND exploration_activity_readable(a.exploration_id,a.node_id,a.metadata)
    ORDER BY a.id`, [taskID, turnID]);

  if (!rows.length) return null;
  const ended = rows.findLast(row => ["lifecycle", "outcome"].includes(row.event ?? "") && terminal.has(row.status ?? ""));
  if (!ended && !rows.some(row => row.round_finished)) return null;
  const budget = rows.some(row => row.event === "runner_settled" && row.stop_reason === "budget");
  const status = budget && (!ended || ["completed", "stopped", "done"].includes(ended.status ?? ""))
    ? "exhausted" : ended?.status ?? "unknown";
  const completeBoundary = Boolean(ended && rows.some(row => ["turn_start", "planner_round_start"].includes(row.event ?? "")));
  let dispatchPartial = !completeBoundary, steeringPartial = !completeBoundary, actionsPartial = !completeBoundary;
  const calls = new Map<string, Call>();
  for (const row of rows) {
    if (row.kind !== "tool_use" && row.kind !== "tool_result") continue;
    if (!row.tool || !row.call_id) {
      actionsPartial = true;
      if (!row.tool || row.tool === "add_intent") dispatchPartial = true;
      if (!row.tool || row.tool === "steer_work") steeringPartial = true;
      continue;
    }
    const key = JSON.stringify([row.tool, row.call_id]);
    const call = calls.get(key) ?? { tool: row.tool };
    if (row.kind === "tool_use") call.use ??= row;
    else call.result = row;
    calls.set(key, call);
  }
  let dispatch: ReportItem[] = [], steering: ReportItem[] = [];
  const actions = new Map<string, {name: string; total: number; succeeded: number; failed: number; unknown: number; activity: string}>();
  const corrected = new Map<ReportItem, string>();
  const created = new Set<number>();
  for (const {tool, use, result} of calls.values()) {
    const activity = (use ?? result)!.id;
    const name = actionName(tool);
    const action = actions.get(name) ?? { name, total: 0, succeeded: 0, failed: 0, unknown: 0, activity };
    action.total++;
    const durable = result?.receipt ?? use?.receipt;
    if (result?.is_error) action.failed++;
    else if (result || durable) action.succeeded++;
    else { action.unknown++; actionsPartial = true; }
    actions.set(name, action);
    if (tool === "add_intent") {
      const output = durable ? parse(durable) : result && !result.is_error && (result.receipt_count ?? 0) === 0
        ? object(await readToolResult(db, taskID, result))?.intents : null;
      if (Array.isArray(output) && output.length) {
        for (const raw of output) {
          const item = object(raw) as Receipt | undefined;
          const id = intentID(item?.intent_id);
          if (id === null || typeof item?.created !== "boolean") { dispatchPartial = true; continue; }
          if (item.created && !result?.replayed && !use?.replayed && created.has(id)) continue;
          const state = result?.replayed || use?.replayed ? "replayed" : item.created ? "created" : "duplicate";
          if (state === "created") created.add(id);
          dispatch.push({ intent_id: id, activity, status: state,
            ...(typeof item.summary === "string" ? { summary: Array.from(item.summary).slice(0, 300).join("") } : {}) });
        }
      } else if (result?.is_error) dispatch.push({ intent_id: null, activity, status: "failed" });
      else { dispatchPartial = true; dispatch.push({ intent_id: null, activity, status: "unknown" }); }
    }
    if (tool === "steer_work") {
      const returned = result && !result.is_error ? object(await readToolResult(db, taskID, result)) : undefined;
      const submitted = intentID(returned?.steered);
      const target = submitted ?? intentID(object(parse(use?.detail))?.intent_id);
      const state = result?.is_error ? "failed" : submitted === null ? "unknown" : "submitted";
      if (state === "unknown") steeringPartial = true;
      const item: ReportItem = { intent_id: target, activity, status: state };
      steering.push(item);
      if (state === "submitted" && result?.call_id) corrected.set(item, result.call_id);
    }
  }

  const ids = [...new Set([...dispatch, ...steering].flatMap(item => item.intent_id === null ? [] : [item.intent_id]))];
  if (ids.length) {
    const nodes = await db.query<{id: string; summary: string | null}>(`
      SELECT n.id::text,left(n.payload->>'summary',300) AS summary FROM exploration_nodes n
      JOIN tasks t USING(exploration_id)
      WHERE t.id=$1 AND t.deleted_at IS NULL AND n.kind='intent' AND n.id=ANY($2::bigint[])
        AND exploration_node_readable(n.exploration_id,n.id)`, [taskID, ids]);
    const readable = new Map(nodes.rows.map(row => [Number(row.id), row.summary]));
    const restrict = (items: ReportItem[]) => items.filter(item => item.intent_id === null || readable.has(item.intent_id));
    const readableDispatch = restrict(dispatch), readableSteering = restrict(steering);
    dispatchPartial ||= readableDispatch.length !== dispatch.length;
    steeringPartial ||= readableSteering.length !== steering.length;
    dispatch = readableDispatch;
    steering = readableSteering;
    for (const item of dispatch) if (!item.summary && item.intent_id !== null) item.summary = readable.get(item.intent_id) ?? undefined;
    if (corrected.size) {
      const delivered = await db.query<{call_id: string; intent_id: string}>(`
        SELECT s.metadata#>>'{steering,source_tool_call_id}' AS call_id, s.node_id::text AS intent_id
        FROM activity s JOIN tasks t USING(exploration_id)
        WHERE t.id=$1 AND t.deleted_at IS NULL AND s.node_id=ANY($2::bigint[])
          AND s.metadata->>'event_type'='steering' AND s.metadata#>>'{steering,status}'='delivered'
          AND s.metadata#>>'{steering,source}'='planner' AND s.metadata#>>'{steering,source_turn_id}'=$3
          AND s.metadata#>>'{steering,source_tool_call_id}'=ANY($4::text[])
          AND exploration_activity_readable(s.exploration_id,s.node_id,s.metadata)`, [taskID, ids, turnID, [...corrected.values()]]);
      const confirmed = new Set(delivered.rows.map(row => JSON.stringify([row.call_id, Number(row.intent_id)])));
      for (const item of steering) if (confirmed.has(JSON.stringify([corrected.get(item), item.intent_id]))) item.status = "delivered";
    }
  }
  return {
    status,
    dispatch: { ...page(dispatch, offsets.dispatch, dispatchPartial), created_total: dispatch.filter(item => item.status === "created").length },
    steering: page(steering, offsets.steering, steeringPartial),
    actions: { items: [...actions.values()], partial: actionsPartial },
  };
}

export function registerPlannerReportRoute(app: FastifyInstance) {
  app.get("/api/tasks/:id/turns/:turnId/planner-report", async (req, reply) => {
    const { id, turnId } = req.params as { id: string; turnId: string };
    const taskID = Number(id);
    const { dispatch_offset = "0", steering_offset = "0" } = req.query as Record<string, unknown>;
    const validOffset = (value: unknown): value is string => typeof value === "string" && /^\d{1,9}$/.test(value);
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(taskID) || !/^[\w:-]{1,240}$/.test(turnId)
      || !validOffset(dispatch_offset) || !validOffset(steering_offset)) {
      return reply.code(400).send({ error: "无效的任务、轮次或续读位置" });
    }
    const report = await readPlannerReport(app.db, taskID, turnId, { dispatch: Number(dispatch_offset), steering: Number(steering_offset) });
    reply.header("Cache-Control", "private, no-store");
    if (!report) return reply.code(404).send({ error: "已结束的规划轮次不存在或不可查看" });
    return report;
  });
}
