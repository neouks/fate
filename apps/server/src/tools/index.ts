import {httpRequestTool,trafficBodyTool,readAttachmentTool} from "./evidence.js";
import { graphIndexTool, expandDigestTool } from "./graph_read.js";
// 角色工具装配：每次 run 构造 ToolRunContext 后按角色产出工具集。
// 本地文件/命令工具不在领域层——由 pi 内置 bash/read/write/edit 承担（引擎层并入 allowlist）。

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRunContext } from "./context.js";
import { recordFactTool, nodeDetailTool, searchWorkerTracesTool, getWorkerTraceTool } from "./graph.js";
import { insertAssetsTool, listAssetsTool, listUntestedAssetsTool, addTaskScopeTool } from "./assets.js";
import { reportFindingTool, listFindingsTool, proveGoalTool } from "./findings.js";
import { addIntentTool, dispatchIntentsTool, killWorkTool, steerWorkTool, todoWriteTool } from "./intents.js";
import { setGoalsTool, setConstraintsTool, registerUserTargetTool } from "./goals.js";
import { graphOverviewTool } from "./overview.js";

/** 共享读集：三类 agent 都可用；worker 视角不带 coverage（Go 语义：只看方向不看度量）。 */
function sharedReadTools(ctx: ToolRunContext, forWorker = false): ToolDefinition[] {
  return [
    readAttachmentTool(ctx),
    graphOverviewTool(ctx, { forWorker }),
    nodeDetailTool(ctx),
    graphIndexTool(ctx), graphIndexTool(ctx,"list_facts","fact"), expandDigestTool(ctx),
    searchWorkerTracesTool(ctx),
    getWorkerTraceTool(ctx),
  ];
}

/** worker：一条意图的执行者（三通道写回 + 查重 + 过程复用）。 */
export function workerTools(ctx: ToolRunContext): ToolDefinition[] {
  return [httpRequestTool(ctx), trafficBodyTool(ctx),
    ...sharedReadTools(ctx, true),
    recordFactTool(ctx),
    insertAssetsTool(ctx),
    reportFindingTool(ctx),
    listFindingsTool(ctx),
    listAssetsTool(ctx),
  ];
}

/** planner：唯一意图生成者（态势 → 派意图 → 监督操舵 → 收官）。 */
export function plannerTools(ctx: ToolRunContext): ToolDefinition[] {
  return [
    ...sharedReadTools(ctx),
    addIntentTool(ctx),
    proveGoalTool(ctx),
    killWorkTool(ctx),
    steerWorkTool(ctx),
    addTaskScopeTool(ctx),
    listUntestedAssetsTool(ctx),
    listFindingsTool(ctx),
    listAssetsTool(ctx),
    todoWriteTool(ctx),
  ];
}

/** mainagent：人在环路操舵口（目标/约束/直投/下发/纠偏 + 只读观察）。 */
export function mainTools(ctx: ToolRunContext): ToolDefinition[] {
  return [
    ...sharedReadTools(ctx),
    setGoalsTool(ctx),
    setConstraintsTool(ctx),
    addIntentTool(ctx),
    dispatchIntentsTool(ctx),
    killWorkTool(ctx),
    steerWorkTool(ctx),
    listFindingsTool(ctx),
    listAssetsTool(ctx),
    listUntestedAssetsTool(ctx),
  ];
}

/** goals：任务创建时的目标分解（一次性 run）。 */
export function goalsTools(ctx: ToolRunContext): ToolDefinition[] {
  return [setGoalsTool(ctx), setConstraintsTool(ctx), registerUserTargetTool(ctx)];
}

export { buildGraphOverview, renderOverviewText } from "./overview.js";
export { loadConstraints } from "./goals.js";
export { TodoStore, runContext } from "./context.js";
export type { ToolRunContext, AgentRole, TodoItem, EngineHooks } from "./context.js";
