import type {Database} from '../db/index.js';
import {resolveGraphNode} from '../db/graph_view.js';

export type EvidenceOwner={task_id:unknown;intent_id:unknown;url:unknown};
/** Authorization comes from the immutable snapshot, never its removable inbox entry. */
export async function authorizeEvidence(db:Database,owner:EvidenceOwner,taskID?:number,allowPending:boolean|'main'=false){
 const ownerID=Number(owner.task_id);
 if(!ownerID||(taskID!==undefined&&ownerID!==taskID))throw Object.assign(new Error('证据不属于当前任务'),{statusCode:403});
 const task=await db.tasks().getTask(ownerID);
 if(!task)throw Object.assign(new Error('证据来源任务已不可用'),{statusCode:403});
 try{
  const intent=owner.intent_id==null?null:(await resolveGraphNode(db,ownerID,task.exploration_id,Number(owner.intent_id),!!allowPending)).node;
  const url=new URL(String(owner.url)),port=Number(url.port)||(url.protocol==='https:'?443:80);
  if(allowPending==='main')await db.taskScope().validateWorkerHostPort(ownerID,url.hostname,port);
  else if(allowPending&&intent)await db.taskScope().validateIntentHostPort(ownerID,intent,url.hostname,port);
  else await db.taskScope().validateTaskHostPort(ownerID,url.hostname,port);
 }catch{throw Object.assign(new Error('证据目标已超出授权范围或授权已撤销'),{statusCode:403});}
}

export async function authorizedEvidenceIDs(db:Database,rows:Array<EvidenceOwner&{id:unknown}>){
 const decisions=new Map<string,boolean>(),ids:string[]=[];
 for(const row of rows){
  let origin:string;try{origin=new URL(String(row.url)).origin;}catch{continue;}
  const key=JSON.stringify([row.task_id,row.intent_id,origin]);
  let allowed=decisions.get(key);
  if(allowed===undefined){try{await authorizeEvidence(db,row);allowed=true;}catch{allowed=false;}decisions.set(key,allowed);}
  if(allowed)ids.push(String(row.id));
 }
 return ids;
}
