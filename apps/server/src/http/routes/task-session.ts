import type {Database} from '../../db/index.js';
import type {UsageScope} from '../../db/usage-ledger.js';

export async function taskSession(db:Database,taskID:number,key:string){
  if(!Number.isSafeInteger(taskID)||taskID<1||! /^(plan|main:(?:0|[1-9]\d*)|intent:[1-9]\d*)$/.test(key))
    throw Object.assign(new Error('任务或会话编号无效'),{statusCode:400});
  const task=await db.tasks().getTask(taskID);
  if(!task)throw Object.assign(new Error('任务不存在'),{statusCode:404});
  const scope:UsageScope={taskID,taskOnly:true};
  const params:unknown[]=[taskID];
  let filter='task_id=$1 AND conversation_id IS NULL';
  let role='planner';
  if(key==='plan'){
    scope.roles=['goals','planner'];filter+=" AND role IN ('goals','planner')";
  }else{
    const n=Number(key.split(':')[1]);
    if(!Number.isSafeInteger(n))throw Object.assign(new Error('会话编号无效'),{statusCode:400});
    params.push(n);
    if(key.startsWith('main:')){role='mainagent';scope.mainSegment=n;filter+=' AND main_seg=$2';}
    else{
      const found=await db.query("SELECT id FROM exploration_nodes WHERE id=$1 AND exploration_id=$2 AND kind='intent'",[n,task.exploration_id]);
      if(!found.rowCount)throw Object.assign(new Error('此任务中不存在该 Worker'),{statusCode:404});
      role='worker';scope.intentID=n;filter+=' AND intent_id=$2';
    }
  }
  return {key,role,scope,filter,params};
}
