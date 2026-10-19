import {createHash,randomUUID} from 'node:crypto';
import type {Database} from '../db/index.js';

export function outputPage(id:string,body:string,offset=0){
 const start=Math.min(body.length,Math.max(0,Math.floor(Number.isFinite(offset)?offset:0))),end=Math.min(body.length,start+2000);
 return {output_ref:id,format:'json',content:body.slice(start,end),offset:start,total:body.length,next_offset:end<body.length?end:null,
  hint:'content 是完整工具 JSON 的一段；用 read_tool_output(output_ref, offset=next_offset) 续读，不会省略数组成员。'};
}
async function authorizationFingerprint(db:Database,taskID:number){
 const owners=[taskID,...(await db.query('SELECT source_task_id FROM task_relations WHERE task_id=$1 ORDER BY source_task_id',[taskID])).rows.map(r=>Number(r.source_task_id))];
 const tasks=(await db.query('SELECT id,deleted_at,asset_approval_template FROM tasks WHERE id=ANY($1::bigint[]) ORDER BY id',[owners])).rows;
 const assets=(await db.query('SELECT task_id,asset_id,task_asset_effective_approval_state(task_id,asset_id) state FROM task_asset_links WHERE task_id=ANY($1::bigint[]) ORDER BY task_id,asset_id',[owners])).rows;
 const blocks=(await db.query('SELECT task_id,asset_key,host_key,block_kind FROM task_asset_blocks WHERE task_id=ANY($1::bigint[]) ORDER BY task_id,asset_key',[owners])).rows;
 return createHash('sha256').update(JSON.stringify([tasks,assets,blocks])).digest('hex');
}
export async function saveToolOutput(db:Database,scope:{taskID:number;conversationID?:number;intentID?:number},tool:string,callID:string,body:string){
 const id=randomUUID();
 await db.query('INSERT INTO tool_output_artifacts(id,task_id,conversation_id,node_id,tool,tool_call_id,body,authorization_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,scope.taskID||null,scope.conversationID??null,scope.intentID??null,tool,callID,body,scope.taskID?await authorizationFingerprint(db,scope.taskID):null]);
 return outputPage(id,body);
}
export async function loadToolOutput(db:Database,id:string,scope?:{taskID:number;conversationID?:number;worker?:boolean;agent?:boolean;intentID?:number}){
 const row=(await db.query('SELECT * FROM tool_output_artifacts WHERE id=$1',[id])).rows[0];
 if(!row)throw Object.assign(new Error('工具原文不存在'),{statusCode:404});
 if(scope&&(scope.conversationID?Number(row.conversation_id)!==scope.conversationID:row.conversation_id!==null||Number(row.task_id)!==scope.taskID))throw Object.assign(new Error('工具原文不属于当前会话'),{statusCode:403});
 if(scope?.agent&&row.node_id&&Number(row.node_id)!==scope.intentID)throw Object.assign(new Error('其他意图的私有工具原文不能作为协同来源；请读取已发布探索图'),{statusCode:403});
 if(row.task_id){
  if(row.authorization_hash!==await authorizationFingerprint(db,Number(row.task_id)))throw Object.assign(new Error('授权范围已变化，请重新执行原查询'),{statusCode:403});
  const task=await db.tasks().getTask(Number(row.task_id));
  if(!task||row.node_id&&!(await db.query('SELECT 1 WHERE exploration_node_readable($1,$2,$3)',[task.exploration_id,Number(row.node_id),scope?.worker===true])).rowCount)throw Object.assign(new Error('工具原文授权已撤销'),{statusCode:403});
 }
 return String(row.body);
}
