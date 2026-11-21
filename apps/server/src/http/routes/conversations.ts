import {serveActivityStream,conversationReadable} from '../activity-stream.js';
import {activityDTO} from '../../engine/live-stream.js';
import {readActivityPage,readActivityContent,readSnapshotContent} from '../../db/activity-content.js';
import type { FastifyInstance } from 'fastify';
import {taskSession} from './task-session.js';
import {aggregateUsage} from '../../db/usage-ledger.js';

const activity = activityDTO;
function conversationDTO(row: Record<string, unknown>) {
  return { ...row, id: Number(row.id), task_id: row.task_id == null ? null : Number(row.task_id),
    llm_profile_id: row.llm_profile_id == null ? null : Number(row.llm_profile_id),
    read_only: row.read_only === true || row.agent_key === 'retester', retired: row.agent_key === 'retester', pinned: row.pinned_at != null, running: row.running === true };
}

export function registerConversationRoutes(app: FastifyInstance) {
  const service = () => app.engine.conversations;
  const db = () => app.db;

  app.get('/api/tasks/:id/session-usage', async req => {
    const taskID=Number((req.params as {id:string}).id);
    const q=req.query as {session?:string;segment?:string};
    const session=await taskSession(db(),taskID,q.session??`main:${q.segment??0}`);
    const [totals,models,latest]=await Promise.all([
      aggregateUsage(db(),session.scope),aggregateUsage(db(),session.scope,'model'),
      db().query(`SELECT model,profile_id,usage,quality,status,purpose,input_semantics,created_at,finished_at FROM llm_usage_ledger
        WHERE ${session.filter} AND source IN ('provider','request_audit')
        ORDER BY created_at DESC,request_id DESC LIMIT 1`,session.params),
    ]);
    return usageSnapshot(totals[0],models,latest.rows[0]);
  });
  app.get('/api/conversations/:id/usage', async (req, reply) => {
    const id = Number((req.params as {id:string}).id);
    if (!Number.isSafeInteger(id) || id < 1 || !await conversationReadable(db(), id))
      return reply.code(404).send({error:'conversation not found'});
    const [totals, models, latest] = await Promise.all([
      aggregateUsage(db(), {conversationID:id}),
      aggregateUsage(db(), {conversationID:id}, 'model'),
      db().query(`SELECT model,profile_id,usage,quality,status,purpose,input_semantics,created_at,finished_at FROM llm_usage_ledger
        WHERE conversation_id=$1 AND source IN ('provider','request_audit')
        ORDER BY created_at DESC,request_id DESC LIMIT 1`, [id]),
    ]);
    return usageSnapshot(totals[0],models,latest.rows[0]);
  });

  app.get('/api/conversations', async req => {
    const value = (req.query as {task?: string}).task;
    if (value === undefined) return {conversations: (await service().list()).map(conversationDTO)};
    const taskID = Number(value);
    if (!Number.isSafeInteger(taskID) || taskID < 1 || !await db().tasks().getTask(taskID)) {
      throw Object.assign(new Error('任务不存在'), {statusCode: 404});
    }
    // Retester sessions retain their original finding relation rather than a copied task binding.
    const rows = await db().query(`SELECT c.*,COALESCE(c.task_id,f.task_id) AS task_id,a.name AS agent_name,(a.id IS NULL OR NOT a.enabled) AS read_only,
      (EXISTS(SELECT 1 FROM conversation_runs r WHERE r.conversation_id=c.id AND r.status IN ('queued','running'))
       OR rt.status IN ('pending','running')) IS TRUE AS running
      FROM conversations c LEFT JOIN agents a ON a.key=c.agent_key
      LEFT JOIN finding_retests rt ON rt.conversation_id=c.id LEFT JOIN findings f ON f.id=rt.finding_id
      WHERE COALESCE(c.task_id,f.task_id)=$1 AND (rt.id IS NULL OR finding_readable(f.id))
      ORDER BY c.pinned_at DESC NULLS LAST,c.updated_at DESC,c.id DESC`, [taskID]);
    return {conversations: rows.rows.map(conversationDTO)};
  });

  app.post('/api/conversations', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const key = typeof body.agent_key === 'string' ? body.agent_key.trim() : '';
    if (!key) return reply.code(400).send({ error: 'agent_key 不能为空' });
    const title = typeof body.title === 'string' ? body.title : '';
    const profile = body.llm_profile_id === null || body.llm_profile_id === undefined ? null : Number(body.llm_profile_id);
    if (profile !== null && (!Number.isSafeInteger(profile) || profile < 1)) return reply.code(400).send({ error: 'llm_profile_id 无效' });
    const taskID = body.task_id === null || body.task_id === undefined ? undefined : Number(body.task_id);
    if (taskID !== undefined && (!Number.isSafeInteger(taskID) || taskID < 1)) return reply.code(400).send({ error: 'task_id 无效' });
    const created = await service().create(key, title, profile, taskID);
    return reply.code(201).send(conversationDTO(created));
  });

  app.patch('/api/conversations/:id/profile', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const profile = (req.body as { llm_profile_id?: unknown } | null)?.llm_profile_id;
    if (!Number.isSafeInteger(id) || id < 1) throw Object.assign(new Error('conversation id 无效'), { statusCode: 400 });
    if (profile !== null && profile !== undefined && (!Number.isSafeInteger(Number(profile)) || Number(profile) < 1)) {
      throw Object.assign(new Error('llm_profile_id 无效'), { statusCode: 400 });
    }
    return service().setProfile(id, profile === null || profile === undefined ? null : Number(profile));
  });

  app.patch('/api/conversations/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { title?: unknown; pinned?: unknown };
    if (!Number.isSafeInteger(id) || id < 1) throw Object.assign(new Error('conversation id 无效'), { statusCode: 400 });
    if (body.title !== undefined && typeof body.title !== 'string') throw Object.assign(new Error('title 必须是字符串'), { statusCode: 400 });
    if (body.pinned !== undefined && typeof body.pinned !== 'boolean') throw Object.assign(new Error('pinned 必须是布尔值'), { statusCode: 400 });
    return conversationDTO(await service().update(id, { ...(body.title === undefined ? {} : { title: body.title as string }), ...(body.pinned === undefined ? {} : { pinned: body.pinned as boolean }) }));
  });

  app.delete('/api/conversations/:id', async (req) => service().remove(Number((req.params as { id: string }).id)));

  app.post('/api/conversations/delete/batch', async (req, reply) => {
    const ids = (req.body as { ids?: unknown } | null)?.ids;
    if (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) < 1)) {
      return reply.code(400).send({ error: 'ids 必须是最多 100 个有效会话 ID' });
    }
    const items = [];
    for (const id of [...new Set(ids.map(Number))]) {
      try { const result=await service().remove(id); items.push({ id, ok: 'deleted' in result, ...result }); }
      catch (error) { items.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
    }
    return { items };
  });

  app.get('/api/conversations/:id/messages/stream', async (req, reply) => {
    const id=Number((req.params as {id:string}).id);
    if (!Number.isSafeInteger(id)||id<1||!await conversationReadable(db(),id)) return reply.code(404).send({error:'conversation not found'});
    await serveActivityStream(db(),req,reply,'conversation',id);
  });

  app.get('/api/conversations/:id/messages', async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isSafeInteger(id) || id < 1) throw Object.assign(new Error('conversation id 无效'), { statusCode: 400 });
    const q = req.query as Record<string, string | undefined>;
    if (!await conversationReadable(db(),id)) throw Object.assign(new Error('conversation not found'), { statusCode: 404 });
    const forward = q.since !== undefined;
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 200));
    const cursor = Math.max(0, Number(forward ? q.since : q.before) || 0);
    const rows = await readActivityPage(db(),'conversation',`conversation_id=$1 AND ${forward ? 'id>$2' : '($2::bigint=0 OR id<$2)'}`,[id,cursor],forward?'ASC':'DESC',limit);
    const hasMore = rows.hasMore;
    const items = rows.rows.map(activity);
    if (!forward) items.reverse();
    const run = await db().query("SELECT status FROM conversation_runs WHERE conversation_id=$1 AND status IN ('queued','running') ORDER BY id DESC LIMIT 1", [id]);
    const retest = await db().query("SELECT status FROM finding_retests WHERE conversation_id=$1 AND status IN ('pending','running')", [id]);
    return { items, cursor: items.at(-1)?.id ?? cursor, running: !!run.rowCount || !!retest.rowCount, status: run.rows[0]?.status ?? (retest.rowCount ? 'running' : 'idle'), hasMore };
  });

  app.get('/api/conversations/:id/messages/:seq', async (req) => {
    const p = req.params as { id: string; seq: string };
    if (!await conversationReadable(db(),Number(p.id))) throw Object.assign(new Error('conversation not found'), {statusCode:404});
    return readActivityContent(db(),'conversation','conversation_id=$1 AND id=$2',[Number(p.id),Number(p.seq)],req.query as Record<string,string>);
  });

  app.get('/api/conversations/:id/streams/:stream',async req=>{
    const p=req.params as {id:string;stream:string},id=Number(p.id);
    if(!await conversationReadable(db(),id))throw Object.assign(new Error('conversation not found'),{statusCode:404});
    return readSnapshotContent(db(),'conversation',id,p.stream,req.query as Record<string,string>);
  });

  app.post('/api/conversations/:id/messages', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { message?: unknown; attachments?: unknown;request_id?:unknown };
    const message = typeof body.message === 'string' ? body.message : '';
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    if(body.request_id!==undefined&&(typeof body.request_id!=="string"||!/^[-a-zA-Z0-9:]{1,120}$/.test(body.request_id)))throw Object.assign(new Error("request_id 无效"),{statusCode:400});
    const result = await service().enqueue(id, message, attachments,body.request_id as string|undefined);
    return reply.code(202).send({ status: 'accepted', run_id: result.run_id });
  });

  app.post('/api/conversations/:id/stop', async (req) => {
    const id = Number((req.params as { id: string }).id);
    await service().assertWritable(id);
    return service().stop(id);
  });
}

export function usageSnapshot(total:unknown, models:unknown[], last?:Record<string,unknown>) {
  // A summarization receipt is billed, but its context is NOT the conversation.
  // After any compaction attempt, only a new conversation receipt can calibrate it.
  const usage = (last?.usage ?? {}) as Record<string,unknown>;
  const count=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
  const inputTotal=count(usage.inputTotal),output=count(usage.output);
  const parts=[usage.input,usage.cacheRead,usage.cacheWrite].map(count);
  const exclusive=last?.input_semantics===undefined||last.input_semantics==='exclusive_cache';
  const input=usage._input_total_known===true ? inputTotal
    :last?.quality==='complete'&&exclusive&&parts.every(v=>v!==null)?parts.reduce<number>((sum,v)=>sum+v!,0):null;
  let state='unavailable';
  if(!last)state='empty';
  else if(last.status==='running')state='pending';
  else if(last.purpose==='compaction')state='compacted';
  else if(last.status==='completed'&&input!==null&&output!==null&&
    (last.quality==='complete'||Array.isArray(usage._known_fields)&&usage._known_fields.includes('output')))state='recorded';
  const capacity=count(usage._context_window);
  return {total,models,context:{tokens:state==='recorded'?input!+output!:null,state,
    capacity:capacity&&capacity>0?capacity:null,model:last?.model??null,
    profile_id:last?.profile_id==null?null:Number(last.profile_id),at:last?.finished_at??last?.created_at??null}};
}
