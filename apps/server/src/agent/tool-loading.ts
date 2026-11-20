import {nativeToolRejection} from './native-tools.js';
import {readToolLoadingOverrides,type ToolLoadingOverrides} from './tool-loading-preferences.js';
import {applyToolBindings} from './tool-bindings.js';
import { TOOL_POLICY_VERSION,isCoreTool,RETIRED_TOOLS } from './tool-registry.js';
import type {AgentRunnerOptions} from '../pi/runner.js';
import type {Database} from '../db/index.js';
import type {ToolDefinition} from '@earendil-works/pi-coding-agent';

export function compactToolSchema(tool:ToolDefinition):ToolDefinition {
 if(tool.name!=='add_intent')return tool;
 const schema=structuredClone(tool.parameters) as any;
 if(tool.name==='add_intent'){
  const descriptions:Record<string,string>={summary:'必填非空方向与终点',parent_ids:'当前任务已读 fact/finding ID；来源任务用 contract.basis',parent_id:'当前任务单个依据 ID',asset_ids:'资产 ID',priority:'省略/0→5',
   contract:'可选约定及去重',basis:'直接来源任务的证据放这里；使用已读 fact/finding ID 及实际内容版本，不使用回执版本',allowed_tools:'精确执行工具名；不限制写回和已绑定 Skill 文档的读取',intents:'1–4 条，单条也放在数组内；每项必填非空 summary'};
  const visit=(value:any)=>{if(!value||typeof value!=='object')return;for(const [name,property] of Object.entries(value.properties??{}) as [string,any][]){if(descriptions[name])property.description=descriptions[name];visit(property);}if(value.items)visit(value.items);};visit(schema);
 }
 return {...tool,description:tool.name==='add_intent'?tool.description+' 父节点不可用 goal/intent；省略则连接任务根事实。':tool.description,parameters:schema};
}
export interface ToolLoading {
 version:string;initialActive:string[];deferred:string[];compatibility:string[];referencedActive?:string[];fallback?:string;
 /** Retire a discovered platform tool after this many unused model requests. */
 idleToolRequests?:number;
 overrides?:ToolLoadingOverrides;
}

/** Pure loadout shared with preview. Filtering never introduces a tool absent from the bound set. */
export function toolLoadout(role:string,options:Pick<AgentRunnerOptions,'customTools'|'toolAllowlist'>,settings:{direct?:boolean;forceDirect?:boolean;overrides?:ToolLoadingOverrides;legacy?:boolean;referenced?:string[];custom?:string[];fallback?:string}={}) {
 const allowed=[...new Set(options.toolAllowlist??[])].filter(n=>!nativeToolRejection(role,n)&&!RETIRED_TOOLS.has(n));
 const compatibility:string[]=[];
 const names=allowed;
 const customTools=(options.customTools??[]).filter(t=>names.includes(t.name)).map(compactToolSchema);
 // A mention in a prompt/Skill is not a request to declare its full schema.
 // Keep configured resident tools available; PI discovers all other tools.
 const deferred=settings.forceDirect?[]:names.filter(n=>{
  if(n==='tool_search'||n.includes('*')||n.startsWith('mcp__')||compatibility.includes(n))return false;
  const override=settings.overrides?.[n];
  return override?override==='deferred':!settings.direct&&!isCoreTool(role,n);
 });
 const initialActive=names.filter(n=>!deferred.includes(n));
 const policy:ToolLoading={version:TOOL_POLICY_VERSION,initialActive,deferred,compatibility,referencedActive:initialActive.filter(n=>settings.referenced?.includes(n)),...(deferred.length?{idleToolRequests:2}:{}),...(settings.fallback?{fallback:settings.fallback}:{}),...(settings.overrides?{overrides:settings.overrides}:{})};
 return {customTools:customTools.map(t=>({...t,...(deferred.includes(t.name)?{exposure:'deferred' as const}:t.exposure==='deferred'?{exposure:'direct' as const}: {})})),toolAllowlist:names,toolLoading:policy};
}
type ToolLoadingOptions=Pick<AgentRunnerOptions,'customTools'|'toolAllowlist'|'systemPrompt'|'taskContext'|'resumeSessionPath'|'skillsDir'|'allowedSkills'>;
export async function prepareToolLoading(db:Database,role:string,options:ToolLoadingOptions,direct:boolean,fallback?:string){
 const allowed=await applyToolBindings(db,role,(options.toolAllowlist??[]).map(name=>({name})));
 const overrides=await readToolLoadingOverrides(db,role);
 const search=Object.keys(overrides).length?(await db.query('SELECT enabled,agents FROM tools WHERE key=$1',['tool_search'])).rows[0]:undefined;
 const forceDirect=!!search&&(search.enabled===false||!Array.isArray(search.agents)||!search.agents.includes(role));
 return toolLoadout(role,{...options,toolAllowlist:allowed.map(t=>t.name)},{direct,forceDirect,overrides,fallback});
}
