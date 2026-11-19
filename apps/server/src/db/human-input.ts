import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {Database} from './index.js';
import {streamChanges} from '../engine/stream-changes.js';
import {validateHumanPrompt,type HumanPrompt,type HumanReply} from '../pi/human-input.js';

export interface HumanInputScope {taskID:number;runtimeID:string;role:string;turnID:string;intentID?:number;mainSegment?:number;}
type Row=Record<string,any>;
const conflict=()=>Object.assign(new Error('问题已失效、已回答或所属执行已停止'),{statusCode:409});
// Ownership includes the execution incarnation, not just the task's visible status.
const live=`EXISTS(SELECT 1 FROM runtime_role_configs r WHERE r.id=q.runtime_id AND r.finished_at IS NULL AND r.expires_at>clock_timestamp())
 AND EXISTS(SELECT 1 FROM tasks t WHERE t.id=q.task_id AND t.deleted_at IS NULL
  AND (t.status<>'running' OR t.deadline_at IS NULL OR t.deadline_at>clock_timestamp())
  AND NOT EXISTS(SELECT 1 FROM runtime_task_commands c WHERE c.task_id=t.id AND c.status='pending')
  AND (q.role='mainagent' OR (NOT t.paused AND NOT t.queued AND t.status='running')))
 AND (CASE WHEN q.role='mainagent' THEN EXISTS(SELECT 1 FROM runtime_session_leases s WHERE s.key=q.owner_key AND s.token=q.owner_token AND NOT s.stop_requested AND s.expires_at>clock_timestamp())
 ELSE EXISTS(SELECT 1 FROM engine_task_leases l WHERE l.task_id=q.task_id AND l.token=q.owner_token AND l.expires_at>clock_timestamp()) END)
 AND (q.intent_id IS NULL OR EXISTS(SELECT 1 FROM exploration_nodes n WHERE n.id=q.intent_id AND n.state='running' AND COALESCE(n.payload->>'cancelled_by_user','false')<>'true' AND NOT(n.payload ? 'execution_result')))`;

function dto(r:Row){return {id:r.id,task_id:String(r.task_id),runtime_id:r.runtime_id,role:r.role,turn_id:r.turn_id,
 intent_id:r.intent_id==null?undefined:String(r.intent_id),main_seg:r.main_seg,tool_call_id:r.tool_call_id,
 activity_id:r.activity_id==null?undefined:Number(r.activity_id),question:r.question,kind:r.kind,options:r.options,
 // Existing editor rows already store the original PI prefill in this column.
 ...(r.kind==='editor'&&!r.sensitive?{prefill:r.placeholder}:{placeholder:r.placeholder}),sensitive:r.sensitive,status:r.status,
 answer:r.sensitive?undefined:r.answer,created_at:r.created_at,updated_at:r.updated_at,expires_at:r.expires_at};}
async function changed(db:Database,taskID:number){const exp=(await db.query('SELECT exploration_id FROM tasks WHERE id=$1',[taskID])).rows[0]?.exploration_id;if(exp)streamChanges.emit('change','task',Number(exp));}

export async function reconcileHumanInputs(db:Database,taskID?:number){
 return db.query(`UPDATE human_input_requests q SET status=CASE WHEN NOT (${live}) THEN 'interrupted' ELSE 'expired' END,
 answer=NULL,updated_at=clock_timestamp() WHERE (status='pending' OR (status='answered' AND delivered_at IS NULL))
 ${taskID===undefined?'':'AND task_id=$1'} AND (NOT (${live}) OR (status='pending' AND expires_at<=clock_timestamp())) RETURNING task_id`,taskID===undefined?[]:[taskID]);
}
export async function listHumanInputs(db:Database,taskID:number,id?:string){
 await reconcileHumanInputs(db,taskID);
 return (await db.query(`SELECT * FROM human_input_requests WHERE task_id=$1 AND ${id?'id=$2':"(status='pending' OR id IN (SELECT id FROM human_input_requests WHERE task_id=$1 ORDER BY created_at DESC LIMIT 100))"} ORDER BY created_at`,id?[taskID,id]:[taskID])).rows.map(dto);
}
/** Small coordination marker only; another Agent never receives the question or answer. */
export async function pendingHumanInputSources(db:Database,taskID:number){
 return (await db.query(`SELECT role,intent_id,main_seg FROM human_input_requests q WHERE task_id=$1 AND status='pending' AND (expires_at IS NULL OR expires_at>clock_timestamp()) AND (${live}) ORDER BY created_at`,[taskID])).rows;
}
export async function interruptHumanInputs(db:Database,runtimeID:string){
 const rows=await db.query("UPDATE human_input_requests SET status='interrupted',answer=NULL,updated_at=clock_timestamp() WHERE runtime_id=$1 AND (status='pending' OR (status='answered' AND delivered_at IS NULL)) RETURNING task_id",[runtimeID]);
 for(const id of new Set(rows.rows.map(r=>Number(r.task_id))))await changed(db,id);
}

/** Locks follow task -> intent -> request order, shared with platform stop actions. */
export async function respondHumanInput(db:Database,taskID:number,id:string,body:{action?:unknown;answer?:unknown}){
 const result=await db.transaction(async tx=>{
  if(!(await tx.query('SELECT id FROM tasks WHERE id=$1 AND deleted_at IS NULL FOR SHARE',[taskID])).rowCount)throw Object.assign(new Error('任务不存在'),{statusCode:404});
  const ref=(await tx.query('SELECT intent_id FROM human_input_requests WHERE task_id=$1 AND id=$2',[taskID,id])).rows[0];
  if(!ref)throw Object.assign(new Error('问题不存在'),{statusCode:404});
  if(ref.intent_id)await tx.query('SELECT id FROM exploration_nodes WHERE id=$1 FOR SHARE',[ref.intent_id]);
  const r=(await tx.query(`SELECT q.*,(${live}) live FROM human_input_requests q WHERE q.task_id=$1 AND q.id=$2 FOR UPDATE OF q`,[taskID,id])).rows[0]!;
  if(body.action!=='answer'&&body.action!=='cancel')throw Object.assign(new Error('无效回复操作'),{statusCode:400});
  // Identical network retries acknowledge the saved reply, never deliver twice.
  if((r.live||r.delivered_at)&&r.status==='answered'&&body.action==='answer'&&JSON.stringify(body.answer)===JSON.stringify(r.answer))return dto(r);
  if(r.status==='cancelled'&&body.action==='cancel')return dto(r);
  if(!r.live||r.status!=='pending')throw conflict();
  if(body.action==='answer'){
   const a=body.answer;
   const allowEmpty=r.kind==='editor'&&!r.sensitive;
   if(r.kind==='confirm'?typeof a!=='boolean':typeof a!=='string'||(!allowEmpty&&!a.trim())||a.length>16000||a.includes('\0')||(r.kind==='select'&&!(r.options as string[]).includes(a)))
    throw Object.assign(new Error('回答格式无效或不在选项中'),{statusCode:400});
  }
  const updated=(await tx.query(`UPDATE human_input_requests SET status=$3,answer=$4::jsonb,updated_at=clock_timestamp()
    WHERE task_id=$1 AND id=$2 AND status='pending'
      AND (expires_at IS NULL OR expires_at>clock_timestamp())
    RETURNING *`,[taskID,id,body.action==='answer'?'answered':'cancelled',body.action==='answer'?JSON.stringify(body.answer):null])).rows[0];
  if(!updated)throw conflict();
  return dto(updated);
 });
 await changed(db,taskID);return result;
}

export async function waitForHumanInput(db:Database,scope:HumanInputScope,p:HumanPrompt,signal:AbortSignal):Promise<HumanReply>{
 validateHumanPrompt(p);signal.throwIfAborted();const id=randomUUID();
 await db.transaction(async tx=>{
  const task=(await tx.query('SELECT exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL FOR SHARE',[scope.taskID])).rows[0];
  if(!task)throw conflict();
  const key=scope.role==='mainagent'?`main:${scope.taskID}:${scope.mainSegment??0}`:String(scope.taskID);
  const owner=(await tx.query(scope.role==='mainagent'?'SELECT token FROM runtime_session_leases WHERE key=$1':'SELECT token FROM engine_task_leases WHERE task_id=$1',[key])).rows[0];
  if(!owner)throw conflict();
  await tx.query(`INSERT INTO human_input_requests(id,task_id,runtime_id,role,turn_id,intent_id,main_seg,tool_call_id,owner_key,owner_token,question,kind,options,placeholder,sensitive,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,CASE WHEN $16::int IS NULL THEN NULL ELSE clock_timestamp()+$16*interval '1 millisecond' END)`,
   [id,scope.taskID,scope.runtimeID,scope.role,scope.turnID,scope.intentID??null,scope.mainSegment??0,p.tool_call_id??null,key,owner.token,p.question,p.kind,p.options?JSON.stringify(p.options):null,p.prefill??p.placeholder??null,p.sensitive===true,p.timeout_ms??null]);
  if(!(await tx.query(`SELECT id FROM human_input_requests q WHERE id=$1 AND (${live})`,[id])).rowCount)throw conflict();
  const activityID=await tx.exploration(Number(task.exploration_id)).appendActivity({node_id:scope.intentID,main_seg:scope.mainSegment??0,worker:scope.role,kind:'status',summary:p.question,
   metadata:{turn_id:scope.turnID,main_seg:scope.mainSegment??0,event_type:'human_input',human_input_id:id}});
  await tx.query('UPDATE human_input_requests SET activity_id=$2 WHERE id=$1',[id,activityID]);
 });
 await changed(db,scope.taskID);
 try{
  for(;;){
   signal.throwIfAborted();await reconcileHumanInputs(db,scope.taskID);
   const r=(await db.query('SELECT * FROM human_input_requests WHERE id=$1',[id])).rows[0];
   signal.throwIfAborted();if(!r)throw conflict();
   if(r.status!=='pending'){
    if(r.status==='answered'){
     const delivered=await db.query(`UPDATE human_input_requests q SET delivered_at=clock_timestamp() WHERE id=$1 AND status='answered' AND delivered_at IS NULL AND (${live}) RETURNING id`,[id]);
     if(!delivered.rowCount)throw conflict();
    }
    signal.throwIfAborted();return {id,status:r.status as HumanReply['status'],...(r.status==='answered'?{answer:r.answer as string|boolean}:{})};
   }
   await delay(500,undefined,{signal});
  }
 }finally{
  await interruptHumanInputs(db,scope.runtimeID);
  await changed(db,scope.taskID);
 }
}
