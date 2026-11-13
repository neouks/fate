import {platformPolicy} from '../pi/platform-policy.js';
import {MCP_RESOURCE_TOOLS} from '../pi/platform-mcp.js';
import type { Database } from "../db/index.js";
import type { AgentRunnerOptions } from "../pi/runner.js";
import {realpath, stat} from 'node:fs/promises';
import path from 'node:path';
import {skillFilePath} from './skill-files.js';

export async function skillReadAccess(db: Database, agentID: string | undefined, options: Pick<AgentRunnerOptions, 'cwd' | 'skillsDir' | 'allowedSkills'>, requested: string) {
  if (!options.skillsDir) return;
  const root = path.resolve(options.skillsDir);
  const file = path.resolve(options.cwd, requested);
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return;

  const [skill, ...parts] = relative.split(path.sep);
  try{skillFilePath(root,skill!,parts.join(path.sep));}catch{return 'disabled';}
  if (!agentID) return 'disabled';
  const binding = await db.query('SELECT 1 FROM agent_skill_visibility WHERE agent_id=$1 AND skill_name=$2 AND enabled', [agentID, skill]);
  if (!binding.rowCount) return 'disabled';
  // The exception is for documents in a Skill bound to this session. pi
  // gives the model absolute paths, so keep its shorthand path syntax outside
  // this exception and verify the normal path resolves to a regular file here.
  if (!skill || !options.allowedSkills?.includes(skill) || !parts.length || path.extname(file) !== '.md' ||
      requested !== file || /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/u.test(requested)) return;
  try {
    const [rootPath, filePath] = await Promise.all([realpath(root), realpath(file)]);
    if (filePath === path.join(rootPath, relative) && (await stat(filePath)).isFile()) return 'document';
  } catch {
    // Missing and unreadable files cannot receive the document exception.
  }
}

/** Reload role visibility for every session. The server configuration is the resource authority. */
export async function roleResources(db: Database, role: string, skillsDir?: string): Promise<Pick<AgentRunnerOptions, "skillsDir" | "allowedSkills" | "mcpEntries" | "mcpResourceTools">> {
  const skills = await db.query<{ skill_name: string }>(
    `SELECT v.skill_name FROM agent_skill_visibility v JOIN agents a ON a.id=v.agent_id WHERE a.key=$1 AND v.enabled ORDER BY v.skill_name`, [role]);
  // Only explicitly bound resources are registered; execution guards remain live.
  if (!["worker", "mainagent", "pentest", "auto"].includes(role)) return { skillsDir, allowedSkills: skills.rows.map((r) => r.skill_name) };
  const visibility = await db.query<{ resource_id: string; mcp_tool_name: string; enabled: boolean }>(
    `SELECT v.resource_id,v.mcp_tool_name,v.enabled FROM agent_visibility v JOIN agents a ON a.id=v.agent_id
     WHERE a.key=$1 AND v.resource_kind='mcp' ORDER BY v.resource_id,v.mcp_tool_name`, [role]);
  const servers = await db.platform().listMCP();
  const policy=await platformPolicy(db,role);
  const mcpEntries = servers.filter((server) => server.enabled).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:a.id-b.id).flatMap((server) => {
    const rows = visibility.rows.filter((v) => Number(v.resource_id) === server.id);
    const all = rows.find((v) => !v.mcp_tool_name)?.enabled === true;
    if (!all && !rows.some((v) => v.enabled && v.mcp_tool_name)) return [];
    const config: Record<string, unknown> = {
      transport: server.transport, insecure: server.insecure,
      ...(server.transport === "stdio" ? { command: server.command, args: server.args, env: server.env }
        : { url: server.url, headers: server.env }),
      exposure: all ? policy.mcpLoading : "hidden",
      toolExposure: Object.fromEntries(rows.filter((v) => v.mcp_tool_name).map((v) => [v.mcp_tool_name, v.enabled ? policy.mcpLoading : "hidden"])),
    };
    return [{ name: server.name, config }];
  });
  const bindings=(await db.query('SELECT key,enabled,agents FROM tools WHERE key=ANY($1::text[])',[MCP_RESOURCE_TOOLS])).rows;
  const mcpResourceTools=MCP_RESOURCE_TOOLS.filter(name=>{
    const binding=bindings.find(row=>row.key===name);
    return !binding||(binding.enabled&&Array.isArray(binding.agents)&&binding.agents.includes(role));
  });
  return { skillsDir, allowedSkills: skills.rows.map((r) => r.skill_name), mcpEntries, mcpResourceTools };
}
