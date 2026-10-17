// 工具运行上下文：领域工具与 store/引擎回调的唯一连接面。
// 每次 run（planner 轮 / worker 意图 / mainagent 回合 / goals 分解）构造一份，
// 工具工厂闭包持有它——工具不感知 HTTP、不感知 pi，只依赖此接口（低耦合关键）。

import type { Database } from "../db/index.js";

export type AgentRole = "planner" | "worker" | "mainagent" | "goals" | "chat";

/** planner 跨唤醒共享的规划待办（按任务保留，内存态；引擎 M4 持有实例）。 */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}
export class TodoStore {
  private byExp = new Map<number, TodoItem[]>();
  get(expID: number): TodoItem[] {
    return this.byExp.get(expID) ?? [];
  }
  set(expID: number, todos: TodoItem[]): void {
    // 上限防御：planner 一次提交过多时只保留前 50 条。
    this.byExp.set(expID, todos.slice(0, 50));
  }
}

/** 引擎注入的回调面（M4 实装；M3 期由测试注入桩）。 */
export interface EngineHooks {
  /** worker 报洞 → 立即唤醒 planner。 */
  notifyFinding?: (expID: number, findingNodeID: number) => void;
  /** 目标被证明 → 判定任务完成（取消在跑 worker）。 */
  notifyGoalMet?: (expID: number, goalNodeID: number) => void;
  /** mainagent 直投意图 → 自动下发。 */
  dispatchIntent?: (expID: number, intentID: number) => Promise<void>;
  notifyIntent?: (expID: number, intentID: number) => void;
  /** planner/mainagent 杀掉一条在跑意图。 */
  killWork?: (expID: number, intentID: number, reason: string) => Promise<void>;
  /** 对在跑 worker 的下一次工具调用前注入纠偏消息（不打断）。 */
  steerWork?: (expID: number, intentID: number, message: string) => Promise<void>;
}

export interface ToolRunContext {
  db: Database;
  taskID: number;
  expID: number;
  role: AgentRole;
  /** worker 执行名（work#N），活动流归属用。 */
  workerName?: string;
  /** worker 绑定的意图 id（写通道纪律：只能写回自己的意图）。 */
  intentID?: number;
  /** planner 跨唤醒 TodoStore（todo_write 与态势渲染用）。 */
  todos?: TodoStore;
  hooks: EngineHooks;
}

export function runContext(
  db: Database,
  taskID: number,
  expID: number,
  role: AgentRole,
  overrides: Partial<ToolRunContext> = {},
): ToolRunContext {
  return { db, taskID, expID, role, hooks: {}, ...overrides };
}
