export interface HumanInputRequest {
 id:string;task_id:string;role:'worker'|'planner'|'mainagent';turn_id:string;intent_id?:string;main_seg:number;tool_call_id?:string;activity_id?:number;
 question:string;kind:'input'|'editor'|'select'|'confirm';options?:string[];placeholder?:string;prefill?:string|null;sensitive:boolean;
 status:'pending'|'answered'|'cancelled'|'expired'|'interrupted';answer?:string|boolean;created_at:string;updated_at:string;expires_at?:string;
}
export function humanInputSource(r:HumanInputRequest){return r.role==='worker'?`Worker #${r.intent_id}`:r.role==='planner'?'Planner':`主 Agent · 会话 ${r.main_seg+1}`;}
export function humanInputSession(r:HumanInputRequest){return r.role==='worker'?`intent:${r.intent_id}`:r.role==='planner'?'plan':`main:${r.main_seg}`;}

export type HumanInputUpdate = 'snapshot' | 'detail';

export function mergeHumanInputs(old:HumanInputRequest[],next:HumanInputRequest[],taskId:string,source:HumanInputUpdate){
 const byId=new Map(old.filter(r=>r.task_id===taskId).map(r=>[r.id,r]));
 const rows=next.filter(r=>r.task_id===taskId);
 if(source==='snapshot'){
  // A task snapshot contains every pending request, but only recent history.
  const included=new Set(rows.map(r=>r.id));
  for(const [id,r] of byId)if(r.status==='pending'&&!included.has(id))byId.delete(id);
 }
 for(const r of rows){
  // History lookups may finish after a newer snapshot removed a pending row.
  if(source==='detail'&&r.status==='pending')continue;
  const before=byId.get(r.id);
  if(before&&((before.status!=='pending'&&r.status==='pending')||new Date(before.updated_at)>new Date(r.updated_at)))continue;
  byId.set(r.id,r);
 }
 return [...byId.values()];
}
