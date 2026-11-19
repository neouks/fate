import type {Activity} from './types';
export type AuditType='correction'|'control'|'important_fact'|'system';
export type AuditFilter=AuditType|'all';
export interface AuditEvent {type:AuditType;source:string;status:string;title:string;intent_id?:string;fact_id?:string;source_session?:string;reason?:string;}
export const auditFilters:Record<AuditFilter,string>={all:'全部',correction:'纠偏',control:'执行控制',important_fact:'重要事实',system:'模型与系统'};
export const auditKey=(filter:AuditFilter)=>filter==='all'?'system':`system:${filter}`;
export function auditHistoryQuery(key:string){return key.startsWith('system:')?{session:'system',auditType:key.slice(7)}:{session:key,auditType:undefined};}
/** Multicast one durable row; never move it out of its original transcript. */
export function auditSessionKeys(activity:Activity,originalKey:string):string[]{
 const event=activity.audit_event;
 if(!event)return originalKey==='system'?[]:[originalKey];
 return [...new Set([originalKey,'system',auditKey(event.type)])];
}
export function auditSource(source:string){return ({user:'人工',planner:'Planner',main:'主 Agent',mainagent:'主 Agent',worker:'Worker',system:'系统',pentest:'Pentest'} as Record<string,string>)[source]||'来源未记录';}
export function auditStatus(status:string){return ({submitted:'已提交',queued:'已提交',handled:'由 PI 扩展处理',delivered:'已有送达记录',stop_requested:'停止请求已提交',stopped:'已停止',paused:'已暂停',open:'已暂停',resume_requested:'恢复请求已提交',resume_started:'已恢复执行',saved:'已保存',recorded:'已记录',unknown:'状态未记录'} as Record<string,string>)[status]||'状态未记录';}
export function auditSourceHref(taskId:string,step:Activity){
 const a=step.audit_event;if(!a)return;
 const q=new URLSearchParams({id:taskId});
 if(a.fact_id){q.set('tab','graph');q.set('explore','graph');q.set('node',a.fact_id);}
 else {const session=a.source_session||(a.intent_id?`intent:${a.intent_id}`:undefined);if(!session)return;q.set('tab','sessions');q.set('section','chat');q.set('session',session);q.set('activity',String(step.seq));}
 return `/function/tasks/detail/?${q}`;
}
