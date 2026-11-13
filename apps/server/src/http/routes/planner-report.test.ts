import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { openDatabase } from "../../db/index.js";
import { requireJWT, signJWT } from "../auth.js";
import { registerPlannerReportRoute } from "./planner-report.js";

const dsn = process.env.TEST_TASK_FINDINGS_DSN;
test("Planner reports use scoped durable receipts, distinguish unknowns and paginate full turns", {
  skip: !dsn && "requires an isolated PostgreSQL database",
}, async t => {
  assert.match(new URL(dsn!).pathname, /^\/test_[a-z0-9_]+$/);
  process.env.SERIES_PG_DSN = dsn;
  const db = await openDatabase();
  const app = Fastify();
  const key = "isolated-planner-report-fixture";
  app.decorate("db", db);
  app.addHook("preHandler", requireJWT(key));
  registerPlannerReportRoute(app);
  t.after(async () => { await app.close(); await db.close(); });
  async function task() {
    const exp = await db.createExploration("合成记录", "验证呈现");
    const id = Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,paused) VALUES ('合成记录','验证呈现',$1,true) RETURNING id", [exp])).rows[0]?.id);
    return { id, exp };
  }
  const first = await task(), other = await task();
  const store = db.exploration(first.exp);
  async function activity(turn: string, kind: string, metadata: object = {}, fields: Partial<Parameters<typeof store.appendActivity>[0]> = {}) {
    return store.appendActivity({ worker: "planner", kind, summary: "", ...fields, metadata: { turn_id: turn, ...metadata } });
  }
  const start = (turn: string) => activity(turn, "status", { event_type: "turn_start", role: "planner" });
  const end = (turn: string) => activity(turn, "result", { event_type: "lifecycle", status: "completed" });
  async function use(turn: string, tool: string, id: string, detail?: string) {
    return activity(turn, "tool_use", {}, { tool, tool_use_id: id, detail });
  }
  async function result(turn: string, tool: string, id: string, detail: string, isError = false) {
    return activity(turn, "tool_result", {}, { tool, tool_use_id: id, detail, is_error: isError });
  }
  async function node(exp: number) {
    return Number((await db.query("INSERT INTO exploration_nodes(exploration_id,kind,payload,state) VALUES($1,'intent','{\"summary\":\"核对本地清单\"}','open') RETURNING id", [exp])).rows[0]?.id);
  }
  const ids: number[] = [];
  for (let i = 0; i < 12; i++) ids.push(await node(first.exp));
  const unrelated = await node(other.exp);
  const records = ids.map(id => ({ intent_id: id, created: true, summary: "核对 | 清单\n<原文>" }));
  await db.query("INSERT INTO planner_dispatch_calls(exploration_id,session_id,delivery_id,tool_call_id,arguments_hash,result_text) VALUES ($1,'s','d','add','hash',$2)", [first.exp, JSON.stringify(records)]);
  await start("first");
  await use("first", "add_intent", "add");
  await result("first", "add_intent", "add", "{}", false);
  await use("first", "add_intent", "duplicate");
  await result("first", "add_intent", "duplicate", JSON.stringify({ intents: [{ intent_id: ids[0], created: false }] }));
  await use("first", "add_intent", "failed");
  const failedDispatch = await result("first", "add_intent", "failed", "rejected", true);
  await use("first", "add_intent", "mismatched");
  await result("first", "add_intent", "mismatched", JSON.stringify({ intents: [{ intent_id: unrelated, created: true }] }));
  for (const call of ["steer-1", "steer-2"]) {
    await use("first", "steer_work", call);
    await result("first", "steer_work", call, JSON.stringify({ steered: ids[0] }));
  }
  await result("first", "steer_work", "steer-2", JSON.stringify({ steered: ids[0] }));
  await activity("worker-turn", "status", { event_type: "steering", steering: {
    source: "planner", source_turn_id: "first", source_tool_call_id: "steer-2", status: "delivered",
  } }, { node_id: ids[0], worker: "work#1", tool: "steer_work" });
  await use("first", "context_get", "read");
  await result("first", "context_get", "read", "{}");
  await use("first", "kill_work", "stop");
  await result("first", "kill_work", "stop", JSON.stringify({ killed: ids[0] }));
  await activity("first", "status", { event_type: "runner_settled", stop_reason: "budget" });
  await end("first");
  await start("recovered");
  await use("recovered", "add_intent", "add");
  await result("recovered", "add_intent", "add", "{}");
  await end("recovered");
  await start("empty"); await end("empty");
  await end("old");
  await start("running");

  const url = (turn: string, id = first.id) => `/api/tasks/${id}/turns/${turn}/planner-report`;
  const headers = { authorization: `Bearer ${signJWT(key)}` };
  const read = async (path: string, code = 200) => {
    const response = await app.inject({ url: path, headers });
    assert.equal(response.statusCode, code, response.body);
    return response.json();
  };
  assert.equal((await app.inject({ url: url("first") })).statusCode, 401);
  await read(url("first", other.id), 404);
  await read(url("running"), 404);
  await read(url("first") + "?dispatch_offset=-1", 400);
  const report = await read(url("first"));
  assert.equal(report.status, "exhausted");
  assert.equal(report.dispatch.created_total, 12);
  assert.equal(report.dispatch.total, 14);
  assert.equal(report.dispatch.partial, true);
  assert.equal(report.dispatch.items.length, 10);
  assert.equal(report.dispatch.next_offset, 10);
  assert.deepEqual(report.steering.items.map((item: {status: string}) => item.status), ["submitted", "delivered"]);
  assert.equal(report.actions.items.find((item: {name: string}) => item.name === "读取上下文").succeeded, 1);
  assert.equal(report.actions.items.find((item: {name: string}) => item.name === "终止意图").succeeded, 1);
  assert.equal(report.actions.items.find((item: {name: string}) => item.name === "提交意图").activity, String(failedDispatch));
  const next = await read(url("first") + "?dispatch_offset=10");
  assert.deepEqual(next.dispatch.items.map((item: {status: string}) => item.status), ["created", "created", "duplicate", "failed"]);
  assert.equal(next.dispatch.items.at(-1).activity, String(failedDispatch));
  assert.equal(next.dispatch.next_offset, null);
  assert.deepEqual(await read(url("first")), report);
  const replayed = await read(url("recovered"));
  assert.equal(replayed.dispatch.created_total, 0);
  assert.equal(replayed.dispatch.items[0].status, "replayed");
  assert.equal((await read(url("empty"))).dispatch.partial, false);
  assert.equal((await read(url("old"))).dispatch.partial, true);
});
