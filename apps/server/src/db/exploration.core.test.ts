// 探索图核心语义集成测试：指纹去重、CAS 领取、状态机、activity 写入。
// 依赖本地开发库 series-ts-pg (127.0.0.1:5433)，无库时跳过。
// 运行：cd apps/server && pnpm test src/db/exploration.core.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDatabase, type Database } from "./index.js";
import {
  ExplorationStore,
  intentFingerprint,
  IntentStateConflictError,
  KindGoal,
  RelYields,
} from "./exploration.js";

const TEST_DSN = process.env.SERIES_TEST_PG_DSN ?? "postgres://series:series@127.0.0.1:5433/series_test?sslmode=disable";

let haveDB = true;
let db: Database | null = null;

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

describe.skipIf(!haveDB)("exploration store core", () => {
  it("fingerprint 归一化：大小写/空白/锚点顺序无关", () => {
    const a = intentFingerprint("  Scan   the WEB app ", [3, 1, 2, 2]);
    const b = intentFingerprint("scan the web app", [1, 2, 3]);
    expect(a).toBe(b);
    expect(intentFingerprint("  ", [1])).toBe("");
  });

  it("意图去重：同 summary+anchors 的活跃意图不重复入库", async () => {
    const expID = await db!.createExploration("测试去重", "验证意图指纹去重");
    const s = db!.exploration(expID);
    // 种 origin fact 与 goal
    const originFact = await s.addNode("fact", { summary: "任务根" }, 0, "origin", "system", []);
    await s.addGoal({ text: "验证去重" }, "user");

    const first = await s.addIntentDeduplicated({ summary: "Test example.com 登录口" }, 5, [], "planner");
    expect(first.created).toBe(true);
    const dup = await s.addIntentDeduplicated({ summary: "test  EXAMPLE.com   登录口" }, 3, [], "planner");
    expect(dup.created).toBe(false);
    expect(dup.id).toBe(first.id);

    // 终态后同方向可重开
    await s.setIntentState(first.id, "done");
    const reopened = await s.addIntentDeduplicated({ summary: "test example.com 登录口" }, 5, [], "planner");
    expect(reopened.created).toBe(true);
  });

  it("claimNextWorker CAS 领取：两个并发领取者只有一个成功", async () => {
    const expID = await db!.createExploration("测试领取", "验证原子领取");
    const s = db!.exploration(expID);
    await s.addNode("fact", { summary: "任务根" }, 0, "origin", "system", []);
    await s.addIntent({ summary: "方向 A" }, 5, [], "planner");

    const [c1, c2] = await Promise.all([
      s.claimNextWorker("work#1"),
      s.claimNextWorker("work#2"),
    ]);
    const claimed = [c1, c2].filter((n) => n !== null);
    expect(claimed.length).toBe(1);
    const winner = claimed[0]!;
    expect(winner.state).toBe("open"); // 快照时的状态；DB 内已 running
    const after = await s.getNode(winner.id);
    expect(after!.state).toBe("running");
    // 队列抽干
    const again = await s.claimNextWorker("work#3");
    expect(again).toBeNull();
  });

  it("CAS 状态迁移：期望态不符时报冲突", async () => {
    const expID = await db!.createExploration("测试状态机", "验证 CAS");
    const s = db!.exploration(expID);
    await s.addNode("fact", { summary: "任务根" }, 0, "origin", "system", []);
    const { id } = await s.addIntentDeduplicated({ summary: "CAS 测试" }, 5, [], "planner");
    await s.setIntentState(id, "running");
    // 期望 open 但实际 running → false
    const ok = await s.compareAndSetIntentState(id, "open", "done");
    expect(ok).toBe(false);
    const ok2 = await s.compareAndSetIntentState(id, "running", "done");
    expect(ok2).toBe(true);
    const n = await s.getNode(id);
    expect(n!.state).toBe("done");
    expect(n!.payload["fingerprint"]).toBeTruthy();
  });

  it("边/锚点幂等 + activity 写入（token 仅 result 行）", async () => {
    const expID = await db!.createExploration("测试写回", "验证边与活动");
    const s = db!.exploration(expID);
    const fact = await s.addNode("fact", { summary: "根" }, 0, "origin", "system", []);
    const intent = await s.addIntent({ summary: "写回测试" }, 5, [], "planner");
    await s.link(intent, RelYields, fact);
    await s.link(intent, RelYields, fact); // 幂等
    const edges = await s.db.query<{ rel: string }>(
      `SELECT rel FROM exploration_edges WHERE exploration_id=$1 AND src_id=$2`,
      [expID, intent],
    );
    expect(edges.rows.length).toBe(1);

    const stepID = await s.appendActivity({ node_id: intent, worker: "work#1", kind: "tool_use", summary: "curl http://x", tool: "Bash" });
    expect(stepID).toBeGreaterThan(0);
    const resID = await s.appendActivity({
      node_id: intent, worker: "work#1", kind: "result", summary: "完成",
      input_tokens: 100, output_tokens: 50,
    });
    const rows = await s.db.query<{ kind: string; input_tokens: number | null }>(
      `SELECT kind, input_tokens FROM activity WHERE exploration_id=$1 AND node_id=$2 ORDER BY id`,
      [expID, intent],
    );
    const toolRow = rows.rows.find((r) => r.kind === "tool_use")!;
    const resultRow = rows.rows.find((r) => r.kind === "result")!;
    expect(toolRow.input_tokens).toBeNull();
    expect(resultRow.input_tokens).toBe(100);
    expect(resID).toBeGreaterThan(stepID);
  });

  it("goal 状态与执行计数", async () => {
    const expID = await db!.createExploration("测试计数", "验证计数");
    const s = db!.exploration(expID);
    await s.addNode("fact", { summary: "根" }, 0, "origin", "system", []);
    const goal = await s.addGoal({ text: "目标一" }, "user");
    const counts = await s.executionCounts();
    expect(counts.goals).toBe(1);
    await s.setNodeState(goal, "met");
    const counts2 = await s.executionCounts();
    expect(counts2.met).toBe(1);
    const n = await s.getNode(goal);
    expect(n!.kind).toBe(KindGoal);
  });
});
