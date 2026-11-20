import {nativeToolRejection} from '../agent/native-tools.js';
import {assertActiveRole} from '../agent/retired-roles.js';
import type { Database } from '../db/index.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const PLATFORM_POLICY_VERSION = 'domain-v1';
export const PLATFORM_ROLES = ['goals','planner','mainagent','worker','auto','pentest','reporter'] as const;
export interface PlatformPolicy {
  version: typeof PLATFORM_POLICY_VERSION;
  compaction: 'native';
  mcpLoading: 'deferred' | 'direct';
  builtinLoading?: 'deferred' | 'direct';
  toolPolicyVersion?: string;
  fallback?: string;
}

/** Settings are read once per new runner, never mutate an active SDK session. */
export async function platformPolicy(db: Database, role: string): Promise<PlatformPolicy> {
  assertActiveRole(role);
  const [compression, loading, search, builtin] = await Promise.all([
    db.platform().getSetting('pi_context_policy'), db.platform().getSetting('pi_mcp_loading'),
    db.query('SELECT enabled,agents FROM tools WHERE key=$1',['tool_search']),db.platform().getSetting('pi_builtin_loading'),
  ]);
  if (compression && !['domain','native'].includes(compression)) throw new Error('无效 pi_context_policy');
  if (loading && !['deferred','direct'].includes(loading)) throw new Error('无效 pi_mcp_loading');
  if(builtin&&!['direct','deferred'].includes(builtin))throw new Error('无效 pi_builtin_loading');
  const binding = search.rows[0];
  const disabled = binding && (!binding.enabled || !Array.isArray(binding.agents) || !binding.agents.includes(role));
  // Historical domain settings remain readable, but new sessions always use
  // PI's native compactor, cut points, file tracking and summary format.
  return {version:PLATFORM_POLICY_VERSION, compaction:'native',
    toolPolicyVersion:'lean-tools-v1',builtinLoading:disabled||builtin==='direct'?'direct':'deferred',
    mcpLoading: disabled || loading === 'direct' ? 'direct':'deferred',
    ...(disabled ? {fallback:'tool_search 已禁用或未绑定，使用直接装配'}:{})};
}

export function validatePlatformRunner(role: string, options: {systemPrompt?:string;toolAllowlist?:string[];cwd:string}, taskID:number) {
  assertActiveRole(role);
  if (!PLATFORM_ROLES.includes(role as typeof PLATFORM_ROLES[number])) return;
  if (!options.systemPrompt?.trim()) throw new Error(`${role} 必须显式提供角色提示词`);
  if (!Array.isArray(options.toolAllowlist)) throw new Error(`${role} 必须显式提供工具集合`);
  const serverRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  if([serverRoot,path.resolve(serverRoot,'../..')].includes(path.resolve(options.cwd)))
    throw new Error(`${role} 必须使用任务或会话目录，不能使用平台源码根目录`);
  for(const name of options.toolAllowlist){const rejection=nativeToolRejection(role,name,taskID>0);if(rejection)throw new Error(rejection);}
}
