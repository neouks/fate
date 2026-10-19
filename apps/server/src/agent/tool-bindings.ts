import { effectiveToolDescription } from './tool-descriptions.js';

/** DB 工具目录过滤：按 tools.agents 绑定与 enabled 开关过滤角色可用工具（绑定 DB 可管）。 */
/** 种子清单内的 key 才应用 DB 绑定（防 Go 时代遗留孤儿行污染过滤）。 */
const SEEDED_TOOL_KEYS = new Set([
  "bash","read","write","edit","graph_overview","node_detail","search_worker_traces","get_worker_trace",
  "record_fact","insert_assets","report_finding","list_findings","list_assets","list_untested_assets",
  "add_intent","prove_goal","kill_work","steer_work","add_task_scope","todo_write","dispatch_intents",
  "set_goals","set_constraints","register_user_target",
]);
export async function applyToolBindings<T extends { name: string }>(db: import("../db/index.js").Database, role: string, tools: T[]): Promise<T[]> {
  let rows: Array<Record<string, unknown>> = [];
  try {
    const res = await db.query(`SELECT key, agents, enabled, description FROM tools WHERE kind='builtin'`);
    rows = res.rows as Array<Record<string, unknown>>;
  } catch {
    throw new Error('工具目录不可用');
  }
  const byKey = new Map(rows.map((r) => [String(r["key"]), r]));
  for(const tool of tools) {
    const description=byKey.get(tool.name)?.description;
    if ('description' in tool) Object.assign(tool, {description:effectiveToolDescription(tool.name, String(tool.description ?? ''), description).description});
  }
  return tools.filter((t) => {
    const row = byKey.get(t.name);
    if (!row) return true;
    if (row["enabled"] === false) return false;
    const agents = Array.isArray(row["agents"]) ? (row["agents"] as string[]) : [];
    return agents.includes(role);
  });
}

/** pi 内置工具（bash/read/write/edit）的 DB 开关：返回该角色被禁用的内置名。 */
export async function disabledBuiltinTools(db: import("../db/index.js").Database, role = "worker"): Promise<Set<string>> {
  try {
    const res = await db.query(`SELECT key FROM tools WHERE kind='builtin' AND (enabled=false OR NOT agents @> $1::jsonb)`, [JSON.stringify([role])]);
    return new Set(res.rows.map((r) => String(r["key"])));
  } catch {
    throw new Error('工具目录不可用');
  }
}
