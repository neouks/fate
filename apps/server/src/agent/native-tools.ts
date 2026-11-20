import {
  createReadToolDefinition, createBashToolDefinition, createWriteToolDefinition,
  createEditToolDefinition, createGrepToolDefinition, createFindToolDefinition,
  createLsToolDefinition, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

// The SDK does not re-export its inventory. Read the installed SDK inventory,
// rather than maintaining an exclusion list that misses newly added tools.
const sdk = await import(new URL('./core/tools/index.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href) as {allToolNames: Set<string>};
export const SDK_NATIVE_TOOLS: readonly string[] = [...sdk.allToolNames];
const executionRoles = ['worker', 'mainagent', 'pentest'];
export const NATIVE_TOOL_CATALOG = [
  {name:'read', resident:true, roles:['planner', ...executionRoles, 'auto', 'reporter', 'goals'], create:createReadToolDefinition},
  {name:'bash', resident:true, roles:executionRoles, create:createBashToolDefinition},
  {name:'write', resident:true, roles:executionRoles, create:createWriteToolDefinition},
  {name:'edit', resident:true, roles:executionRoles, create:createEditToolDefinition},
  {name:'grep', resident:false, roles:executionRoles, create:createGrepToolDefinition},
  {name:'find', resident:false, roles:executionRoles, create:createFindToolDefinition},
  {name:'ls', resident:false, roles:executionRoles, create:createLsToolDefinition},
];
export const NATIVE_TOOLS = NATIVE_TOOL_CATALOG.map(t=>t.name);
export const RESIDENT_NATIVE_TOOLS = NATIVE_TOOL_CATALOG.filter(t=>t.resident).map(t=>t.name);
export function nativeToolNames(role:string, taskBound=true):string[] {
  return NATIVE_TOOL_CATALOG.filter(t=>t.roles.includes(role)&&(role!=='pentest'||taskBound||t.name==='read')).map(t=>t.name);
}
export function nativeToolDefinitions(cwd:string):ToolDefinition[] {
  return NATIVE_TOOL_CATALOG.map(t=>t.create(cwd) as ToolDefinition);
}
export function nativeToolRejection(role:string|undefined,name:string,taskBound=true):string|undefined {
  if(!SDK_NATIVE_TOOLS.includes(name))return;
  if(!NATIVE_TOOLS.includes(name))return `原生工具 ${name} 尚未接入平台，不能注册或调用`;
  if(role&&!nativeToolNames(role,taskBound).includes(name))return `当前角色或会话范围不提供 ${name}`;
}
