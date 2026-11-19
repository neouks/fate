import type {FastifyInstance} from 'fastify';
import {listHumanInputs,respondHumanInput} from '../../db/human-input.js';
const uuid=(v:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function registerHumanInputRoutes(app:FastifyInstance){
 app.get('/api/tasks/:id/input-requests',async(req,reply)=>{
  const task=Number((req.params as {id:string}).id),id=(req.query as {request_id?:string}).request_id;
  if(!Number.isSafeInteger(task)||task<1||(id&&!uuid(id)))return reply.code(400).send({error:'无效问题或任务 ID'});
  if(!(await app.db.tasks().getTask(task)))return reply.code(404).send({error:'任务不存在'});
  return {items:await listHumanInputs(app.db,task,id)};
 });
 app.post('/api/tasks/:id/input-requests/:requestID/respond',async(req,reply)=>{
  const p=req.params as {id:string;requestID:string},task=Number(p.id);
  if(!Number.isSafeInteger(task)||task<1||!uuid(p.requestID))return reply.code(400).send({error:'无效问题或任务 ID'});
  return respondHumanInput(app.db,task,p.requestID,(req.body??{}) as {action?:unknown;answer?:unknown});
 });
}
