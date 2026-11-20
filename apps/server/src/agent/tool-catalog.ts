import {roleToolRejection} from './planner-capabilities.js';
import {nativeToolNames,nativeToolDefinitions,nativeToolRejection} from './native-tools.js';
import {trafficSearchTool} from '../tools/traffic-search.js';
import {GOALS_STAGE_TOOLS,GOALS_STAGE_PROTOCOL} from './goals-policy.js';
import {legacyReadCandidates} from '../tools/legacy-reads.js';
import {effectiveToolDescription} from './tool-descriptions.js';
import {type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {workerTools,plannerTools,mainTools,goalsTools} from '../tools/index.js';
import {runContext} from '../tools/context.js';
import {contextSearchTool,contextGetTool} from '../tools/context-read.js';
import {readAttachmentTool,trafficBodyTool} from '../tools/evidence.js';
import {toolOutputTool} from '../tools/output.js';
import {listAssetsTool,assetGetTool} from '../tools/assets.js';
import {mergedAssetSearchTool} from '../tools/asset-search-compat.js';
import {recordFactTool,nodeDetailTool,searchWorkerTracesTool,getWorkerTraceTool} from '../tools/graph.js';
import {graphIndexTool,expandDigestTool} from '../tools/graph_read.js';
import {listFindingsTool,reportFindingTool} from '../tools/findings.js';
import {graphOverviewTool} from '../tools/overview.js';
import {httpRequestTool} from '../tools/evidence.js';
import {conversationDomainTools} from '../tools/conversations.js';
import {terminalToolDefinitions} from '../pi/terminal.js';
import {customWorkerTools} from '../tools/custom.js';
import {applyToolBindings,disabledBuiltinTools} from './tool-bindings.js';
import {toolIdentity,ACTIVE_ROLES} from './tool-registry.js';
import {prepareToolLoading} from './tool-loading.js';
import {platformPolicy} from '../pi/platform-policy.js';
import {hasDeferredMcp,toolSearchDefinition} from '../pi/platform-mcp.js';
import {resolveRolePrompt} from './prompts.js';
import {PLANNER_READING_RULES} from './planner-memory.js';
import {roleResources} from './resources.js';
import {skillDir} from '../config/index.js';
import type {Database} from '../db/index.js';
const previewCwd='/tmp/fate-tool-preview';
const native=()=>nativeToolDefinitions(previewCwd);
export const searchDefinition=toolSearchDefinition;
/** Constructors only: no model, MCP connection, terminal process, or domain action. */
export function roleDefinitions(db:Database,role:string,taskBound=true):ToolDefinition[]{
 const ctx=runContext(db,taskBound?1:0,taskBound?1:0,role as never);
 const factory={worker:workerTools,planner:plannerTools,mainagent:mainTools,goals:goalsTools}[role];
 if(factory)return factory(ctx);
 const tools:ToolDefinition[]=[contextGetTool(ctx),readAttachmentTool(ctx),toolOutputTool(ctx),...conversationDomainTools(ctx,{} as never)];
 if(taskBound)tools.push(trafficSearchTool(ctx),contextSearchTool(ctx),mergedAssetSearchTool(ctx),assetGetTool(ctx),listAssetsTool(ctx),listFindingsTool(ctx),nodeDetailTool(ctx),graphOverviewTool(ctx),trafficBodyTool(ctx));
 if(role==='pentest'&&taskBound)tools.push({...recordFactTool(ctx),name:'record_conversation_fact'},{...reportFindingTool(ctx),name:'report_conversation_finding'},httpRequestTool(ctx));
 return tools;
}
export function builtinDefinitions(db:Database){
 const ctx=runContext(db,1,1,'worker');
 const all=[...ACTIVE_ROLES.flatMap(role=>roleDefinitions(db,role)),...native(),...terminalToolDefinitions(),searchDefinition(),
  searchWorkerTracesTool(ctx),getWorkerTraceTool(ctx),graphIndexTool(ctx),graphIndexTool(ctx,'list_facts'),expandDigestTool(ctx)];
 return new Map(all.map(t=>[t.name,t]));
}
export async function previewRoleTools(db:Database,role:string,taskBound=true){
 const agent=await db.platform().getAgentByKey(role);if(!agent)throw Object.assign(new Error('Agent 不存在'),{statusCode:404});
 const ctx=runContext(db,taskBound?1:0,taskBound?1:0,role as never);
 // Preview the current combined Goals phase; legacy Goals sessions may explicitly read files.
 const nativeNames=role==='goals'?[]:nativeToolNames(role,taskBound);
 const disabled=await disabledBuiltinTools(db,role);
 const domain=await applyToolBindings(db,role,role==='goals'?goalsTools({...ctx,goalsPhase:'combined'}).filter(t=>[...GOALS_STAGE_TOOLS.constraints,...GOALS_STAGE_TOOLS.objectives].includes(t.name as never)):roleDefinitions(db,role,taskBound));
 const custom=role==='planner'||role==='goals'||role==='pentest'&&!taskBound?[]:await customWorkerTools(ctx,previewCwd);
 const candidate=[...domain,...native().filter(t=>nativeNames.includes(t.name)&&!disabled.has(t.name)),...(agent.interactiveShell&&(['worker','mainagent'].includes(role)||role==='pentest'&&taskBound)?terminalToolDefinitions():[]),...custom];
 const permitted=new Set((await applyToolBindings(db,role,candidate.map(t=>({name:t.name})))).map(t=>t.name));
 const bound=candidate.filter(t=>permitted.has(t.name)),policy=await platformPolicy(db,role),prompt=await resolveRolePrompt(db,role),resources=role==='goals'?{}:await roleResources(db,role,skillDir());
 const loadout=await prepareToolLoading(db,role,{customTools:bound,legacyTools:taskBound&&role!=='goals'?legacyReadCandidates(ctx):[],toolAllowlist:bound.map(t=>t.name),systemPrompt:prompt.template+(role==='planner'?'\n'+PLANNER_READING_RULES:''),...resources},policy.builtinLoading==='direct',policy.fallback);
 const definitions=new Map(loadout.customTools.map(t=>[t.name,t]));
 const initial=loadout.toolLoading.initialActive.map(n=>definitions.get(n)!).filter(Boolean);
 if(loadout.toolLoading.deferred.length||hasDeferredMcp(resources)){const search=searchDefinition();definitions.set(search.name,search);initial.push(search);}
 const measure=(tools:ToolDefinition[])=>Buffer.byteLength(JSON.stringify(tools.map(t=>({name:t.name,description:t.description,parameters:t.parameters}))));
 return {role,enabled:agent.enabled!==false,interactive_shell:agent.interactiveShell===true,context_activation:{policy:'explicit-references-v1',task_context:'runtime_only'},stages:role==='goals'?Object.entries(GOALS_STAGE_TOOLS).filter(([phase])=>phase==='combined').map(([phase,names])=>({phase,resident:initial.filter(t=>(names as readonly string[]).includes(t.name)).map(t=>t.name),deferred:[],schema_bytes:measure(initial.filter(t=>(names as readonly string[]).includes(t.name))),protocol:GOALS_STAGE_PROTOCOL[phase as keyof typeof GOALS_STAGE_PROTOCOL],context:'同一会话读取目标与描述；仅约束、资产登记及目标保存，无文件、Skill、MCP' })):undefined,scope:taskBound?'task_bound':'standalone',policy_version:loadout.toolLoading.version,platform_policy:policy,
  resident:initial.map(t=>t.name),deferred:loadout.toolLoading.deferred,compatibility:loadout.toolLoading.compatibility,fallback:loadout.toolLoading.fallback,
  schema_bytes:{before:measure(bound),resident:measure(initial),registered:measure([...definitions.values()])},
  mcp:{status:'not_connected',servers:resources.mcpEntries?.map(e=>e.name)??[],schema_counted:false},
  descriptions:Object.fromEntries([...definitions.values()].map(t=>[t.name,t.description])),
  schemas:Object.fromEntries([...definitions.values()].map(t=>[t.name,t.parameters]))};
}
/** A shared schema is valid only when every loaded role agrees. */
export function catalogSchema(name:string,roles:Array<{schemas:Record<string,unknown>}>,stored:unknown={}){
 const schemas=roles.map(r=>r.schemas[name]).filter(s=>s!==undefined);
 if(!schemas.length)return {schema:stored??{},schema_source:'unavailable'};
 const shared=schemas.every(s=>JSON.stringify(s)===JSON.stringify(schemas[0]));
 return {schema:shared?schemas[0]:{},schema_source:shared?'role':'role_specific'};
}
export function effectiveToolState(row:{key:string;kind?:string;enabled?:boolean;agents?:unknown}, role:{role:string;enabled?:boolean;interactive_shell?:boolean;scope:string;resident:string[];deferred:string[]}) {
 const configured_bound=Array.isArray(row.agents)&&row.agents.includes(role.role);
 const unavailable=(reason:string)=>({configured_bound,status:'unavailable' as const,reason});
 if(row.enabled===false)return unavailable('工具已禁用');
 if(!configured_bound)return unavailable('未绑定此角色');
 if(role.enabled===false)return unavailable('角色已禁用');
 if(roleToolRejection(role.role,row.key))return unavailable('Planner 角色权限不允许此工具');
 const rejection=nativeToolRejection(role.role,row.key,role.scope==='task_bound');
 if(rejection)return unavailable(rejection);
 const identity=toolIdentity(row.key,row.kind);
 if(['retired','unsupported'].includes(identity.implementation_status))return unavailable('工具已退役或尚未接入');
 if(row.key.startsWith('shell_')&&!role.interactive_shell)return unavailable('交互终端未启用');
 if(role.resident.includes(row.key))return {configured_bound,status:'resident' as const};
 if(role.deferred.includes(row.key))return {configured_bound,status:'deferred' as const};
 if(identity.implementation_status==='compatibility')return unavailable('仅在旧会话或兼容引用需要时加载');
 if(row.key==='tool_search')return unavailable('当前配置没有需要搜索加载的工具');
 return unavailable('当前角色、会话范围或功能配置未装配此工具');
}
export async function catalogTools(db:Database){
 const definitions=builtinDefinitions(db),rows=(await db.query('SELECT * FROM tools ORDER BY key')).rows;
 const roles:Awaited<ReturnType<typeof previewRoleTools>>[]=[];for(const role of ACTIVE_ROLES)roles.push(await previewRoleTools(db,role));
 return {roles,tools:rows.map(row=>{
  const identity=toolIdentity(String(row.key),String(row.kind)),definition=definitions.get(String(row.key));
  const effective=Object.fromEntries(roles.map(role=>[role.role,effectiveToolState({...row,key:String(row.key),kind:String(row.kind)},role)]));
  const description=row.kind==='builtin'&&definition?effectiveToolDescription(String(row.key),definition.description,row.description):{description:row.description,source:'configuration'};
  return {...row,...identity,description:description.description,description_source:description.source,
   ...(row.kind==='builtin'?catalogSchema(String(row.key),roles,row.schema):{schema:row.schema??{},schema_source:'configuration'}),
   schema_read_only:row.kind==='builtin',agents:row.agents??[],effective,loading:Object.fromEntries(Object.entries(effective).filter(([,state])=>state.status!=='unavailable').map(([role,state])=>[role,state.status]))};
 })};
}
