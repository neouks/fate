import type {Database} from '../db/index.js';

export type ToolLoadingMode = 'resident' | 'deferred';
export type ToolLoadingOverrides = Record<string, ToolLoadingMode>;
export const toolLoadingSettingKey = (role:string) => `agent_tool_loading_v1:${role}`;

export function parseToolLoadingOverrides(value:unknown):ToolLoadingOverrides {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length>256)
    throw new Error('overrides 必须是最多 256 个工具的加载配置');
  const entries=Object.entries(value);
  for(const [name,mode] of entries) {
    if(!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,127}$/.test(name) || ['__proto__','prototype','constructor'].includes(name))
      throw new Error('工具名称非法');
    if(mode!=='resident' && mode!=='deferred')throw new Error(`${name} 的加载方式仅支持 resident 或 deferred`);
  }
  return Object.fromEntries(entries) as ToolLoadingOverrides;
}

export async function readToolLoadingOverrides(db:Database,role:string):Promise<ToolLoadingOverrides> {
  const row=(await db.query('SELECT value FROM settings WHERE key=$1',[toolLoadingSettingKey(role)])).rows[0];
  if(row?.value==null || row.value==='')return {};
  return parseToolLoadingOverrides(JSON.parse(String(row.value)));
}
