/** Prompt projections never replace the graph record; callers retain node refs. */
const short=(v:unknown,n:number)=>typeof v==='string'?v.slice(0,n):undefined;
export function progressSummary(value:unknown){
  if(!value||typeof value!=='object')return undefined;
  const p=value as Record<string,unknown>;
  return {phase:short(p.phase,40),summary:short(p.summary,200),blocker:short(p.blocker,160),next_step:short(p.next_step,160),updated_at:short(p.updated_at,64),
    attempted_count:Array.isArray(p.attempted)?p.attempted.length:0};
}
export function resultSummary(value:unknown){
  if(!value||typeof value!=='object')return undefined;
  const r=value as Record<string,unknown>;
  const criteria=Array.isArray(r.criteria)?r.criteria as {fact_ids?:number[]}[]:[];
  return {outcome:short(r.outcome,40),summary:short(r.summary,240),remaining:short(r.remaining,160),fact_ids:[...new Set(criteria.flatMap(c=>Array.isArray(c.fact_ids)?c.fact_ids:[]).filter(id=>Number.isSafeInteger(id)&&id>0))].slice(0,10)};
}
export function stopSummary(value:unknown){
  if(!value||typeof value!=='object')return undefined;
  const s=value as Record<string,unknown>;
  // Full references remain on context_get; current authorization is checked there.
  return {reason:short(s.reason,64),summary:short(s.summary,240),recovery:short(s.recovery,240),
    accepted_result:s.accepted_result===true,recorded_at:short(s.recorded_at,64)};
}
