import { conversationDomainTools } from './conversations.js';
import {askUserTool} from '../pi/human-input.js';
import {trafficSearchTool} from './traffic-search.js';
import {webSearchTool,webReadTool} from './web-search.js';
import {mergedAssetSearchTool as assetSearchTool} from './asset-search-compat.js';
import { httpRequestTool } from "./evidence.js";
import {contextSearchTool,contextGetTool} from './context-read.js';
// 角色工具装配：每次 run 构造 ToolRunContext 后按角色产出工具集。
// 本地文件/命令工具不在领域层——由 pi 内置 bash/read/write/edit 承担（引擎层并入 allowlist）。

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRunContext } from "./context.js";
import { recordFactTool } from "./graph.js";
import { assetGetTool,insertAssetsTool,addTaskScopeTool } from "./assets.js";
import { reportFindingTool, listFindingsTool, proveGoalTool } from "./findings.js";
import { addIntentTool, dispatchIntentsTool, killWorkTool, steerWorkTool, todoWriteTool } from "./intents.js";
import { setGoalsTool, setConstraintsTool, registerUserTargetTool } from "./goals.js";
import { graphOverviewTool } from "./overview.js";

/** All implemented tools share one candidate inventory. User bindings decide
 * availability; task-dependent tools require a bound task, not a role name. */
export function availableDomainTools(ctx: ToolRunContext, conversationOptions: Parameters<typeof conversationDomainTools>[2] = {}): ToolDefinition[] {
  const tools: ToolDefinition[] = [askUserTool(), webSearchTool(ctx), webReadTool(ctx), contextGetTool(ctx),
    ...conversationDomainTools(ctx, ctx.hooks.platform, conversationOptions)];
  if (ctx.taskID > 0 && ctx.expID > 0) tools.push(
    trafficSearchTool(ctx), contextSearchTool(ctx), graphOverviewTool(ctx, {forWorker: ctx.role === 'worker'}),
    httpRequestTool(ctx), recordFactTool(ctx), insertAssetsTool(ctx), reportFindingTool(ctx),
    {...recordFactTool(ctx), name:'record_conversation_fact'}, {...reportFindingTool(ctx), name:'report_conversation_finding'},
    assetSearchTool(ctx), assetGetTool(ctx), listFindingsTool(ctx), addIntentTool(ctx), proveGoalTool(ctx),
    killWorkTool(ctx), steerWorkTool(ctx), addTaskScopeTool(ctx), todoWriteTool(ctx), dispatchIntentsTool(ctx),
    setGoalsTool(ctx), setConstraintsTool(ctx), registerUserTargetTool(ctx),
  );
  return tools;
}
export const workerTools = availableDomainTools;
export const plannerTools = availableDomainTools;
export const mainTools = availableDomainTools;
export const goalsTools = availableDomainTools;

export { buildGraphOverview, renderOverviewText } from "./overview.js";
export { loadConstraints } from "./goals.js";
export { TodoStore, runContext } from "./context.js";
export type { ToolRunContext, AgentRole, TodoItem, EngineHooks } from "./context.js";
