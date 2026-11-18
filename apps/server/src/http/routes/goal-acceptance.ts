import type {FastifyInstance} from 'fastify';
import {goalAcceptanceDetails} from '../../db/goal-integrity.js';

export function registerGoalAcceptanceRoutes(app:FastifyInstance){
 const path='/api/tasks/:id/goals/:goalId/acceptance';
 const ids=(params:unknown)=>{const p=params as {id:string;goalId:string};const task=Number(p.id),goal=Number(p.goalId);if(!Number.isSafeInteger(task)||task<1||!Number.isSafeInteger(goal)||goal<1)throw Object.assign(new Error('无效的任务或目标'),{statusCode:400});return {task,goal};};
 app.get(path,async(req,reply)=>{
  const {task,goal}=ids(req.params);
  const owner=await app.db.tasks().getTask(task);
  const node=owner?await app.db.exploration(owner.exploration_id).getNode(goal):null;
  if(!owner||!node||node.kind!=='goal')return reply.code(404).send({error:'目标不存在'});
  reply.header('Cache-Control','private, no-store');
  return {acceptance:await goalAcceptanceDetails(app.db,task,goal)};
 });
}
