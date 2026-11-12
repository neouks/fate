import type {FastifyInstance} from 'fastify';
import {goalAcceptanceDetails,reviewGoalAcceptance} from '../../db/goal-integrity.js';

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
 app.post(path,async(req,reply)=>{
  const {task,goal}=ids(req.params);const body=req.body as Record<string,unknown>|undefined;
  if(!body||!['approve','reject'].includes(String(body.action))||typeof body.acceptance_id!=='string'||!/^\d+$/.test(body.acceptance_id)||typeof body.goal_hash!=='string'||typeof body.evidence_hash!=='string')return reply.code(400).send({error:'需要有效的验收申请、版本及确认操作'});
  return reviewGoalAcceptance(app.db,task,goal,body.acceptance_id,{goal_hash:body.goal_hash,evidence_hash:body.evidence_hash},body.action==='approve','authenticated-user');
 });
}
