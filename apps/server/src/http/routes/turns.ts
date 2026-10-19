import type {FastifyInstance} from 'fastify';
import {conversationReadable} from '../activity-stream.js';
import {readTurnSummaries} from '../../engine/turn-summary.js';

export function registerTurnRoutes(app:FastifyInstance){
 for(const scope of ['tasks','conversations'] as const)app.get(`/api/${scope}/:id/turns`,async(req,reply)=>{
  const id=Number((req.params as {id:string}).id);
  const ids=[...new Set(String((req.query as {ids?:string}).ids??'').split(',').filter(Boolean))];
  if(!Number.isSafeInteger(id)||id<1||!ids.length||ids.length>100||ids.some(s=>s.length>240||!/^[\w:-]+$/.test(s)))return reply.code(400).send({error:'需要有效范围及最多 100 个 turn_id'});
  const task=scope==='tasks'?await app.db.tasks().getTask(id):null;
  if(scope==='tasks'?!task:!await conversationReadable(app.db,id))return reply.code(404).send({error:'会话或任务不存在'});
  return {items:await readTurnSummaries(app.db,scope==='tasks'?'task':'conversation',task?.exploration_id??id,ids)};
 });
}
