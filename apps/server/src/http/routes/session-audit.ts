import type {FastifyInstance} from 'fastify';
import {sessionAudit} from './session-audit-data.js';

export function registerSessionAudit(app:FastifyInstance) {
  app.get('/api/tasks/:id/session-audit',async(req,reply)=>{
    const taskID=Number((req.params as {id:string}).id);
    if(!Number.isSafeInteger(taskID)||taskID<1)return reply.code(400).send({error:'无效任务编号'});
    const task=(await app.db.query('SELECT exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL',[taskID])).rows[0];
    if(!task)return reply.code(404).send({error:'任务不存在'});
    if(!task.exploration_id)return reply.code(404).send({error:'此任务没有 Planner / Worker 探索会话'});
    const q=req.query as Record<string,unknown>,expID=Number(task.exploration_id);
    if(q.node===undefined&&q.version===undefined)return sessionAudit(app.db,app.dataDir,expID);
    const node=Number(q.node),version=Number(q.version);
    if(typeof q.node!=='string'||typeof q.version!=='string'||!/^\d+$/.test(q.node)||!/^\d+$/.test(q.version)||
      !Number.isSafeInteger(node)||node<1||!Number.isSafeInteger(version))
      return reply.code(400).send({error:'需要有效的事实 ID 和版本'});
    return sessionAudit(app.db,app.dataDir,expID,{id:node,version});
  });
}
