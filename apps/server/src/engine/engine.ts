import { compactColdGraph } from "../agent/coldgraph.js";
// 引擎：事件驱动的任务调度核心（plannerLoop + N×workerLoop）。
// 平移 Go 版 server/engine.go 的骨架，按轻量化原则裁剪：
// - 保留：notify 单槽唤醒 + 800ms debounce、600s 心跳、worker 池 CAS 领取、
//   暂停/恢复、kill/steer、任务级超时收尾（简化：无 90s 宽限，直接 abort+终局轮）、
//   guarded 终态写入、goalless 任务自动完成。
// - 裁剪/延后：删除屏障/inflight 精细计数（简化为 stop 时 abort 全部在跑）、
//   activity token 计量（TODO M5）、冷图压缩（延后，graph_overview 有界投影兜底）、
//   BlackboardRevision 全量 md5（用计数+max(id) 的廉价指纹替代）。

import { EventEmitter } from "node:events";
import type { Database } from "../db/index.js";
import type { RunnerActivity } from "../pi/runner.js";
import type { ModelSource } from "../agent/roles.js";
import {
  runPlannerRound, runWorkerIntent, runMainChat, runGoalsDecompose,
  type WorkerRunResult,
} from "../agent/roles.js";
import { TodoStore } from "../tools/context.js";
import { WORKER_TASK_TIMEOUT_WRAPUP, PLANNER_TASK_TIMEOUT_WRAPUP } from "../agent/prompts.js";
import { interceptGate } from "../intercept/gate.js";

export interface EngineConfig {
  workers: number;
  debounceMs: number;
  heartbeatMs: number;
  workerMaxTurns: number;
  workerMaxDurationMs: number;
  plannerMaxTurns: number;
  mainMaxTurns: number;
}

export function defaultEngineConfig(): EngineConfig {
  return {
    workers: 3,
    debounceMs: 800,
    heartbeatMs: 600_000,
    workerMaxTurns: 30,
    workerMaxDurationMs: 20 * 60_000,
    plannerMaxTurns: 4,
    mainMaxTurns: 15,
  };
}

/** worker 被中断的原因（终态映射依据，对齐 Go cancelcause）。 */
export type AbortCause = "pause" | "cancel" | "kill" | "task-timeout" | "stop";

interface WorkHandle {
  abort: (cause: AbortCause) => Promise<void>;
  done: Promise<void>;
  cause?: AbortCause;
}

interface TaskRuntime {
  taskID: number;
  expID: number;
  triggers: string[];
  steer: Map<number, string[]>;
  work: Map<number, WorkHandle>;
  plannerBusy: Promise<unknown> | null;
  stopped: boolean;
  paused: boolean;
  settling: boolean;
  loops: Promise<void>[];
  todos: TodoStore;
  /** 单槽唤醒信号量：notify() 置位并唤醒；waitNotify 先消费再等待——防"waiter 注册前 notify 被丢"竞态。 */
  notifyPending: boolean;
  notifyWaiters: Array<() => void>;
  workerWaiters: Array<() => void>;
  started: boolean;
  workerRevision: number;
  plannerAbort?: AbortController;
  activityTail: Promise<unknown>;
}

export type EngineActivity = {
  taskID: number;
  expID: number;
  nodeID?: number | null;
  worker?: string;
  kind: string;
  tool?: string;
  isError?: boolean;
  summary?: string;
  detail?: string;
  toolCallId?: string;
  mainSeg?: number;
  streamID?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

/** 模型来源解析（引擎不感知 provider 细节；测试注入 faux）。 */
export type ModelResolver = (taskID: number, role: string) => Promise<ModelSource>;

export class Engine {
  readonly bus = new EventEmitter(); // activity 广播（M5 SSE 接这里）
  private tasks = new Map<number, TaskRuntime>();
  private loading = new Map<number, Promise<TaskRuntime>>();
  private starting = new Map<number, Promise<void>>();
  private chats = new Map<string, { controller: AbortController; done: Promise<string> }>();

  private async loadRuntime(taskID: number): Promise<TaskRuntime> {
    const current = this.tasks.get(taskID);
    if (current) return current;
    const loading = this.loading.get(taskID);
    if (loading) return loading;
    const promise = (async () => {
      const task = await this.db.tasks().getTask(taskID);
      if (!task) throw new Error(`任务 #${taskID} 不存在`);
      const rt: TaskRuntime = {
        taskID, expID: task.exploration_id, triggers: [], steer: new Map(), work: new Map(),
        plannerBusy: null, stopped: false, paused: task.paused === true || task.status === "paused",
        settling: false, loops: [], todos: new TodoStore(), notifyPending: false,
        notifyWaiters: [], workerWaiters: [], started: false, workerRevision: 0, activityTail: Promise.resolve(),
      };
      this.tasks.set(taskID, rt);
      return rt;
    })();
    this.loading.set(taskID, promise);
    try { return await promise; } finally { this.loading.delete(taskID); }
  }

  constructor(
    private db: Database,
    private cfg: EngineConfig,
    private modelResolver: ModelResolver,
    private dataDir: string,
    /** 出口网关地址（如 127.0.0.1:8788）；worker 的 bash 经它做任务级出口授权。 */
    private egressAddr?: string,
  ) {
    this.bus.setMaxListeners(100);
  }

  // ─── 任务运行时 ───────────────────────────────────────────────────────────

  private rt(taskID: number): TaskRuntime | undefined {
    return this.tasks.get(taskID);
  }

  private mustRt(taskID: number): TaskRuntime {
    const t = this.tasks.get(taskID);
    if (!t) throw new Error(`任务 #${taskID} 未在引擎中运行`);
    return t;
  }

  /** 启动任务：goals 分解（可选）→ plannerLoop + worker 池。幂等（重复 Run 只踢一轮规划）。 */
  async run(taskID: number, opts: { decompose?: { description: string } } = {}): Promise<void> {
    const pending = this.starting.get(taskID);
    if (pending) return pending;
    const start = this.startTask(taskID, opts);
    this.starting.set(taskID, start);
    try { await start; } finally { this.starting.delete(taskID); }
  }

  private async startTask(taskID: number, opts: { decompose?: { description: string } }): Promise<void> {
    const rt = await this.loadRuntime(taskID);
    if (rt.started && !rt.stopped) { this.notify(taskID); return; }
    if (rt.stopped) await Promise.allSettled(rt.loops);
    rt.stopped = false;
    rt.settling = false;
    rt.started = true;
    rt.paused = false;
    rt.loops = [];
    try {
    // 重启恢复：running 意图回 open（无在跑 worker 的僵尸态）。
    await this.db.exploration(rt.expID).resetRunningIntents().catch(() => 0);

    if (opts.decompose) {
      rt.plannerAbort = new AbortController();
      await (async () => {
      const model = await this.modelResolver(taskID, "goals");
      return runGoalsDecompose({
        db: this.db, taskID, expID: rt.expID, model, dataDir: this.dataDir,
        description: opts.decompose!.description, signal: rt.plannerAbort!.signal,
      });
      })().catch((err) => {
        this.emitActivity(taskID, { kind: "result", worker: "system", summary: `目标分解失败：${err instanceof Error ? err.message : String(err)}` });
      });
      // ARTEX 同款兜底：分解失败/空产出时规则拆分——goal 节点必须存在，
      // 否则 goalless 判定会把任务立即误判为「frontier 已抽干」而结束。
      const s = this.db.exploration(rt.expID);
      const goalCount = (await s.listByKind("goal", 5)).length;
      if (goalCount === 0) {
        const fallbackGoal = await s.addGoal({ text: (await this.db.tasks().getTask(taskID))?.goal ?? opts.decompose.description }, "system");
        const origin = await s.originFactID();
        if (origin > 0) await s.link(origin, "spawns", fallbackGoal);
        this.emitActivity(taskID, { kind: "result", worker: "system", summary: "目标分解未产出，已回退规则拆分（整体目标兜底）" });
      }
    }

    if (rt.stopped) return;
    const supervise = (name: string, loop: () => Promise<void>) => (async () => {
      while (!rt.stopped) {
        try { await loop(); return; }
        catch (err) {
          this.emitActivity(taskID, { kind: "result", worker: "system", isError: true, summary: `${name}异常：${String(err)}` });
          await this.waitWorker(rt, 1000, rt.workerRevision);
        }
      }
    })();
    rt.loops.push(supervise("planner", () => this.plannerLoop(rt)));
    for (let i = 1; i <= this.cfg.workers; i++) {
      rt.loops.push(supervise(`work#${i}`, () => this.workerLoop(rt, `work#${i}`)));
    }
    rt.loops.push(supervise("deadline", () => this.deadlineLoop(rt)));
    this.notify(taskID);
    } catch (err) {
      rt.started = false;
      this.emitActivity(taskID, { kind: "result", worker: "system", isError: true, summary: `任务启动失败：${String(err)}` });
      throw err;
    }
  }

  // ─── 唤醒原语 ─────────────────────────────────────────────────────────────

  notify(taskID: number, trigger?: string): void {
    const rt = this.rt(taskID);
    if (!rt) return;
    if (trigger) rt.triggers.push(trigger);
    rt.notifyPending = true;
    // ARTEX 语义：Notify 同时唤醒 worker 与 planner——意图一出现立即有人领，
    // 不等 planner 轮结束（planner 轮慢时 worker 曾因此闲置数分钟）。
    this.wakeWorkers(rt);
    const waiters = rt.notifyWaiters.splice(0);
    for (const w of waiters) w();
  }

  private wakeWorkers(rt: TaskRuntime): void {
    rt.workerRevision++;
    const waiters = rt.workerWaiters.splice(0);
    for (const w of waiters) w();
  }

  private waitNotify(rt: TaskRuntime, ms: number): Promise<void> {
    if (rt.notifyPending) {
      rt.notifyPending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        rt.notifyWaiters = rt.notifyWaiters.filter((w) => w !== wake);
        resolve();
      }, ms);
      const wake = () => {
        clearTimeout(timer);
        rt.notifyPending = false;
        resolve();
      };
      rt.notifyWaiters.push(wake);
    });
  }

  private waitWorker(rt: TaskRuntime, ms: number, revision: number): Promise<void> {
    if (rt.stopped || revision !== rt.workerRevision) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        rt.workerWaiters = rt.workerWaiters.filter((w) => w !== wake);
        resolve();
      }, ms);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      rt.workerWaiters.push(wake);
    });
  }

  // ─── plannerLoop ──────────────────────────────────────────────────────────

  private async plannerLoop(rt: TaskRuntime): Promise<void> {
    let lastRevision = "";
    while (!rt.stopped) {
      // 停滞看门狗：目标未达成且无活跃意图（frontier 空且无在跑）→ 心跳不跳过、缩短重试间隔，
      // 否则一次"空产出轮"会让任务永久停滞（真实验证发现的缺陷：模型违反硬底线时无兜底）。
      let stalled = false;
      {
        const s0 = this.db.exploration(rt.expID);
        const c0 = await s0.executionCounts().catch(() => ({ running: 0, goals: 0, met: 0 }));
        stalled = c0.goals > 0 && c0.met < c0.goals && !(await s0.hasActiveIntent().catch(() => true));
      }
      await this.waitNotify(rt, stalled ? 120_000 : this.cfg.heartbeatMs);
      if (rt.stopped) break;
      // debounce：吸收 800ms 内的突发变更。
      await new Promise((r) => setTimeout(r, this.cfg.debounceMs));
      if (rt.stopped || rt.paused || rt.settling) continue;

      const s = this.db.exploration(rt.expID);
      const counts = await s.executionCounts();

      // goalless 任务：无开放目标 → planner 不进模型，frontier 抽干即完成。
      if (counts.goals === 0) {
        if (!(await s.hasActiveIntent())) {
          await this.finishTask(rt, "done", "无目标任务的 frontier 已抽干");
          break;
        }
        continue;
      }
      // 全部资产待审批：省一次模型调用。
      if (await s.waitingForAssetApproval().catch(() => false)) continue;

      // 心跳跳过：无触发、无在跑、黑板指纹未变。
      const hasTriggers = rt.triggers.length > 0;
      const hasRunning = counts.running > 0;
      const revision = await this.blackboardRevision(rt);
      const stalledNow = counts.goals > 0 && counts.met < counts.goals && counts.running === 0 && !(await s.hasActiveIntent().catch(() => true));
      if (!hasTriggers && !hasRunning && !stalledNow && revision === lastRevision) continue;
      lastRevision = revision;

      const triggersText =
        rt.triggers.length > 0 ? `【本轮触发】\n${rt.triggers.splice(0).join("\n")}` : "【本轮触发】心跳唤醒（无新事件）";
      const task = await this.db.tasks().getTask(rt.taskID);
      const goal = task?.goal ?? task?.description ?? "";

      const model = await this.modelFor(rt, "planner");
      if (!model) continue;

      await compactColdGraph(this.db, rt.expID);
      rt.plannerAbort = new AbortController();
      const round = runPlannerRound({
        db: this.db, taskID: rt.taskID, expID: rt.expID, goal, model,
        dataDir: this.dataDir, todos: rt.todos, hooks: this.engineHooks(rt),
        triggersText, maxTurns: this.cfg.plannerMaxTurns, signal: rt.plannerAbort.signal,
        onActivity: (a, meta) => this.mapActivity(rt, a, { worker: meta.worker }),
      });
      rt.plannerBusy = round;
      await round.then((r) => {
        const u = r.usage;
        this.emitActivity(rt.taskID, {
          kind: "result", worker: "planner",
          summary: (r.lastAssistantText ?? "规划轮完成").slice(0, 2000),
          ...(u ? { inputTokens: u.input, outputTokens: u.output, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite } : {}),
        });
      }).catch((err) => {
        this.emitActivity(rt.taskID, { kind: "result", worker: "planner", summary: `规划轮失败：${err instanceof Error ? err.message : String(err)}` });
      });
      rt.plannerBusy = null;

      this.wakeWorkers(rt);

      if (rt.stopped || rt.paused || rt.settling) continue;
      // 收官检查：全部目标 met → done 并取消在跑。
      const after = await s.executionCounts();
      if (after.goals > 0 && after.met >= after.goals) {
        await this.cancelAllWorks(rt, "stop");
        await this.finishTask(rt, "done", "全部目标已证明达成");
        break;
      }
    }
  }

  // ─── workerLoop ───────────────────────────────────────────────────────────

  private async modelFor(rt: TaskRuntime, role: string): Promise<ModelSource | null> {
    try { return await this.modelResolver(rt.taskID, role); }
    catch (err) {
      this.emitActivity(rt.taskID, { kind: "result", worker: role, isError: true, summary: `模型配置不可用：${String(err)}` });
      return null;
    }
  }

  private async workerLoop(rt: TaskRuntime, name: string): Promise<void> {
    while (!rt.stopped) {
      const revision = rt.workerRevision;
      if (!rt.paused && !rt.settling) {
        const s = this.db.exploration(rt.expID);
        if (await s.hasOpenIntent()) {
          const model = await this.modelFor(rt, "worker");
          if (model && !rt.stopped && !rt.paused && !rt.settling) {
            const intent = await s.claimNextWorker(name);
            if (intent) {
              if (rt.stopped || rt.paused || rt.settling) {
                await s.compareAndSetIntentState(intent.id, "running", "open");
              } else {
                await this.runOneIntent(rt, intent, name, model);
                continue; // Drain the queue before waiting; wake-ups during execution cannot be lost.
              }
            }
          }
        }
      }
      await this.waitWorker(rt, 30_000, revision);
    }
  }

  private async runOneIntent(rt: TaskRuntime, intent: { id: number }, name: string, model: ModelSource): Promise<void> {
    const s = this.db.exploration(rt.expID);
    this.emitActivity(rt.taskID, {
      nodeID: intent.id, worker: name, kind: "round",
      summary: `Worker ${name} 领取意图 #${intent.id}`,
    });

    let cause: AbortCause | undefined;
    const controller = new AbortController();
    let complete!: () => void;
    const handle: WorkHandle = {
      abort: async (c) => {
        cause = c;
        handle.cause = c;
        controller.abort(c);
      },
      done: new Promise<void>((resolve) => { complete = resolve; }),
    };
    rt.work.set(intent.id, handle);

    let result: WorkerRunResult | null = null;
    let failure: unknown = null;
    try {
      result = await runWorkerIntent({
        db: this.db, taskID: rt.taskID, expID: rt.expID,
        intent: intent as never, workerName: name, model,
        dataDir: this.dataDir,
        maxTurns: this.cfg.workerMaxTurns,
        maxDurationMs: this.cfg.workerMaxDurationMs,
        egressAddr: this.egressAddr,
        hooks: this.engineHooks(rt),
        extraGuard: interceptGate(this.db, { taskID: rt.taskID, agentName: "worker", worker: name }),
        takeSteer: (id) => {
          const msgs = rt.steer.get(id) ?? [];
          rt.steer.delete(id); // 取走即清空（drain 语义）：同一条纠偏只 block 一次
          return msgs;
        },
        onActivity: (a, meta) => this.mapActivity(rt, a, meta),
        signal: controller.signal,
      });
    } catch (err) {
      failure = err;
    }

    try {
    // 终态映射（对齐 Go runIntent 分类）。
    let terminal = "done";
    let summary = result?.lastAssistantText ?? "";
    if (cause === "pause") {
      await s.compareAndSetIntentState(intent.id, "running", "open");
      this.notify(rt.taskID, `意图 #${intent.id} 因任务暂停回到队列`);
      return;
    }
    if (cause === "cancel") terminal = "paused";
    else if (cause === "kill") terminal = "stopped";
    else if (cause === "task-timeout") terminal = "exhausted";
    else if (cause === "stop") terminal = "stopped";
    else if (result?.stopReason === "budget") terminal = "exhausted";
    else if (result?.aborted) terminal = "stopped";
    else if (failure) {
      terminal = "blocked";
      summary = failure instanceof Error ? failure.message : String(failure);
    }
    await s.compareAndSetIntentState(intent.id, "running", terminal);
    const u = result?.usage;
    this.emitActivity(rt.taskID, {
      nodeID: intent.id, worker: name, kind: "result", summary: summary || `意图 #${intent.id} ${terminal}`,
      ...(u ? { inputTokens: u.input, outputTokens: u.output, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite } : {}),
    });
    this.notify(rt.taskID, `Worker 完成：意图 #${intent.id} → ${terminal}${summary ? `（${summary.slice(0, 400)}）` : ""}`);
    } finally {
      rt.work.delete(intent.id);
      rt.steer.delete(intent.id);
      complete();
    }
  }

  // ─── 控制面 ───────────────────────────────────────────────────────────────

  async pause(taskID: number): Promise<void> {
    const rt = this.rt(taskID);
    if (rt) { rt.paused = true; rt.plannerAbort?.abort("pause"); }
    await this.stopMainChat(taskID);
    if (rt) { await this.cancelAllWorks(rt, "pause"); await rt.plannerBusy; }
  }

  async resume(taskID: number): Promise<void> {
    const rt = this.rt(taskID);
    if (!rt || !rt.started || rt.stopped) {
      // 服务重启后任务不在引擎运行时里：resume 语义 = 重新装载并跑起来。
      await this.run(taskID);
      return;
    }
    rt.paused = false;
    this.notify(taskID);
    this.wakeWorkers(rt);
  }

  async stop(taskID: number): Promise<void> {
    const rt = this.rt(taskID);
    if (!rt) return;
    rt.stopped = true;
    rt.plannerAbort?.abort("stop");
    await this.stopMainChat(taskID);
    await this.starting.get(taskID)?.catch(() => undefined);
    await this.cancelAllWorks(rt, "stop");
    this.notify(taskID);
    this.wakeWorkers(rt);
    await Promise.allSettled(rt.loops);
    await rt.activityTail;
    this.tasks.delete(taskID);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.tasks.keys()].map((id) => this.stop(id)));
  }

  async killWork(taskID: number, intentID: number, reason: string): Promise<void> {
    const rt = this.mustRt(taskID);
    const handle = rt.work.get(intentID);
    if (!handle) throw new Error(`意图 #${intentID} 不在运行中`);
    await handle.abort("kill");
    this.emitActivity(taskID, {
      nodeID: intentID, worker: "system", kind: "result",
      summary: `意图 #${intentID} 被终止：${reason}`,
    });
  }

  steerWork(taskID: number, intentID: number, message: string): void {
    const rt = this.mustRt(taskID);
    if (!rt.work.has(intentID)) throw new Error(`意图 #${intentID} 不在运行中`);
    const list = rt.steer.get(intentID) ?? [];
    list.push(message);
    rt.steer.set(intentID, list);
  }

  /** Chat owns a session, not a worker pool. Reading a paused/finished task must not restart it. */
  async mainChat(taskID: number, message: string, segment = 0): Promise<string> {
    const key = `${taskID}:${segment}`;
    if (this.chats.has(key)) throw new Error("该会话正在回复，请先停止当前回复");
    const controller = new AbortController();
    const done = (async () => {
      const rt = await this.loadRuntime(taskID);
      const task = await this.db.tasks().getTask(taskID);
      const model = await this.modelResolver(taskID, "mainagent");
      controller.signal.throwIfAborted();
      this.emitActivity(taskID, { kind: "user", worker: "main", mainSeg: segment, summary: message, detail: message });
      try {
        const res = await runMainChat({
          db: this.db, taskID, expID: rt.expID, goal: task?.goal ?? task?.description ?? "",
          model, dataDir: this.dataDir, hooks: this.engineHooks(rt), message, segment,
          signal: controller.signal, maxTurns: this.cfg.mainMaxTurns,
          onActivity: (a, meta) => this.mapActivity(rt, a, { worker: meta.worker, mainSeg: segment }),
        });
        this.emitActivity(taskID, { kind: "result", worker: "main", mainSeg: segment,
          summary: res.aborted ? "回复已停止" : "回复完成", inputTokens: res.usage.input, outputTokens: res.usage.output,
          cacheReadTokens: res.usage.cacheRead, cacheWriteTokens: res.usage.cacheWrite });
        return res.lastAssistantText ?? "";
      } finally { await rt.activityTail; }
    })();
    this.chats.set(key, { controller, done });
    try { return await done; } finally { this.chats.delete(key); }
  }

  mainChatRunning(taskID: number): boolean {
    return [...this.chats.keys()].some((key) => key.startsWith(`${taskID}:`));
  }

  async stopMainChat(taskID: number): Promise<void> {
    const chats = [...this.chats].filter(([key]) => key.startsWith(`${taskID}:`)).map(([, chat]) => chat);
    for (const chat of chats) chat.controller.abort("user");
    await Promise.allSettled(chats.map((chat) => chat.done));
  }

  private async cancelAllWorks(rt: TaskRuntime, cause: AbortCause): Promise<void> {
    const works = [...rt.work.values()];
    await Promise.all(works.map((w) => w.abort(cause)));
    await Promise.allSettled(works.map((w) => w.done));
  }

  private async finishTask(rt: TaskRuntime, status: "done" | "timeout", note: string): Promise<void> {
    // 注意：本函数可能从 plannerLoop/deadlineLoop 内部调用——绝不能 await rt.loops
    // （自等待死锁）。置停 + 唤醒 + 摘除任务即可，循环见 stopped 自行退出。
    rt.stopped = true;
    this.emitActivity(rt.taskID, { kind: "result", worker: "system", summary: note });
    await this.db.tasks().setTaskStatusGuarded(rt.taskID, status).catch(() => undefined);
    await this.cancelAllWorks(rt, "stop");
    this.notify(rt.taskID);
    this.wakeWorkers(rt);
    // Keep chat state available; run() can restart the drained scheduler explicitly.
    rt.started = false;
  }

  // ─── 任务级超时（deadline 协调，简化版）───────────────────────────────────

  private async deadlineLoop(rt: TaskRuntime): Promise<void> {
    while (!rt.stopped) {
      await new Promise((r) => setTimeout(r, 2_000));
      if (rt.stopped) return;
      if (rt.settling) continue;
      const row = await this.db
        .query<{ deadline_at: string | null; status: string }>(
          `SELECT deadline_at, status FROM tasks WHERE id=$1`,
          [rt.taskID],
        )
        .catch(() => null);
      const deadline = row?.rows[0]?.deadline_at;
      if (!deadline || row?.rows[0]?.status !== "running") continue;
      if (Date.now() < new Date(deadline).getTime()) continue;
      await this.settleTask(rt);
      return;
    }
  }

  /** 超时收尾：置 settling → abort 在跑（timeout 收尾词已注入的由 wrapup 兜底）→ 终局 planner 轮 → guarded 终态。 */
  private async settleTask(rt: TaskRuntime): Promise<void> {
    if (rt.settling) return;
    rt.settling = true;
    this.emitActivity(rt.taskID, { kind: "result", worker: "system", summary: "任务到达超时上限，开始收尾" });
    rt.plannerAbort?.abort("task-timeout");
    await rt.plannerBusy;
    await this.cancelAllWorks(rt, "task-timeout");
    // 等在跑意图落终态。
    for (let i = 0; i < 100 && rt.work.size > 0; i++) await new Promise((r) => setTimeout(r, 200));

    // 终局 planner 轮：只判目标、不派意图（任务超时词注入）。
    const s = this.db.exploration(rt.expID);
    const model = await this.modelFor(rt, "planner");
    if (model) {
      const task = await this.db.tasks().getTask(rt.taskID);
      await runPlannerRound({
        db: this.db, taskID: rt.taskID, expID: rt.expID,
        goal: task?.goal ?? task?.description ?? "",
        model, dataDir: this.dataDir, todos: rt.todos, hooks: this.engineHooks(rt),
        triggersText: "【本轮触发】任务超时收尾（终局判定：只 prove_goal，不派新意图）",
        maxTurns: 3, signal: (rt.plannerAbort = new AbortController()).signal,
        terminalOnly: true,
        wrapupPromptOverride: PLANNER_TASK_TIMEOUT_WRAPUP,
        onActivity: (a, meta) => this.mapActivity(rt, a, { worker: meta.worker }),
      }).catch(() => undefined);
    }
    if (rt.stopped || rt.paused) return;
    const counts = await s.executionCounts();
    const status = counts.goals > 0 && counts.met >= counts.goals ? "done" : "timeout";
    await this.finishTask(rt, status, status === "done" ? "任务超时前全部目标已证明" : "任务超时结束");
  }

  // ─── 杂项 ─────────────────────────────────────────────────────────────────

  private engineHooks(rt: TaskRuntime) {
    return {
      notifyFinding: (expID: number, nodeID: number) => {
        void expID;
        this.notify(rt.taskID, `新漏洞报告：节点 #${nodeID}（已即时唤醒规划）`);
      },
      notifyGoalMet: (expID: number, goalID: number) => {
        void expID;
        this.notify(rt.taskID, `目标 #${goalID} 已被证明达成`);
      },
      notifyIntent: (_expID: number, _intentID: number) => this.wakeWorkers(rt),
      dispatchIntent: async (_expID: number, intentID: number) => {
        const updated = await this.db.query(
          `UPDATE exploration_nodes SET payload=payload||jsonb_build_object('dispatch_requested',true)
           WHERE id=$1 AND exploration_id=$2 AND kind='intent' AND state='open'
           AND payload->>'cancelled_by_user' IS DISTINCT FROM 'true' RETURNING id`,
          [intentID, rt.expID],
        );
        if (!updated.rowCount) throw new Error(`意图 #${intentID} 不可下发`);
        await this.db.tasks().setTaskStatus(rt.taskID, "running");
        await this.resume(rt.taskID);
        this.notify(rt.taskID, `意图 #${intentID} 已下发`);
      },
      killWork: async (expID: number, intentID: number, reason: string) => {
        void expID;
        await this.killWork(rt.taskID, intentID, reason);
      },
      steerWork: async (expID: number, intentID: number, message: string) => {
        void expID;
        this.steerWork(rt.taskID, intentID, message);
      },
    };
  }

  /** 廉价黑板指纹：计数 + max(id)（替代 Go 的全量 md5，心跳跳过够用）。 */
  private async blackboardRevision(rt: TaskRuntime): Promise<string> {
    const res = await this.db.query<{ rev: string }>(
      `SELECT (SELECT count(*)||':'||COALESCE(max(id),0) FROM exploration_nodes WHERE exploration_id=$1)
            ||'/'||(SELECT count(*) FROM exploration_edges WHERE exploration_id=$1)
            ||'/'||(SELECT count(*) FROM findings WHERE task_id=$2) AS rev`,
      [rt.expID, rt.taskID],
    );
    return res.rows[0]?.rev ?? "";
  }

  private mapActivity(
    rt: TaskRuntime,
    a: RunnerActivity,
    meta: { intentID?: number; worker: string; mainSeg?: number },
  ): void {
    switch (a.kind) {
      case "assistant_delta":
        this.bus.emit("delta", { taskID: rt.taskID, expID: rt.expID, worker: meta.worker, nodeID: meta.intentID, mainSeg: meta.mainSeg, text: a.text, streamID: a.streamID, isThinking: a.isThinking });
        break;
      case "assistant_message_end":
        if (!a.text) break;
        this.emitActivity(rt.taskID, {
          nodeID: meta.intentID ?? null, worker: meta.worker, mainSeg: meta.mainSeg,
          kind: a.isThinking ? "thinking" : "text", streamID: a.streamID,
          summary: a.text.slice(0, 4000), detail: a.text,
        });
        break;
      case "tool_start":
        this.emitActivity(rt.taskID, {
          nodeID: meta.intentID ?? null, worker: meta.worker, mainSeg: meta.mainSeg, kind: "tool_use",
          toolCallId: a.toolCallId, tool: a.toolName, summary: toolCallSummary(a.toolName, a.args),
          detail: JSON.stringify(a.args).slice(0, 8000),
        });
        break;
      case "tool_end":
        this.emitActivity(rt.taskID, {
          nodeID: meta.intentID ?? null, worker: meta.worker, mainSeg: meta.mainSeg, kind: "tool_result",
          toolCallId: a.toolCallId, tool: a.toolName, isError: a.isError,
          detail: a.text?.slice(0, 4000),
        });
        break;
      case "settled":
        break;
      default:
        break;
    }
  }

  private emitActivity(taskID: number, a: Omit<EngineActivity, "taskID" | "expID">): void {
    const rt = this.rt(taskID);
    if (!rt) return;
    const act = { taskID, expID: rt.expID, ...a };
    // 持久化（best-effort）+ 进程内广播（M5 SSE 订阅）。
    rt.activityTail = rt.activityTail.then(() => this.db
      .exploration(rt.expID)
      .appendActivity({
        node_id: act.nodeID ?? undefined,
        tool_use_id: act.toolCallId,
        main_seg: act.mainSeg,
        worker: act.worker,
        kind: act.kind,
        tool: act.tool,
        is_error: act.isError,
        summary: act.summary,
        detail: act.detail,
        input_tokens: act.inputTokens,
        output_tokens: act.outputTokens,
        cache_read_tokens: act.cacheReadTokens,
        cache_write_tokens: act.cacheWriteTokens,
      }))
      .then((id) => {
        this.bus.emit("activity", { ...act, id });
      })
      .catch(() => undefined);
  }
}


/** 工具调用摘要：bash/命令显示原文片段；领域工具取核心参数。 */
function toolCallSummary(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (toolName === "bash" && typeof a["command"] === "string") {
    return a["command"].replace(/\s+/g, " ").slice(0, 120);
  }
  if (typeof a["summary"] === "string") return a["summary"].slice(0, 100);
  if (Array.isArray(a["intents"])) return `提交 ${a["intents"].length} 条意图`;
  if (typeof a["query"] === "string") return String(a["query"]).slice(0, 80);
  if (typeof a["node_id"] === "number") return `节点 #${a["node_id"]}`;
  return toolName;
}
