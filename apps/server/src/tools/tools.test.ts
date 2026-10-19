// 工具层集成测试：三通道写回纪律、add_intent 去重与 parent 校验、
// graph_overview 投影、todo_store、prove_goal 收官回调。
// 依赖本地开发库 series-ts-pg (127.0.0.1:5433)。

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDatabase, type Database } from "../db/index.js";
import { workerTools, plannerTools, mainTools, goalsTools, TodoStore, runContext } from "./index.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { clampOutput, MAX_TOOL_OUTPUT } from "./define.js";

const TEST_DSN = process.env.SERIES_TEST_PG_DSN ?? "postgres://series:series@127.0.0.1:5433/series_test?sslmode=disable";

let haveDB = true;
let db: Database | null = null;

describe("bounded tool output",()=>{
  it("keeps truncated results valid JSON below 20 KiB and preserves continuation fields",()=>{
    const text=clampOutput(JSON.stringify({content:"证据😀".repeat(20_000),next_offset:4096}));
    expect(Buffer.byteLength(text,"utf8")).toBeLessThanOrEqual(MAX_TOOL_OUTPUT);
    const parsed=JSON.parse(text) as {content:string;next_offset:number;truncated_fields:string[]};
    expect(parsed.next_offset).toBe(4096);
    expect(parsed.content).toContain("续读");
    expect(parsed.truncated_fields).toContain("content");
  });
  it('bounds escaped fallback previews without an infinite truncation loop',()=>{
    const value=Object.fromEntries(Array.from({length:1200},(_,i)=>['\\"'.repeat(50)+i,'x']));
    const result=clampOutput(JSON.stringify(value));
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(MAX_TOOL_OUTPUT);
    expect(()=>JSON.parse(result)).not.toThrow();
  });
});

beforeAll(async () => {
  process.env.SERIES_PG_DSN = TEST_DSN;
  try {
    db = await openDatabase();
  } catch {
    haveDB = false;
  }
});

afterAll(async () => {
  await db?.close().catch(() => undefined);
});

/** 直接调用 ToolDefinition.execute 并解析 text 输出。 */
async function call(tool: ToolDefinition, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const res = await tool.execute("test-call", args as never, undefined, undefined, {} as never);
  const first = (res.content as { type: string; text?: string }[])[0]!;
  return { text: first.text ?? "", isError: (res as { isError?: boolean }).isError };
}

async function seedTask(db: Database, description: string): Promise<{ taskID: number; expID: number }> {
  const expID = await db.createExploration(description, "工具层测试");
  const s = db.exploration(expID);
  await s.addNode("fact", { summary: "任务根" }, 0, "origin", "system", []);
  const res = await db.query<{ id: string }>(
    `INSERT INTO tasks(exploration_id, name, description, goal, status) VALUES ($1,$2,$3,$4,'created') RETURNING id`,
    [expID, description, description, description],
  );
  return { taskID: Number(res.rows[0]!.id), expID };
}

describe.skipIf(!haveDB)("工具层", () => {
  it("角色工具集形状：worker/planner/main/goals 的工具名清单", () => {
    const c = runContext(db!, 1, 1, "planner");
    const w = workerTools(c).map((t) => t.name);
    const p = plannerTools(c).map((t) => t.name);
    const m = mainTools(c).map((t) => t.name);
    const g = goalsTools(c).map((t) => t.name);
    expect(w).toContain("record_fact");
    expect(w).toContain("insert_assets");
    expect(w).toContain("report_finding");
    expect(w).not.toContain("add_intent");
    expect(w).not.toContain("todo_write");
    expect(p).toContain("add_intent");
    expect(p).toContain("prove_goal");
    expect(p).toContain("todo_write");
    expect(p).not.toContain("record_fact");
    expect(m).toContain("set_goals");
    expect(m).toContain("dispatch_intents");
    expect(g).toEqual(["context_search", "context_get", "read_tool_output", "set_goals", "set_constraints", "register_user_target"]);
  });

  it("record_fact 写通道纪律：只能写回自己的意图，锚点继承 + yields 边 + 标记已测", async () => {
    const { taskID, expID } = await seedTask(db!, "record_fact 测试");
    const s = db!.exploration(expID);
    // 两个意图，worker 只绑第一个
    const a = await s.addIntent({ summary: "方向 A",dispatch_requested:true }, 5, [], "planner");
    const b = await s.addIntent({ summary: "方向 B" }, 5, [], "planner");
    await s.setIntentState(b, "running");
    await s.claimNextWorker("work#1");
    const ctx = runContext(db!, taskID, expID, "worker", { workerName: "work#1", intentID: a });
    const [record] = workerTools(ctx).filter((t) => t.name === "record_fact");

    // 无意图绑定的角色（planner ctx）→ isError
    const pctx = runContext(db!, taskID, expID, "planner");
    const [pRecord] = plannerTools(pctx).filter((t) => t.name === "record_fact");
    expect(pRecord).toBeUndefined(); // planner 工具集不含 record_fact——纪律第一层：根本不给

    // 已取消的意图 → 拒绝写回
    await db!.query(
      `UPDATE exploration_nodes SET payload=payload||jsonb_build_object('cancelled_by_user',true) WHERE id=$1`,
      [a],
    );
    const bad = await call(record!, { summary: "x" });
    expect(bad.isError).toBe(true);
    await db!.query(
      `UPDATE exploration_nodes SET payload=payload-'cancelled_by_user' WHERE id=$1`,
      [a],
    );

    const ok = await call(record!, { summary: "发现登录页", evidence: "HTTP 200", confidence: "high" });
    expect(ok.isError,ok.text).toBeFalsy();
    const factID = Number(JSON.parse(ok.text)["fact_id"]);
    expect(factID).toBeGreaterThan(0);
    // yields 边存在
    const edge = await db!.query(
      `SELECT 1 FROM exploration_edges WHERE exploration_id=$1 AND src_id=$2 AND rel='yields' AND dst_id=$3`,
      [expID, a, factID],
    );
    expect(edge.rowCount).toBe(1);
    const fact = await s.getNode(factID);
    expect(fact!.payload["from_intent"]).toBe(a);
    expect(fact!.payload["confidence"]).toBe("high");
  });

  it("insert_assets + list_assets + add_task_scope", async () => {
    const { taskID, expID } = await seedTask(db!, "insert_assets 测试");
    const intentID=await db!.exploration(expID).addIntent({summary:"asset discovery"},1,[],"user");
    const ctx = runContext(db!, taskID, expID, "worker", { workerName: "work#1", intentID });
    const byName = Object.fromEntries(workerTools(ctx).map((t) => [t.name, t]));

    const ins = await call(byName["insert_assets"]!, {
      items: [
        { type: "root_domain", domain: "Example-Tools-Test.com" },
        { type: "subdomain", domain: "app.example-tools-test.com" },
      ],
    });
    expect(ins.isError).toBeFalsy();
    const parsed = JSON.parse(ins.text);
    expect(parsed["inserted"]).toBe(2);
    // 去重：再插一次同域名 → 同 asset id
    const ins2 = await call(byName["insert_assets"]!, {
      items: [{ type: "root_domain", domain: "example-tools-test.com" }],
    });
    expect(JSON.parse(ins2.text)["assets"][0]["asset_id"]).toBe(parsed["assets"][0]["asset_id"]);

    const list = await call(byName["list_assets"]!, { type: "root_domain", limit: 5 });
    const listed = JSON.parse(list.text)["assets"] as { host: string }[];
    expect(listed.some((x) => x.host === "example-tools-test.com")).toBe(true);

    // auto scope：worker 显式插入的 root_domain 进覆盖度分母
    const scopeRow = await db!.query(
      `SELECT 1 FROM task_scope WHERE task_id=$1 AND kind='root_domain' AND domain='example-tools-test.com'`,
      [taskID],
    );
    expect(scopeRow.rowCount).toBe(1);

    // 清理
    await db!.query(`DELETE FROM assets WHERE root_domain='example-tools-test.com' OR domain LIKE '%example-tools-test.com'`);
    await db!.query(`DELETE FROM tasks WHERE id=$1`, [taskID]);
    await db!.query(`DELETE FROM explorations WHERE id=$1`, [expID]);
  });

  it("report_finding 立即发布并通知，Worker 结束前 prove_goal 可读取", async () => {
    const { taskID, expID } = await seedTask(db!, "finding 测试");
    const s = db!.exploration(expID);
    const intentID = await s.addIntent({ summary: "测注入",dispatch_requested:true }, 5, [], "planner");
    await s.claimNextWorker("work#1");
    const goalID = await s.addGoal({ text: "证明一个漏洞" }, "user");

    const events: string[] = [];
    const ctx = runContext(db!, taskID, expID, "worker", {
      workerName: "work#1",
      intentID,
      collaborationPolicy: "blackboard-v1",
      hooks: {
        notifyFinding: () => events.push("finding"),
        notifyGoalMet: () => events.push("goal_met"),
      },
    });
    const byName = Object.fromEntries(workerTools(ctx).map((t) => [t.name, t]));

    const rep = await call(byName["report_finding"]!, {
      vulnclass: "SQL注入",
      name: "登录处注入",
      severity: "high",
      summary: "login 参数可注入",
      evidence: "' OR 1=1 -- 返回 200",
    });
    expect(rep.isError,rep.text).toBeFalsy();
    expect(events).toContain("finding");
    const findingNodeID = Number(JSON.parse(rep.text)["finding_node_id"]);
    const row = await db!.query(`SELECT severity, status FROM findings WHERE node_id=$1`, [findingNodeID]);
    expect(row.rowCount).toBe(1);

    // prove_goal：用该 finding 证明目标 → met + notifyGoalMet
    const pctx = runContext(db!, taskID, expID, "planner", {
      hooks: { notifyGoalMet: () => events.push("goal_met") },
    });
    const pByName = Object.fromEntries(plannerTools(pctx).map((t) => [t.name, t]));
    expect((await db!.query("SELECT severity FROM findings WHERE node_id=$1",[findingNodeID])).rows[0]!.severity).toBe("high");
    const prove = await call(pByName["prove_goal"]!, { goal_id: goalID, evidence_node_id: findingNodeID });
    expect(prove.isError,prove.text).toBeFalsy();
    expect(JSON.parse(prove.text)["all_goals_met"]).toBe(true);
    expect(events).toContain("goal_met");

    // 清理
    await db!.query(`DELETE FROM findings WHERE node_id=$1`, [findingNodeID]);
    await db!.query(`DELETE FROM tasks WHERE id=$1`, [taskID]);
    await db!.query(`DELETE FROM explorations WHERE id=$1`, [expID]);
  });

  it("add_intent：去重 + parent 校验 + mainagent 直投回调", async () => {
    const { taskID, expID } = await seedTask(db!, "add_intent 测试");
    const dispatched: number[] = [];
    const mctx = runContext(db!, taskID, expID, "mainagent", {
      hooks: { dispatchIntent: (_e, id) => dispatched.push(id) },
    });
    const byName = Object.fromEntries(mainTools(mctx).map((t) => [t.name, t]));

    // parent 指向意图 → 拒绝
    const intentA = await db!.exploration(expID).addIntent({ summary: "方向 A",dispatch_requested:true }, 5, [], "planner");
    const bad = await call(byName["add_intent"]!, { intents: [{ summary: "B", parent_id: intentA }] });
    expect(bad.isError).toBe(true);

    // 正常 + 去重
    const ok = await call(byName["add_intent"]!, { intents: [{ summary: "对 A 的深挖", priority: 8 }] });
    const parsed = JSON.parse(ok.text);
    expect(parsed["submitted"]).toBe(1);
    expect(dispatched).toHaveLength(1);
    const dup = await call(byName["add_intent"]!, { intents: [{ summary: "对 a 的深挖" }] });
    expect(JSON.parse(dup.text)["submitted"]).toBe(0);

    // 清理
    await db!.query(`DELETE FROM tasks WHERE id=$1`, [taskID]);
    await db!.query(`DELETE FROM explorations WHERE id=$1`, [expID]);
  });

  it("graph_overview 投影结构与 worker 视角删 coverage", async () => {
    const { taskID, expID } = await seedTask(db!, "overview 测试");
    const s = db!.exploration(expID);
    await s.addGoal({ text: "目标" }, "user");
    await s.addIntent({ summary: "方向" }, 5, [], "planner");

    const pctx = runContext(db!, taskID, expID, "planner", { todos: new TodoStore() });
    const pOver = Object.fromEntries(plannerTools(pctx).map((t) => [t.name, t]));
    const text = await call(pOver["graph_overview"]!, {view:"recent"});
    const o = JSON.parse(text.text);
    expect(o["goals"]).toHaveLength(1);
    expect(o["frontier_open"]).toBeGreaterThanOrEqual(1);
    expect("coverage" in o).toBe(true);

    const wctx = runContext(db!, taskID, expID, "worker", { intentID: 1 });
    const wOver = Object.fromEntries(workerTools(wctx).map((t) => [t.name, t]));
    const wtext = await call(wOver["graph_overview"]!, {view:"recent"});
    expect("coverage" in JSON.parse(wtext.text)).toBe(false);

    // 清理
    await db!.query(`DELETE FROM tasks WHERE id=$1`, [taskID]);
    await db!.query(`DELETE FROM explorations WHERE id=$1`, [expID]);
  });

  it("TodoStore 持久与 todo_write 工具", async () => {
    const { taskID, expID } = await seedTask(db!, "todo 测试");
    const todos = new TodoStore();
    const ctx = runContext(db!, taskID, expID, "planner", { todos });
    const byName = Object.fromEntries(plannerTools(ctx).map((t) => [t.name, t]));
    await call(byName["todo_write"]!, {
      todos: [
        { content: "拿注入点", status: "completed" },
        { content: "取凭据", status: "in_progress" },
      ],
    });
    expect(todos.get(expID)).toHaveLength(2);
    expect(todos.get(expID)[1]!.status).toBe("in_progress");
    await db!.query(`DELETE FROM tasks WHERE id=$1`, [taskID]);
    await db!.query(`DELETE FROM explorations WHERE id=$1`, [expID]);
  });
});
