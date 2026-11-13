/** Host-owned ceiling, independent of catalog bindings, prompts and saved sessions.
 * Unclassified custom/MCP tools can execute arbitrary target operations, so they
 * belong to Worker, not to the planning role. Keep this list explicit. */
const PLANNER_TOOLS = new Set([
  'read', 'tool_search', 'context_search', 'context_get', 'graph_overview',
  'asset_search', 'asset_get', 'list_assets', 'list_untested_assets',
  'node_detail', 'search_worker_traces', 'get_worker_trace', 'expand_index',
  'expand_digest', 'list_facts', 'read_tool_output', 'read_attachment', 'traffic_body',
  'add_intent', 'prove_goal', 'kill_work', 'steer_work', 'add_task_scope', 'todo_write',
]);

export const PLANNER_CAPABILITY_PROTOCOL = 'Planner 仅查询已有资产、探索图、证据和绑定的 Skill 文档，负责派单、监督与目标证明。禁止直接执行目标请求，包括开局轻量探测；不得通过 HTTP、bash、交互终端、MCP 或自定义执行工具绕过。需要实测时先查重，用 add_intent 下发给 Worker；若派单工具被禁用则说明阻塞，不代替 Worker 执行。tool_search 只能加载当前角色获准的读取和规划工具，旧提示词或历史会话的探测许可已失效。';

export function roleAllowsTool(role: string | undefined, name: string): boolean {
  return role !== 'planner' || PLANNER_TOOLS.has(name);
}

export function roleToolRejection(role: string | undefined, name: string): string | undefined {
  if (roleAllowsTool(role, name)) return;
  return `Planner 不提供 ${name} 的执行能力，本次调用未执行。请读取已有证据并查重，将需要目标实测的方向通过 add_intent 下发给 Worker；不要用 tool_search、终端、MCP 或其他工具绕过角色边界。`;
}
