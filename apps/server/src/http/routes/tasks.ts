import {goalResourceCatalog} from '../../pi/goal-resources.js';
import {aggregateUsage} from '../../db/usage-ledger.js';
import {requireTaskGoal} from '../../agent/task-goal.js';
import {controlGoal,goalHistory,sendGoalMessage} from '../../pi/goal-session.js';
import {makeModelResolver} from '../../pi/modelResolver.js';
import type { FastifyInstance } from "fastify";
import type { Task } from "../../db/tasks.js";
import { TASK_DISPLAY_STATUS } from "../../db/tasks.js";


/** 列表/详情 DTO：在 store Task 之上补前端仪表盘需要的聚合位（goals/counts 在详情填充）。 */
function taskDTO(t: Task): Record<string, unknown> {
  const out: Record<string, unknown> = { ...t, id: String(t.id) };
  if (t.created_at) out["created_unix"] = Math.floor(new Date(t.created_at).getTime() / 1000);
  if (t.completed_at) out["completed_unix"] = Math.floor(new Date(t.completed_at).getTime() / 1000);
  const related = (t as unknown as { source_task_ids?: unknown }).source_task_ids;
  if (Array.isArray(related)) out["source_task_ids"] = related.map(String);
  return out;
}

export function registerTaskRoutes(app: FastifyInstance, resolveModel = makeModelResolver(app.db)): void {
  const tasks = () => app.db.tasks();
  async function serializeTask(task:Task, states?:Map<number,Record<string,unknown>>): Promise<Record<string,unknown>> {
    const dto = taskDTO(task);
    if (!task.exploration_id) return {...dto,runtime:'pi',exploration_id:null,execution_status:task.status,
      goals_total:1,goals_met:Number(task.status==='done'),in_flight:0};
    const legacy=states?.get(task.id) ?? (await app.db.query(
      'SELECT task_display_status($1) status,task_display_reason($1) status_reason',[task.id])).rows[0];
    return {...dto,...legacy,runtime:'legacy',execution_status:legacy?.status??task.status};
  }

  // ─── 列表与创建 ────────────────────────────────────────────────────────────

  app.get("/api/tasks", async (req,reply) => {
    const q=req.query as Record<string,string|undefined>;
    if(['page','page_size'].some(k=>q[k]!==undefined&&(!Number.isSafeInteger(Number(q[k]))||Number(q[k])<1))||
      (q.category!==undefined&&!['all','uncategorized'].includes(q.category)&&(!Number.isSafeInteger(Number(q.category))||Number(q.category)<1)))
      return reply.code(400).send({error:'无效的分页或分类参数'});
    const paged=Object.keys(q).some(k=>['page','page_size','q','status','category','sort','direction','recent'].includes(k));
    const result=paged?await tasks().listTasksPage({page:Math.max(1,Number(q.page)||1),pageSize:Math.min(100,Math.max(1,Number(q.page_size)||20)),q:q.q,status:q.status,category:q.category,sort:q.sort,direction:q.direction,recent:q.recent==='true'}):{tasks:await tasks().listTasks()};
    const list=result.tasks,ids=list.map(t=>t.id);
    const states=new Map((await app.db.query('SELECT id,task_display_status(id) status,task_display_reason(id) status_reason FROM tasks WHERE id=ANY($1::bigint[])',[ids])).rows.map(r=>[Number(r.id),r]));
    const active = (await app.db.platform().getSetting("active_task")) ?? "";
    // 派生位聚合：findings 四档 / goals 进度 / 在跑 / 最近活动 / 任务级 token。
    const agg = await app.db.query(
      `SELECT t.id,
              COALESCE((SELECT json_build_object('critical',count(*) FILTER (WHERE f.severity='critical'),'high',count(*) FILTER (WHERE f.severity='high'),'medium',count(*) FILTER (WHERE f.severity='medium'),'low',count(*) FILTER (WHERE f.severity='low'))
                 FROM findings f WHERE f.task_id=t.id),'{"critical":0,"high":0,"medium":0,"low":0}'::json) findings,
              CASE WHEN t.exploration_id IS NULL THEN json_build_object('total',1,'met',(t.status='done')::int)
                ELSE (SELECT json_build_object('total',total,'met',met) FROM task_goal_progress(t.exploration_id)) END goals,

              EXTRACT(EPOCH FROM COALESCE((SELECT max(a.created_at) FROM activity a WHERE a.exploration_id=t.exploration_id), t.created_at))::bigint last_activity_unix
       FROM tasks t WHERE t.id=ANY($1::bigint[])`,[ids]) as never;
    const tokenRows=new Map((await aggregateUsage(app.db,{taskIDs:ids},'task')).map(r=>[Number(r.bucket),r]));
    const aggRows = new Map<number, Record<string, unknown>>();
    for (const r of (agg as unknown as { rows: Array<Record<string, unknown>> }).rows) aggRows.set(Number(r["id"]), r);
    const items=[];
    for(const t of list){
        const dto = await serializeTask(t,states);
        const a = aggRows.get(Number(t.id));
        if (a) {
          dto["findings"] = a["findings"];
          dto["goals_total"] = ((a["goals"] as { total?: number }) ?? {}).total ?? 0;
          dto["goals_met"] = ((a["goals"] as { met?: number }) ?? {}).met ?? 0;
          dto["last_activity_unix"] = Number(a["last_activity_unix"] ?? 0);
          dto["tokens"] = tokenRows.get(t.id)??{input_tokens:0,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0,usage_complete:true,version:'usage-v2'};
        }
        items.push(dto);
    }
    return {...result,tasks:items,active};
  });

  app.get('/api/tasks/summary',async()=>{
    const rows=(await app.db.query(`SELECT ${TASK_DISPLAY_STATUS} status,count(*) n FROM tasks WHERE deleted_at IS NULL GROUP BY 1`)).rows;
    const by_status=Object.fromEntries(rows.map(r=>[String(r.status),Number(r.n)]));
    return {total:rows.reduce((n,r)=>n+Number(r.n),0),by_status};
  });

  app.post("/api/tasks", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const description = typeof b["description"] === "string" && b["description"].trim() !== "" ? b["description"] : "";
    let goal: string;
    try { goal = requireTaskGoal(b["goal"]); } catch (error) { return reply.code(400).send({error:(error as Error).message,code:"TASK_GOAL_REQUIRED"}); }
    if (b.category_id!=null && (!Number.isSafeInteger(b.category_id) || Number(b.category_id)<1))
      return reply.code(400).send({error:'分类 ID 无效'});
    if (Array.from(goal).length>64000) return reply.code(400).send({error:'目标最多 64000 字符'});
    const profiles = b.llm_profile_ids ?? [];
    if (!Array.isArray(profiles) || new Set(profiles).size!==profiles.length || profiles.some(v=>!Number.isSafeInteger(v)||v<=0))
      return reply.code(400).send({error:'无效的模型 ID'});
    if (['source_task_ids','asset_ids','company_ids'].some(k=>b[k]!==undefined && !(Array.isArray(b[k]) && !b[k].length))
        || b.seed_first_intent || b.execution_mode==='manual')
      return reply.code(400).send({error:'目标会话不接受图或 Worker 参数'});
    const task = await tasks().createGoalTask(description,goal,{name:typeof b.name==='string'?b.name.trim():'',
      categoryID:b.category_id==null?null:Number(b.category_id),llmProfileIDs:profiles});
    return reply.code(201).send(await serializeTask(task));
  });

  app.get("/api/tasks/:id", async (req, reply) => {
    const id = Number((req.params as {id:string}).id);
    const task = await tasks().getTask(id);
    if (!task) return reply.code(404).send({error:'任务不存在'});
    const receipt = (await app.db.query('SELECT accepted_entry FROM tasks WHERE id=$1',[id])).rows[0];
    return {...await serializeTask(task),...(!task.exploration_id?{resources:goalResourceCatalog()}:{}),accepted_entry:receipt?.accepted_entry ?? null};
  });
  app.get("/api/tasks/:id/messages",async(req,reply)=>{
    const id = Number((req.params as {id:string}).id);
    const task = await tasks().getTask(id);
    if (!task) return reply.code(404).send({error:'任务不存在'});
    if (!task.exploration_id) {
      const confirmed = new Set((await app.db.query('SELECT reply_entry FROM pi_goal_turns WHERE task_id=$1 AND reply_entry IS NOT NULL',[id])).rows.map(r=>r.reply_entry));
      return {messages:goalHistory(app.dataDir,id).map(m=>({...m,confirmed:confirmed.has(m.id)}))};
    }
    const before = (req.query as {before?:string}).before;
    if (before!==undefined && (!Number.isSafeInteger(Number(before))||Number(before)<1)) return reply.code(400).send({error:'无效的分页游标'});
    const rows = (await app.db.query(`SELECT id::text AS id, worker AS role,COALESCE(NULLIF(detail,''),summary) AS text,is_error AS error
      FROM activity WHERE exploration_id=$1 AND exploration_activity_readable($1,node_id,metadata) AND ($2::bigint IS NULL OR id<$2) ORDER BY activity.id DESC LIMIT 101`,[task.exploration_id,before??null])).rows;
    const messages = rows.slice(0,100).reverse();
    return {messages,next_before:rows.length>100?messages[0]!.id:null};
  });

  // PATCH /api/tasks/:id — 名称/置顶等元数据。
  app.patch("/api/tasks/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const task = await tasks().getTask(id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b["name"] === "string") {
      await app.db.query(`UPDATE tasks SET name=$2 WHERE id=$1`, [id, b["name"]]);
    }
    if (typeof b["pinned"] === "boolean") {
      await app.db.query(`UPDATE tasks SET pinned_at=$2 WHERE id=$1`, [id, b["pinned"] ? new Date() : null]);
    }
    return serializeTask((await tasks().getTask(id))!);
  });

  async function lifecycle(id:number,action:'pause'|'resume'|'finish',entry?:string) {
    if(action==='finish' && !goalHistory(app.dataDir,id).some(m=>m.id===entry && m.role==='assistant' && !m.error))
      throw Object.assign(new Error('请先选择 PI 会话中的验收回复'),{statusCode:409});
    await controlGoal(app.db,id,action,entry);
    return serializeTask((await tasks().getTask(id))!);
  }
  for (const [route,action] of [['start','resume'],['pause','pause'],['resume','resume'],['stop','finish']] as const)
    app.post('/api/tasks/:id/'+route,async req=>lifecycle(Number((req.params as {id:string}).id),action,(req.body as {entry?:string})?.entry));
  app.post('/api/tasks/:id/control',async(req,reply)=>{
    const b=req.body as {action?:string;entry?:string};
    if (b?.action!=='pause' && b?.action!=='resume' && b?.action!=='finish') return reply.code(400).send({error:'无效操作'});
    return lifecycle(Number((req.params as {id:string}).id),b.action,b.entry);
  });
  app.post('/api/tasks/:id/chat',{schema:{body:{type:'object',additionalProperties:false,required:['message','request_id'],
    properties:{message:{type:'string',minLength:1,maxLength:64000,pattern:'\\S'},request_id:{type:'string',format:'uuid'}}}}},async req=>{
    const b=req.body as {message:string;request_id:string};
    const result=await sendGoalMessage(app.db,app.dataDir,resolveModel,Number((req.params as {id:string}).id),b.request_id,b.message);
    return {reply:result.text,entry:result.id};
  });
  app.get('/api/tasks/:id/requests/:key',{schema:{params:{type:'object',properties:{
    id:{type:'integer',minimum:1},key:{type:'string',format:'uuid'}}}}},async(req,reply)=>{
    const {id,key}=req.params as {id:number;key:string};
    const row=(await app.db.query(`SELECT r.reply_entry,r.failure,
      EXISTS(SELECT 1 FROM runtime_session_leases WHERE key='goal:'||r.task_id AND token::text=r.lease_token::text AND expires_at>now()) AS busy
      FROM pi_goal_turns r JOIN tasks t ON t.id=r.task_id WHERE r.task_id=$1 AND request_id=$2 AND t.deleted_at IS NULL`,[id,key])).rows[0];
    if(!row)return reply.code(404).send({error:'没有该请求的记录'});
    return {status:row.reply_entry?'completed':row.failure?'failed':row.busy?'running':'unknown',error:row.failure};
  });
  app.delete('/api/tasks/:id',async(req,reply)=>{
    const id=Number((req.params as {id:string}).id);
    const result=await app.db.query(`UPDATE tasks SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM runtime_session_leases WHERE key='goal:'||tasks.id AND expires_at>now()) RETURNING id`,[id]);
    if(!result.rowCount)return reply.code(409).send({error:'任务不存在或正在回复'});
    return {ok:true,id};
  });

  // POST /api/active — 当前打开的任务 id（前端任务页切换用）。
  app.post("/api/active", async (req, reply) => {
    const id = Number((req.body as { id?: unknown })?.["id"]);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "bad task id" });
    const task = await tasks().getTask(id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    await app.db.platform().setSetting("active_task", String(id));
    return { active: String(id) };
  });

}
