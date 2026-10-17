import type { Database } from "../db/index.js";
import type { AgentRunnerOptions } from "../pi/runner.js";

/** Reload role visibility for every session. The server configuration is the resource authority. */
export async function roleResources(db: Database, role: string, skillsDir?: string): Promise<Pick<AgentRunnerOptions, "skillsDir" | "allowedSkills" | "mcpEntries">> {
  const skills = await db.query<{ skill_name: string }>(
    `SELECT v.skill_name FROM agent_skill_visibility v JOIN agents a ON a.id=v.agent_id WHERE a.key=$1 AND v.enabled`, [role]);
  // Main/planner/goals are orchestration roles. Executable external tools belong to workers.
  if (role !== "worker") return { skillsDir, allowedSkills: skills.rows.map((r) => r.skill_name) };
  const visibility = await db.query<{ resource_id: string; mcp_tool_name: string; enabled: boolean }>(
    `SELECT v.resource_id,v.mcp_tool_name,v.enabled FROM agent_visibility v JOIN agents a ON a.id=v.agent_id
     WHERE a.key=$1 AND v.resource_kind='mcp'`, [role]);
  const servers = await db.platform().listMCP();
  const mcpEntries = servers.filter((server) => server.enabled).flatMap((server) => {
    const rows = visibility.rows.filter((v) => Number(v.resource_id) === server.id);
    const all = rows.find((v) => !v.mcp_tool_name)?.enabled === true;
    if (!all && !rows.some((v) => v.enabled && v.mcp_tool_name)) return [];
    const config: Record<string, unknown> = {
      ...(server.transport === "stdio" ? { command: server.command, args: server.args, env: server.env }
        : { url: server.url, headers: server.env }),
      exposure: all ? "direct" : "hidden",
      toolExposure: Object.fromEntries(rows.filter((v) => v.mcp_tool_name).map((v) => [v.mcp_tool_name, v.enabled ? "direct" : "hidden"])),
    };
    return [{ name: server.name, config }];
  });
  return { skillsDir, allowedSkills: skills.rows.map((r) => r.skill_name), mcpEntries };
}
