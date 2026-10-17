// 意图工具：add_intent（唯一意图生成入口，含去重与 mainagent 直投下发）、
// dispatch_intents、kill_work / steer_work（引擎回调）、todo_write（planner 跨轮共享）。

import { domainTool } from "./define.js";
import type { ToolRunContext, TodoItem } from "./context.js";
import { KindIntent, RelDerivedFrom, nodeCancelledByUser } from "../db/exploration.js";

interface AddIntentArgs { intents: { summary: string; parent_id?: number; asset_ids?: number[]; priority?: number }[]; }

export function addIntentTool(ctx: ToolRunContext) {
  return domainTool<AddIntentArgs>(
    {
      name: "add_intent",
      description:
        "提交 1~4 条探索意图进 frontier，worker 将按优先级领取执行。提交前逐一与 open/running 意图及" +
        "近期已完成意图比对：换措辞重复已有方向是严重错误。parent 必须是产出了证据的 fact/finding 节点" +
        "（发现驱动规划）。串行依赖链用 todo_write 记录，只派前置已满足的那一步。",
      promptSnippet: "派发探索意图（先查重）",
      parameters: {
        type: "object",
        properties: {
          intents: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            description: "意图列表",
            items: {
              type: "object",
              properties: {
                summary: { type: "string", description: "自包含的方向描述（做什么/为什么/预期产出）" },
                parent_id: { type: "integer", description: "依据的 fact/finding 节点 id（顶层可省略，自动连任务根）" },
                asset_ids: { type: "array", items: { type: "integer" }, description: "目标资产 id" },
                priority: { type: "integer", minimum: 1, maximum: 10, description: "默认 5" },
              },
              required: ["summary"],
            },
          },
        },
        required: ["intents"],
      },
      async run(args, c) {
        const s = c.db.exploration(c.expID);
        const originFact = await s.originFactID();
        const results: { summary: string; intent_id: number; created: boolean; duplicate_of?: number }[] = [];

        for (const item of args.intents) {
          // parent 校验：必须是本任务的 fact/finding（发现驱动）。
          let parentID = item.parent_id ?? 0;
          if (parentID > 0) {
            const parent = await s.getNode(parentID);
            if (!parent || !["fact", "finding"].includes(parent.kind)) {
              throw new Error(`parent_id #${parentID} 必须是本任务产出的事实或漏洞节点`);
            }
          } else {
            parentID = originFact; // 顶层意图挂任务根
          }
          const anchors = item.asset_ids ?? [];
          const payload: Record<string, unknown> = { summary: item.summary };
          if (parentID > 0) payload["parent_id"] = parentID;

          const useManaged = c.role === "planner";
          const res = useManaged
            ? await s.addPlannerIntentDeduplicated(payload, item.priority ?? 5, anchors, "planner")
            : await s.addIntentDeduplicated(payload, item.priority ?? 5, anchors, c.role === "worker" ? "worker" : "user");
          if (res.created && parentID > 0) {
            await s.link(parentID, RelDerivedFrom, res.id);
          }
          if (res.created) c.hooks.notifyIntent?.(c.expID, res.id);
          results.push({
            summary: item.summary,
            intent_id: res.id,
            created: res.created,
            ...(!res.created ? { duplicate_of: res.id } : {}),
          });
          // mainagent 直投：创建成功即下发（自动打 dispatch_requested 标记由引擎完成）。
          if (res.created && c.role === "mainagent") {
            await c.hooks.dispatchIntent?.(c.expID, res.id);
          }
        }
        return { submitted: results.filter((r) => r.created).length, intents: results };
      },
    },
    ctx,
  );
}

interface DispatchIntentsArgs { intent_ids?: number[]; }

export function dispatchIntentsTool(ctx: ToolRunContext) {
  return domainTool<DispatchIntentsArgs>(
    {
      name: "dispatch_intents",
      description:
        "把本任务 frontier 中已有（待执行）的意图下发给 worker 开始执行。仅任务主 Agent 可用；" +
        "手工执行模式下意图只有经此下发才会被执行。",
      promptSnippet: "下发待执行意图",
      parameters: {
        type: "object",
        properties: {
          intent_ids: {
            type: "array",
            items: { type: "integer" },
            maxItems: 10,
            description: "要下发的意图 id；省略则下发全部 open 意图",
          },
        },
      },
      async run(args, c) {
        if (c.role !== "mainagent") throw new Error("仅任务主 Agent 可以下发意图");
        const s = c.db.exploration(c.expID);
        let ids = args.intent_ids ?? [];
        if (ids.length === 0) {
          const open = await s.frontier(50);
          ids = open.map((n) => n.id);
        }
        let dispatched = 0;
        for (const id of ids) {
          const n = await s.getNode(id);
          if (!n || n.kind !== KindIntent || n.state !== "open" || nodeCancelledByUser(n)) continue;
          if (!c.hooks.dispatchIntent) throw new Error("当前运行环境不支持下发意图");
          await c.hooks.dispatchIntent(c.expID, id);
          dispatched++;
        }
        return { dispatched };
      },
    },
    ctx,
  );
}

interface KillWorkArgs { intent_id: number; reason: string; }

export function killWorkTool(ctx: ToolRunContext) {
  return domainTool<KillWorkArgs>(
    {
      name: "kill_work",
      description:
        "终止一条在跑（或卡住的）意图。用于明显无效/重复/越界的方向——先看 get_worker_trace 确认实际进度再杀。",
      promptSnippet: "终止在跑意图",
      parameters: {
        type: "object",
        properties: {
          intent_id: { type: "integer" },
          reason: { type: "string", description: "终止原因（审计留痕）" },
        },
        required: ["intent_id", "reason"],
      },
      async run(args, c) {
        if (!c.hooks.killWork) throw new Error("当前运行环境不支持 kill_work");
        await c.hooks.killWork(c.expID, args.intent_id, args.reason);
        return { killed: args.intent_id };
      },
    },
    ctx,
  );
}

interface SteerWorkArgs { intent_id: number; message: string; }

export function steerWorkTool(ctx: ToolRunContext) {
  return domainTool<SteerWorkArgs>(
    {
      name: "steer_work",
      description:
        "向一条在跑的意图注入纠偏指令：不打断执行，在其下一次工具调用前生效（阻塞该调用让它先读指令）。" +
        "用于运行中调整打法、补充约束、纠正方向。",
      promptSnippet: "运行中纠偏（不打断）",
      parameters: {
        type: "object",
        properties: {
          intent_id: { type: "integer" },
          message: { type: "string", description: "给该 worker 的指令" },
        },
        required: ["intent_id", "message"],
      },
      async run(args, c) {
        if (!c.hooks.steerWork) throw new Error("当前运行环境不支持 steer_work");
        await c.hooks.steerWork(c.expID, args.intent_id, args.message);
        return { steered: args.intent_id };
      },
    },
    ctx,
  );
}

interface TodoWriteArgs { todos: TodoItem[]; }

export function todoWriteTool(ctx: ToolRunContext) {
  return domainTool<TodoWriteArgs>(
    {
      name: "todo_write",
      description:
        "维护本任务的攻击链待办清单（跨规划轮保留）。规则：串行利用链逐条记录；每轮只对【前置已完成、" +
        "依赖的 fact 已存在】的下一步派意图；已由 fact 满足的步骤标记 completed；不要重复派 pending/" +
        "in_progress 的步骤。",
      promptSnippet: "更新攻击链待办（跨轮共享）",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            maxItems: 50,
            description: "完整待办列表（整体替换）",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
      async run(args, c) {
        if (!c.todos) throw new Error("todo_write 仅 planner 可用");
        c.todos.set(c.expID, args.todos as TodoItem[]);
        return { saved: args.todos.length };
      },
    },
    ctx,
  );
}
