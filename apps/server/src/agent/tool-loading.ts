import {roleAllowsTool} from './planner-capabilities.js';
import {skillFilePath} from './skill-files.js';
import {readFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {applyToolBindings} from './tool-bindings.js';
import {TOOL_POLICY_VERSION,TOOL_ALIASES,isCoreTool,toolIdentity,RETIRED_TOOLS} from './tool-registry.js';
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
}

/** Compatibility is a marker lookup, not another full in-memory JSONL load.
 * Stop as soon as the installed policy is found; PI still owns session parsing. */
export async function legacyToolSession(file:string):Promise<boolean>{
 const input=createReadStream(file,{encoding:'utf8'}),lines=createInterface({input,crlfDelay:Infinity});
 let messages=false;
 try{
  for await(const line of lines){
   if(!line.trim())continue;
   const entry=JSON.parse(line);
   if(entry.type==='custom'&&entry.customType===TOOL_POLICY_VERSION)return false;
   if(entry.type==='message')messages=true;
  }
  return messages;
 }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
 finally{lines.close();input.destroy();}
}
/** Pure loadout shared with preview. Filtering never introduces a tool absent from the bound set. */
export function toolLoadout(role:string,options:Pick<AgentRunnerOptions,'customTools'|'toolAllowlist'>,settings:{direct?:boolean;legacy?:boolean;referenced?:string[];custom?:string[];fallback?:string}={}) {
 const allowed=[...new Set(options.toolAllowlist??[])].filter(n=>roleAllowsTool(role,n)&&!RETIRED_TOOLS.has(n));
 const compatibility=allowed.filter(n=>TOOL_ALIASES[n]&&(settings.legacy||settings.referenced?.includes(n)||!allowed.includes(TOOL_ALIASES[n]!)));
 const names=allowed.filter(n=>!TOOL_ALIASES[n]||compatibility.includes(n));
 const customTools=(options.customTools??[]).filter(t=>names.includes(t.name)).map(compactToolSchema);
 // A mention in a prompt/Skill is not a request to declare its full schema.
 // Keep native tools and legacy aliases available; PI discovers domain/custom tools.
 const deferred=settings.direct?[]:names.filter(n=>!n.includes('*')&&!n.startsWith('mcp__')&&!isCoreTool(role,n)&&!compatibility.includes(n));
 const initialActive=names.filter(n=>!deferred.includes(n));
 const policy:ToolLoading={version:TOOL_POLICY_VERSION,initialActive,deferred,compatibility,referencedActive:initialActive.filter(n=>settings.referenced?.includes(n)),...(!settings.direct&&deferred.length?{idleToolRequests:2}:{}),...(settings.fallback?{fallback:settings.fallback}:{})};
 return {customTools:customTools.map(t=>({...t,...(deferred.includes(t.name)?{exposure:'deferred' as const}: {})})),toolAllowlist:names,toolLoading:policy};
}
type ToolLoadingOptions=Pick<AgentRunnerOptions,'customTools'|'toolAllowlist'|'legacyTools'|'systemPrompt'|'taskContext'|'resumeSessionPath'|'skillsDir'|'allowedSkills'>;
export async function prepareToolLoading(db:Database,role:string,options:ToolLoadingOptions,direct:boolean,fallback?:string){
 let legacy=false;
 if(options.resumeSessionPath)legacy=await legacyToolSession(options.resumeSessionPath);
 // Scan only explicitly bound Skills for compatibility; no Skill content is injected into the model.
 const sources=[options.systemPrompt??'',options.taskContext??''];
 if(options.skillsDir)for(const skill of options.allowedSkills??[]){
  if(skill.includes('/')||skill.includes('\\')||skill==='..')continue;
  try{sources.push(await readFile(skillFilePath(options.skillsDir,skill,'SKILL.md'),'utf8'));}catch{/* Invalid/missing Skill is diagnosed by the native loader; don't break all role tools. */}
 }
 // Only historical aliases need compatibility registration. Canonical names
 // mentioned by role/Skill instructions remain searchable through native PI.
 const candidates=Object.keys(TOOL_ALIASES);
 const referenced=candidates.filter(name=>sources.some(text=>new RegExp(`\\b${name}\\b`).test(text)));
 // Absent catalog rows are not permission to restore historical capabilities.
 const bindings=(await db.query("SELECT key FROM tools WHERE kind='builtin' AND enabled AND agents ? $1",[role])).rows.map(r=>String(r.key));
 const extra=(await applyToolBindings(db,role,options.legacyTools??[])).filter(t=>
  bindings.includes(t.name)&&(legacy||referenced.includes(t.name))&&!(options.toolAllowlist??[]).includes(t.name));
 options={...options,customTools:[...options.customTools??[],...extra],toolAllowlist:[...options.toolAllowlist??[],...extra.map(t=>t.name)]};
 const allowed=await applyToolBindings(db,role,(options.toolAllowlist??[]).map(name=>({name})));
 return toolLoadout(role,{...options,toolAllowlist:allowed.map(t=>t.name)},{direct,legacy,referenced,fallback:legacy?'旧会话保留兼容工具名称':fallback});
}
