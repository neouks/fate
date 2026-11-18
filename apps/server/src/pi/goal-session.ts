import {findGoalBindings,goalResources,reviewTool} from './goal-resources.js';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {parseSkillBlock, SessionManager, type ToolDefinition} from '@earendil-works/pi-coding-agent';
import type {ModelSource} from '../agent/roles.js';
import type {Database} from '../db/index.js';
import type {ModelResolver} from '../engine/engine.js';
import {acquireSessionLease} from '../engine/session-lease.js';
import {AgentRunner} from './runner.js';

const conflict = (message: string) => Object.assign(new Error(message), {statusCode:409});
const directory = (root: string, id: number) => path.resolve(root, 'pi-goals', String(id));
export function goalHistory(root: string, id: number) {
  const cwd = directory(root,id);
  const filename = path.join(cwd,'session.jsonl');
  if (!existsSync(filename)) return [];
  return SessionManager.open(filename,undefined,cwd).getBranch().flatMap<{id:string;role:string;text:string;error:boolean;action?:string;tool_call_id?:string}>(entry => {
    if (entry.type !== 'message') return [];
    const m = entry.message;
    if (m.role === 'toolResult') return [{id:entry.id,role:m.toolName,action:'result',tool_call_id:m.toolCallId,
      text:m.content.flatMap(b=>b.type==='text'?[b.text]:[]).join('\n'),error:m.isError}];
    if (m.role !== 'assistant' && m.role !== 'user') return [];
    const error = m.role === 'assistant' && (m.stopReason === 'error' || m.stopReason === 'aborted');
    const text = typeof m.content === 'string' ? m.content : m.content.flatMap(b => b.type === 'text' ? [b.text] : []).join('\n');
    const calls=m.role==='assistant' ? m.content.flatMap((b,i)=>b.type==='toolCall'?[{
      id:entry.id+'-'+i,role:b.name,action:'call',tool_call_id:b.id,text:JSON.stringify(b.arguments),error:false}]:[]) : [];
    if (!text && !error) return calls;
    const skill=m.role==='user'?parseSkillBlock(text):null;
    return [...calls,{id:entry.id,role:m.role,...(skill?{action:'skill:'+skill.name}:{}),text:error && m.role==='assistant' ? m.errorMessage || text || '回复中断' : text,error}];
  });
}

export async function runGoalTurn(root: string, task: {id:number;goal:string;description:string},
  message: string, source: () => Promise<ModelSource>, signal: AbortSignal, lookup:(query:string)=>ReturnType<typeof findGoalBindings>) {
  const cwd = directory(root,task.id);
  await mkdir(cwd,{recursive:true});
  const options = async () => {
    const model = await source();
    return {...model,cwd,agentDir:path.join(cwd,'agent'),signal,maxDurationMs:120000,
      modelPolicy:model.modelPolicy && {...model.modelPolicy,retry:async()=>false}};
  };
  const material = JSON.stringify({goal:task.goal,material:task.description});
  const review: ToolDefinition = {...reviewTool,async execute(_id,_args,toolSignal) {
    const child = await AgentRunner.create({...await options(),signal:toolSignal?AbortSignal.any([signal,toolSignal]):signal,
      systemPrompt:'复核给定文本与目标的对应关系。引用原文说明缺项，只评价材料。',inMemory:true,toolAllowlist:[]});
    try {
      const result = await child.prompt(material);
      if (result.aborted || !result.lastAssistantText) throw new Error('材料复核未完成');
      return {content:[{type:'text',text:result.lastAssistantText}],details:{}};
    } finally { await child.dispose(); }
  }};
  const runner = await AgentRunner.create({...await options(),
    resumeSessionPath:path.join(cwd,'session.jsonl'),...goalResources(lookup),
    extensionFactories:[pi=>pi.registerTool(review)],maxTurns:4,
    systemPrompt:'围绕用户的目标和提供的材料回答。需要独立复核原始材料时可以调用 review_material。由用户验收结果。'});
  try {
    await runner.appendContextOnce('goal-material','用户提供的目标与原始材料\n'+material);
    const result = await runner.prompt(message);
    if (result.aborted || result.stopReason!=='completed' || !result.lastAssistantText) throw new Error('本轮未产生完整回复');
  } finally { await runner.dispose(); }
  const entry = goalHistory(root,task.id).at(-1);
  if (!entry || entry.role!=='assistant' || entry.error) throw new Error('无法确认 PI 回复已保存');
  return entry;
}

export async function sendGoalMessage(db: Database, root: string, resolveModel: ModelResolver,
  id: number, requestID: string, message: string) {
  const controller = new AbortController();
  const lease = await acquireSessionLease(db,'goal:'+id,controller);
  let claimed = false;
  try {
    const digest = createHash('sha256').update(message).digest('hex');
    const previous = (await db.query('SELECT message_hash,reply_entry,failure FROM pi_goal_turns WHERE task_id=$1 AND request_id=$2',[id,requestID])).rows[0];
    const task = await db.tasks().getTask(id);
    if (!task) throw Object.assign(new Error('任务不存在'),{statusCode:404});
    if (previous) {
      if (previous.message_hash!==digest) throw conflict('相同请求 ID 的内容不同');
      if (previous.failure) throw conflict(String(previous.failure));
      const entry = goalHistory(root,id).find(e=>e.id===previous.reply_entry);
      if (!entry) throw conflict('该请求没有已确认的回复，请查看会话原文');
      return entry;
    }
    await db.transaction(async tx=>{
      const admitted = await tx.query(`UPDATE tasks SET status='running',first_run_at=COALESCE(first_run_at,now())
        WHERE id=$1 AND exploration_id IS NULL AND status IN ('created','running') AND NOT paused AND deleted_at IS NULL RETURNING id`,[id]);
      if (!admitted.rowCount) throw conflict('任务只读或已暂停');
      await lease.assert(tx);
      await tx.query('INSERT INTO pi_goal_turns(task_id,request_id,message_hash,lease_token) VALUES($1,$2,$3,$4)',[id,requestID,digest,lease.token]);
    });
    claimed = true;
    const entry = await runGoalTurn(root,task,message,()=>resolveModel(id,'mainagent'),controller.signal,query=>findGoalBindings(db,query));
    await db.transaction(async tx=>{
      await lease.assert(tx);
      await tx.query('UPDATE pi_goal_turns SET reply_entry=$3 WHERE task_id=$1 AND request_id=$2',[id,requestID,entry.id]);
    });
    return entry;
  } catch (error) {
    if (claimed) {
      await db.query('UPDATE pi_goal_turns SET failure=$3 WHERE task_id=$1 AND request_id=$2 AND reply_entry IS NULL',
        [id,requestID,(error instanceof Error ? error.message : String(error)).slice(0,2000)]);
    }
    throw error;
  } finally { await lease.release(); }
}

export async function controlGoal(db:Database,id:number,action:'pause'|'resume'|'finish',entry?:string) {
  return db.transaction(async tx=>{
    const task = (await tx.query('SELECT status,exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rows[0];
    if (!task) throw Object.assign(new Error('任务不存在'),{statusCode:404});
    if (task.exploration_id!==null) throw conflict('历史任务仅供回读');
    if (!['created','running','paused'].includes(String(task.status))) throw conflict('任务已结束');
    if (action==='pause') {
      await tx.query("UPDATE tasks SET paused=true,status='paused' WHERE id=$1",[id]);
      await tx.query("UPDATE runtime_session_leases SET stop_requested=true WHERE key=$1",['goal:'+id]);
      return 'paused';
    }
    if (action==='resume') {
      await tx.query("UPDATE tasks SET paused=false,status='running' WHERE id=$1",[id]);
      return 'running';
    }
    if (!entry || !(await tx.query('SELECT 1 FROM pi_goal_turns WHERE task_id=$1 AND reply_entry=$2',[id,entry])).rowCount)
      throw conflict('请在会话中选择一条已保存的回复进行验收');
    if ((await tx.query('SELECT 1 FROM runtime_session_leases WHERE key=$1 AND expires_at>now()',['goal:'+id])).rowCount)
      throw conflict('请等待当前回复结束');
    await tx.query("UPDATE tasks SET accepted_entry=$2,paused=false,status='done',completed_at=now() WHERE id=$1",[id,entry]);
    return 'done';
  });
}
