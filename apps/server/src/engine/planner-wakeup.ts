import type {Database} from '../db/index.js';

export interface PlannerWakeup {
  id:number;node_id:number|null;kind:string;urgent:boolean;oldest_at:Date|string;
}
/** Window over the complete inbox before LIMIT, so urgent controls and
 * settlements behind an asset burst never wait for the coalescing deadline. */
export async function pendingPlannerWakeups(db:Database,expID:number){
  return (await db.query<PlannerWakeup & Record<string,unknown>>(`SELECT id,node_id,kind,
    bool_or(kind NOT IN ('assets_changed','finding_published','source_finding')) OVER() urgent,
    min(created_at) OVER() oldest_at
    FROM blackboard_wakeups WHERE exploration_id=$1 AND acknowledged_at IS NULL ORDER BY id LIMIT 50`,[expID])).rows;
}

export const PLANNER_EVENT_BATCH_MS=30_000;
export const PLANNER_IDLE_REVIEW_MS=120_000;
/** Idle unfinished goals remain schedulable even without a blackboard revision.
 * The caller applies the same failure backoff to events and heartbeat reviews. */
export function plannerHeartbeatDue(opts:{now:number;lastPlannedAt:number;heartbeatMs:number;running:number;revisionChanged:boolean;unfinished:boolean;hasActiveIntent:boolean}){
  const idle=opts.unfinished&&!opts.hasActiveIntent;
  const interval=Math.max(1,idle?Math.min(opts.heartbeatMs,PLANNER_IDLE_REVIEW_MS):opts.heartbeatMs);
  return opts.now-opts.lastPlannedAt>=interval&&(idle||opts.running>0||opts.revisionChanged);
}
export function plannerWakeupReady(events:PlannerWakeup[],opts:{now:number;running:number;hasControl:boolean;heartbeatDue:boolean}){
  if(opts.hasControl||opts.heartbeatDue)return true;
  if(!events.length)return false;
  if(events[0]!.urgent||opts.running===0)return true;
  // Original DB timestamp makes the bound survive restarts and new arrivals.
  return opts.now-new Date(events[0]!.oldest_at).getTime()>=PLANNER_EVENT_BATCH_MS;
}
