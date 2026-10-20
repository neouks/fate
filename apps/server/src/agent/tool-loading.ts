import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {applyToolBindings} from './tool-bindings.js';
import {TOOL_POLICY_VERSION,TOOL_ALIASES,isCoreTool,toolIdentity,RETIRED_TOOLS} from './tool-registry.js';
import type {AgentRunnerOptions} from '../pi/runner.js';
import type {Database} from '../db/index.js';
import type {ToolDefinition} from '@earendil-works/pi-coding-agent';

export function compactToolSchema(tool:ToolDefinition):ToolDefinition {
 if(tool.name!=='insert_assets')return tool;
 const schema=structuredClone(tool.parameters) as any;
 if(!schema.properties?.assets)return tool;
 delete schema.properties.items;delete schema.anyOf;schema.required=['assets'];
 return {...tool,parameters:schema};
}
export interface ToolLoading {
 version:string;initialActive:string[];deferred:string[];compatibility:string[];fallback?:string;
}
/** Pure loadout shared with preview. Filtering never introduces a tool absent from the bound set. */
export function toolLoadout(role:string,options:Pick<AgentRunnerOptions,'customTools'|'toolAllowlist'>,settings:{direct?:boolean;legacy?:boolean;referenced?:string[];custom?:string[];fallback?:string}={}) {
 const allowed=(options.toolAllowlist??[]).filter(n=>!RETIRED_TOOLS.has(n));
 const compatibility=allowed.filter(n=>TOOL_ALIASES[n]&&(settings.legacy||settings.referenced?.includes(n)||!allowed.includes(TOOL_ALIASES[n]!)));
 const names=allowed.filter(n=>!TOOL_ALIASES[n]||compatibility.includes(n));
 const customTools=(options.customTools??[]).filter(t=>names.includes(t.name)).map(t=>settings.legacy?t:compactToolSchema(t));
 const deferred=settings.direct?[]:names.filter(n=>!n.includes('*')&&!n.startsWith('mcp__')&&!isCoreTool(role,n)&&!compatibility.includes(n)&&!settings.custom?.includes(n));
 const initialActive=names.filter(n=>!deferred.includes(n));
 const policy:ToolLoading={version:TOOL_POLICY_VERSION,initialActive,deferred,compatibility,...(settings.fallback?{fallback:settings.fallback}:{})};
 return {customTools:customTools.map(t=>({...t,...(deferred.includes(t.name)?{exposure:'deferred' as const}: {})})),toolAllowlist:names,toolLoading:policy};
}
export async function prepareToolLoading(db:Database,role:string,options:AgentRunnerOptions,direct:boolean,fallback?:string){
 let legacy=false;
 if(options.resumeSessionPath){try{const lines=(await readFile(options.resumeSessionPath,'utf8')).split('\n').filter(Boolean).map(l=>JSON.parse(l));legacy=lines.some(e=>e.type==='message')&&!lines.some(e=>e.type==='custom'&&e.customType===TOOL_POLICY_VERSION);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 // Scan only explicitly bound Skills for compatibility; no Skill content is injected into the model.
 const sources=[options.systemPrompt??''];
 if(options.skillsDir)for(const skill of options.allowedSkills??[]){
  if(skill.includes('/')||skill.includes('\\')||skill==='..')continue;
  try{sources.push(await readFile(path.join(options.skillsDir,skill,'SKILL.md'),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 }
 const referenced=Object.keys(TOOL_ALIASES).filter(name=>sources.some(text=>new RegExp(`\\b${name}\\b`).test(text)));
 const custom=(await db.query("SELECT key FROM tools WHERE kind<>'builtin' AND enabled AND agents ? $1",[role])).rows.map(r=>String(r.key));
 const allowed=await applyToolBindings(db,role,(options.toolAllowlist??[]).map(name=>({name})));
 return toolLoadout(role,{...options,toolAllowlist:allowed.map(t=>t.name)},{direct,legacy,referenced,custom,fallback:legacy?'旧会话保留兼容工具名称和参数':fallback});
}
