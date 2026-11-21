import type {Database} from './index.js';
import type {AgentRunnerOptions} from '../pi/runner.js';
import {profilePolicy,type ProfilePolicyInput} from '../pi/profile-policy.js';
import {OPENAI_MODELS} from '@earendil-works/pi-ai/providers/openai.models';
import {ANTHROPIC_MODELS} from '@earendil-works/pi-ai/providers/anthropic.models';
import {clampThinkingLevel} from '@earendil-works/pi-ai/models';

export const THINKING_LEVELS=['auto','off','minimal','low','medium','high','xhigh'] as const;
export const TOOL_PRESETS=['configured','none','read-only','default','full'] as const;
export type SessionPreferences={thinking_level:typeof THINKING_LEVELS[number];tool_preset:typeof TOOL_PRESETS[number]};
export type PreferenceScope={taskID?:number;conversationID?:number;sessionKey?:string};
export const DEFAULT_SESSION_PREFERENCES:SessionPreferences={thinking_level:'auto',tool_preset:'configured'};
export function preferencePatch(value:unknown):Partial<SessionPreferences>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Object.assign(new Error('会话配置无效'),{statusCode:400});
 const v=value as Record<string,unknown>,out:Partial<SessionPreferences>={};
 for(const [key,values] of [['thinking_level',THINKING_LEVELS],['tool_preset',TOOL_PRESETS]] as const){
  if(v[key]===undefined)continue;
  if(!(values as readonly unknown[]).includes(v[key]))throw Object.assign(new Error(`无效的 ${key}`),{statusCode:400});
  (out as Record<string,unknown>)[key]=v[key];
 }
 if(!Object.keys(out).length)throw Object.assign(new Error('没有可保存的会话配置'),{statusCode:400});
 return out;
}
export async function readSessionPreferences(db:Database,scope:PreferenceScope):Promise<SessionPreferences>{
 const row=scope.conversationID
  ?(await db.query('SELECT thinking_level,tool_preset FROM conversations WHERE id=$1',[scope.conversationID])).rows[0]
  :scope.taskID&&scope.sessionKey?(await db.query('SELECT thinking_level,tool_preset FROM task_session_preferences WHERE task_id=$1 AND session_key=$2',[scope.taskID,scope.sessionKey])).rows[0]:undefined;
 return {...DEFAULT_SESSION_PREFERENCES,...row};
}
export async function saveSessionPreferences(db:Database,scope:PreferenceScope,patch:Partial<SessionPreferences>){
 if(scope.conversationID)await db.query('UPDATE conversations SET thinking_level=COALESCE($2,thinking_level),tool_preset=COALESCE($3,tool_preset) WHERE id=$1',[scope.conversationID,patch.thinking_level??null,patch.tool_preset??null]);
 else await db.query(`INSERT INTO task_session_preferences(task_id,session_key,thinking_level,tool_preset) VALUES($1,$2,COALESCE($3,'auto'),COALESCE($4,'configured'))
  ON CONFLICT(task_id,session_key) DO UPDATE SET thinking_level=COALESCE($3,task_session_preferences.thinking_level),tool_preset=COALESCE($4,task_session_preferences.tool_preset)`,[scope.taskID,scope.sessionKey,patch.thinking_level??null,patch.tool_preset??null]);
 return readSessionPreferences(db,scope);
}
export function sessionProfile<T extends ProfilePolicyInput>(profile:T,preference:SessionPreferences):T{
 const level=preference.thinking_level;
 if(level==='auto')return profile;
 const catalog=(profile.format==='anthropic'?ANTHROPIC_MODELS:OPENAI_MODELS) as Record<string,Parameters<typeof clampThinkingLevel>[0]>;
 const known=catalog[profile.model];
 const resolved=known?clampThinkingLevel(known,level):level;
 const effort=profilePolicy(profile).deepseek&&resolved==='xhigh'?'max':resolved;
 return {...profile,thinkingType:resolved==='off'?'disabled':'enabled',reasoningEffort:effort};
}
export function thinkingOptions(profile:ProfilePolicyInput){
 return THINKING_LEVELS.map(value=>{
  const policy=profilePolicy(sessionProfile(profile,{...DEFAULT_SESSION_PREFERENCES,thinking_level:value}));
  const mapped=value==='auto'?'auto':value==='off'?'off':policy.deepseek?policy.effort:policy.level;
  return {value,label:mapped,original:mapped!==value?value:null};
 }).filter(o=>o.value==='auto'||o.value==='off'||o.label!=='off');
}
const presetTools={none:[], 'read-only':['read','grep','find','ls'],default:['read','bash','edit','write'],full:['read','bash','edit','write','grep','find','ls']} as const;
/** Explicit presets narrow the role's existing permissions, never grant tools. */
export function applySessionTools(options:AgentRunnerOptions,preset:SessionPreferences['tool_preset']):AgentRunnerOptions{
 if(preset==='configured')return options;
 const names=new Set<string>(presetTools[preset]);
 return {...options,toolAllowlist:(options.toolAllowlist??[]).filter(n=>names.has(n)),customTools:options.customTools?.filter(t=>names.has(t.name)),
  mcpEntries:[],allowedSkills:[],extensionFactories:[],settlementTools:[],wrapup:undefined};
}
