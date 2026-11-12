import type {Database} from './index.js';
import {resolveGraphNode} from './graph_view.js';

export const isCoverageGoal = (text: string) => /^资产测试覆盖度\s*(?:达到\s*)?100\s*[%％][。.!！]?$/u.test(text.trim());
const conflict=(message:string)=>Object.assign(new Error(message),{statusCode:409});
async function lockGoal(db:Database,taskID:number,goalID:number){
 const task=(await db.query('SELECT * FROM tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[taskID])).rows[0];
 if(!task)throw Object.assign(new Error('任务不存在'),{statusCode:404});
 await db.query('SELECT pg_advisory_xact_lock($1)',[-Number(task.exploration_id)]);
 const goal=(await db.query("SELECT id,payload,goal_text_hash(id) hash FROM exploration_nodes WHERE id=$1 AND exploration_id=$2 AND kind='goal'",[goalID,task.exploration_id])).rows[0];
 if(!goal)throw Object.assign(new Error('目标不存在'),{statusCode:404});
 return {task,goal};
}
export async function proposeGoalAcceptance(db:Database,taskID:number,goalID:number,evidenceID:number,note='',call?:string,assertOwnership?:(tx:Database)=>Promise<void>){
 return db.transaction(async tx=>{
  await assertOwnership?.(tx);
  const {task,goal}=await lockGoal(tx,taskID,goalID);
  const text=String((goal.payload as Record<string,unknown>).text??'');
  const method=isCoverageGoal(text)?'coverage':'manual';
  const {node}=await resolveGraphNode(tx,taskID,Number(task.exploration_id),evidenceID);
  if(!['fact','finding'].includes(node.kind)||node.state!=='confirmed'||node.payload.acceptance_status==='unverified'||['inferred','unknown'].includes(String(node.payload.observation_type))||(method!=='coverage'&&node.payload.observation_type==='negative'))throw conflict('需要已确认的实际证据，不能用推测或负面结论代替目标达成');
  const finding=node.kind==='finding'?(await tx.query('SELECT evidence,status FROM findings WHERE node_id=$1',[evidenceID])).rows[0]:undefined;
  const observed=finding?.evidence??node.payload.evidence;
  if(typeof observed!=='string'||!observed.trim()||finding?.status==='false_positive')throw conflict('证据缺少有效观察内容');
  const evidenceHash=(await tx.query('SELECT goal_evidence_hash($1) hash',[evidenceID])).rows[0]!.hash;
  const coverage=method==='coverage'?(await tx.query('SELECT goal_coverage_snapshot($1) value',[taskID])).rows[0]!.value as {enabled:boolean;denominator:number;tested:number}:null;
  if(coverage&&(!coverage.enabled||coverage.denominator===0||coverage.tested!==coverage.denominator))throw conflict(`覆盖度未达成：${coverage.tested}/${coverage.denominator}，不能确认 100%`);
  const previous=(await tx.query('SELECT * FROM goal_acceptance WHERE task_id=$1 AND goal_id=$2 ORDER BY id DESC LIMIT 1',[taskID,goalID])).rows[0];
  let proof=previous;
  if(!previous||previous.goal_hash!==goal.hash||Number(previous.evidence_id)!==evidenceID||previous.evidence_hash!==evidenceHash||previous.status==='rejected'||JSON.stringify(previous.coverage)!==JSON.stringify(coverage)){
   proof=(await tx.query(`INSERT INTO goal_acceptance(task_id,goal_id,goal_hash,goal_text,evidence_id,evidence_hash,method,status,coverage,note,source_call,reviewed_at,reviewed_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $7='coverage' THEN now() END,CASE WHEN $7='coverage' THEN 'host:coverage-v1' END) RETURNING *`,
    [taskID,goalID,goal.hash,text,evidenceID,evidenceHash,method,coverage?'approved':'pending',coverage,note,call??null])).rows[0];
  }
  if(coverage){await tx.exploration(Number(task.exploration_id)).link(evidenceID,'proves',goalID);await tx.exploration(Number(task.exploration_id)).setNodeState(goalID,'met');}
  const counts=await tx.exploration(Number(task.exploration_id)).executionCounts();
  return {goal_id:goalID,acceptance_id:String(proof!.id),met:proof!.status==='approved',verification:proof!.status==='approved'?(method==='coverage'?'host_verified':'human_verified'):'awaiting_confirmation',all_goals_met:counts.goalsReady&&counts.goals>0&&counts.met===counts.goals,goals:counts.goals,met_count:counts.met,remaining:counts.goals-counts.met};
 });
}
export async function goalAcceptanceDetails(db:Database,taskID:number,goalID:number){
 const row=(await db.query(`SELECT p.*,goal_acceptance_valid(p.id) valid,
  p.goal_hash=goal_text_hash(p.goal_id) AND p.evidence_hash=goal_evidence_hash(p.evidence_id) fresh
  FROM goal_acceptance p JOIN tasks t ON t.id=p.task_id JOIN exploration_nodes g ON g.id=p.goal_id AND g.exploration_id=t.exploration_id
  WHERE p.task_id=$1 AND p.goal_id=$2 AND t.deleted_at IS NULL ORDER BY p.id DESC LIMIT 1`,[taskID,goalID])).rows[0];
 if(!row)return null;
 const task=await db.tasks().getTask(taskID);if(!task)return null;
 const {node}=await resolveGraphNode(db,taskID,task.exploration_id,Number(row.evidence_id));
 return {...row,method:String(row.method),status:String(row.status),fresh:row.fresh===true,goal_hash:String(row.goal_hash),evidence_hash:String(row.evidence_hash),id:String(row.id),goal_id:String(row.goal_id),evidence_id:String(row.evidence_id),evidence_kind:node.kind,evidence_summary:String(node.payload.summary??node.payload.text??''),state:row.valid?'met':row.fresh&&row.status==='pending'?'pending_confirmation':'open'};
}
export async function reviewGoalAcceptance(db:Database,taskID:number,goalID:number,proofID:string,hashes:{goal_hash:string;evidence_hash:string},approve:boolean,actor:string){
 return db.transaction(async tx=>{
  const {task,goal}=await lockGoal(tx,taskID,goalID);
  const proof=await goalAcceptanceDetails(tx,taskID,goalID);
  if(!proof||proof.id!==proofID||proof.method!=='manual'||proof.status!=='pending'||!proof.fresh||goal.hash!==hashes.goal_hash||proof.evidence_hash!==hashes.evidence_hash)throw conflict('目标或证据已变化，或申请已处理，请重新读取后核验');
  await tx.query('UPDATE goal_acceptance SET status=$2,reviewed_at=now(),reviewed_by=$3 WHERE id=$1',[proofID,approve?'approved':'rejected',actor]);
  if(approve){await tx.exploration(Number(task.exploration_id)).link(Number(proof.evidence_id),'proves',goalID);await tx.exploration(Number(task.exploration_id)).setNodeState(goalID,'met');}
  // Human review is bookkeeping. It never starts an executor or replays tools.
  return {ok:true,accepted:approve};
 });
}
