import type {FastifyInstance} from 'fastify';
import path from 'node:path';
import {stat,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {taskSession} from './task-session.js';
import {conversationReadable} from '../activity-stream.js';
import {readSessionPreferences,saveSessionPreferences,preferencePatch,thinkingOptions,type PreferenceScope} from '../../db/session-preferences.js';
import {makeModelResolver,resolveModelProfiles} from '../../pi/modelResolver.js';
import {systemRolePrompt} from '../../agent/prompts.js';
import {mainSessionFile,workerSessionFile} from '../../agent/roles.js';
import {plannerSessionFile,lockPlannerSession,PLANNER_COMPACTION_RULES} from '../../agent/planner-memory.js';
import {roleContextPolicy} from '../../agent/context-policy.js';
import {CONTEXT_RETENTION_RULES} from '../../agent/context-needs.js';
import {syncPlannerHistory} from '../../db/planner-history.js';
import {preparePlannerActiveSession,recoverPlannerActiveSession,type PlannerActiveSession} from '../../agent/planner-active-session.js';
import {prepareAgentRunSession,acquireNativeWriter,type NativeRunSession} from '../../agent/native-run-session.js';
import {acquireSessionLease} from '../../engine/session-lease.js';
import {createTrackedRunner} from '../../engine/runtime-config.js';
import type {AgentRunner} from '../../pi/runner.js';

type Target=PreferenceScope&{role:string;expID:number;file:string;profileID?:number;intentID?:number;mainSeg?:number;key:string};
export function registerSessionControls(app:FastifyInstance){
 const jobs=new Map<string,{controller:AbortController;runner?:AgentRunner}>();
 const resolve=makeModelResolver(app.db);
 async function target(taskID:number|undefined,id:number|undefined,key?:string):Promise<Target>{
  if(id!==undefined){
   if(!Number.isSafeInteger(id)||id<1||!await conversationReadable(app.db,id))throw Object.assign(new Error('会话不存在'),{statusCode:404});
   const row=(await app.db.query('SELECT c.*,t.exploration_id FROM conversations c LEFT JOIN tasks t ON t.id=c.task_id WHERE c.id=$1',[id])).rows[0]!;
   return {conversationID:id,taskID:Number(row.task_id)||0,expID:Number(row.exploration_id)||0,role:String(row.agent_key),profileID:Number(row.llm_profile_id)||undefined,
    file:path.join(app.dataDir,'conversations',String(id),'session.jsonl'),key:`conversation:${id}`};
  }
  const s=await taskSession(app.db,taskID!,key??'');
  const task=(await app.db.tasks().getTask(taskID!))!;
  const n=Number(key?.split(':')[1]),expID=task.exploration_id;
  return {taskID,sessionKey:key,role:s.role,expID,key:`task:${taskID}:${key}`,
   ...(key?.startsWith('main:')?{mainSeg:n}:key?.startsWith('intent:')?{intentID:n}:{}),
   file:key==='plan'?plannerSessionFile(app.dataDir,expID):key?.startsWith('main:')?mainSessionFile(app.dataDir,expID,n):workerSessionFile(app.dataDir,expID,n)};
 }
 async function writable(t:Target){
  if(t.conversationID)await app.engine.conversations.assertWritable(t.conversationID);
  if(t.mainSeg!==undefined){
   const last=await app.db.query('SELECT COALESCE(MAX(main_seg),0) n FROM activity WHERE exploration_id=$1',[t.expID]);
   if(t.mainSeg<Number(last.rows[0]?.n??0))throw Object.assign(new Error('历史主 Agent 会话只读'),{statusCode:409});
  }
 }
 async function settings(t:Target){
  const resolved=await resolveModelProfiles(app.db,t.taskID??0,t.role,t);
  const profile=resolved.profiles[0];
  const exists=await stat(t.file).then(s=>s.size>0,()=>false);
  return {...await readSessionPreferences(app.db,t),thinking_options:profile?thinkingOptions(profile):[],compacting:jobs.has(t.key),can_compact:exists,effective:'next_run'};
 }
 async function compact(t:Target){
  await writable(t);
  if(jobs.has(t.key))throw Object.assign(new Error('正在压缩此会话'),{statusCode:409});
  if(!await stat(t.file).then(s=>s.size>0,()=>false))throw Object.assign(new Error('尚无可压缩的会话历史'),{statusCode:409});
  const busy=await app.db.query(`SELECT 1 FROM runtime_role_configs WHERE finished_at IS NULL AND expires_at>now()
   AND (($1::bigint IS NOT NULL AND conversation_id=$1) OR ($1::bigint IS NULL AND task_id=$2 AND conversation_id IS NULL AND
    (($3::bigint IS NOT NULL AND (effective->'usage_scope'->>'intentID')::bigint=$3) OR
     ($4::integer IS NOT NULL AND role='mainagent' AND (effective->'usage_scope'->>'mainSegment')::integer=$4) OR
     ($3::bigint IS NULL AND $4::integer IS NULL AND role IN ('planner','goals'))))) LIMIT 1`,[t.conversationID??null,t.taskID??0,t.intentID??null,t.mainSeg??null]);
  if(busy.rowCount)throw Object.assign(new Error('请等待当前回复完成后再压缩'),{statusCode:409});
  const job:{controller:AbortController;runner?:AgentRunner}={controller:new AbortController()};jobs.set(t.key,job);
  let lease:Awaited<ReturnType<typeof acquireSessionLease>>|undefined,gate:Awaited<ReturnType<typeof acquireSessionLease>>|undefined,unlock:(()=>Promise<void>)|undefined,releaseWriter:(()=>Promise<void>)|undefined;
  let active:PlannerActiveSession|NativeRunSession|undefined;
  try{
   const signal=job.controller.signal;
   gate=await acquireSessionLease(app.db,`compact:${t.key}`,job.controller);
   if(t.conversationID)await app.db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(4200000004)');
    if((await tx.query("SELECT 1 FROM conversation_runs WHERE conversation_id=$1 AND status IN ('queued','running') LIMIT 1",[t.conversationID])).rowCount)
     throw Object.assign(new Error('请等待当前回复及排队消息完成后再压缩'),{statusCode:409});
   });
   if(t.conversationID||t.mainSeg!==undefined)lease=await acquireSessionLease(app.db,t.conversationID?t.key:`main:${t.taskID}:${t.mainSeg}`,job.controller);
   if(t.sessionKey==='plan'){
    unlock=await lockPlannerSession(app.db,t.expID,signal);
    releaseWriter=await acquireNativeWriter(app.db,t.file,signal);
    await recoverPlannerActiveSession(t.file);
    active=await preparePlannerActiveSession(app.db,await syncPlannerHistory(app.db,t.taskID!,t.expID,t.file,signal),t.file);
   }else active=await prepareAgentRunSession(app.db,{taskID:t.taskID??0,expID:t.expID,role:t.role,conversationID:t.conversationID,intentID:t.intentID,mainSeg:t.mainSeg},t.file,signal);
   const source=await resolve(t.taskID??0,t.role,t);
   const contextPolicy=!t.conversationID&&(t.role==='planner'||t.role==='worker')
    ?roleContextPolicy(t.role,source.model.contextWindow,await app.db.platform().getSetting(`${t.role}_context_budget_tokens`)):undefined;
   const cwd=t.conversationID?path.dirname(t.file):path.join(app.dataDir,'tasks',String(t.taskID));await mkdir(cwd,{recursive:true});
   job.runner=await createTrackedRunner(app.db,t.taskID??0,t.role,{...source,cwd,agentDir:path.join(app.dataDir,'pi-agent'),
    systemPrompt:await systemRolePrompt(app.db,t.role),toolAllowlist:[],customTools:[],resumeSessionPath:active.file,canonicalSessionPath:t.file,
    contextPolicy,compactionSettings:contextPolicy?.compactionSettings,summaryTargetTokens:contextPolicy?.summaryTargetTokens,
    compactionInstructions:contextPolicy?[t.role==='planner'?PLANNER_COMPACTION_RULES:'',CONTEXT_RETENTION_RULES].filter(Boolean).join('\n'):undefined,
    flushNativeSession:active.flush,onSessionCompacted:async manager=>{
     if(t.sessionKey==='plan')await active!.rebase(manager,()=>syncPlannerHistory(app.db,t.taskID!,t.expID,t.file,signal));
     else await (active as NativeRunSession).compact(manager);
    },signal,turnID:randomUUID(),intentID:t.intentID,mainSegment:t.mainSeg},t.conversationID);
   await gate.assert();await lease?.assert();await job.runner.compact();await active.flush();
   if(signal.aborted)throw Object.assign(new Error('已停止压缩，原始会话已保留'),{statusCode:409});
   if(!job.runner.compactionDiagnostics.completed)throw Object.assign(new Error('没有生成压缩摘要，原始会话已保留'),{statusCode:409});
   return {status:'compacted',...job.runner.compactionDiagnostics};
  }catch(error){
   if(error instanceof Error&&/too small|nothing to compact|already compacted/i.test(error.message))throw Object.assign(new Error('当前会话无需压缩，历史内容仍在 Pi 的近期保留范围内'),{statusCode:409});
   throw error;
  }finally{
   try{await job.runner?.dispose();}finally{try{await active?.close();}finally{try{await releaseWriter?.();}finally{try{await unlock?.();}finally{try{await lease?.release();}finally{try{await gate?.release();}finally{jobs.delete(t.key);}}}}}}
  }
 }
 for(const task of [false,true]){
  const base=task?'/api/tasks/:id/session-controls':'/api/conversations/:id/controls';
  const getTarget=(req:any)=>target(task?Number(req.params.id):undefined,task?undefined:Number(req.params.id),String(req.query?.session??req.body?.session??''));
  app.get(base,async req=>settings(await getTarget(req)));
  app.patch(base,async req=>{const t=await getTarget(req);await writable(t);const patch=preferencePatch(req.body);await saveSessionPreferences(app.db,t,patch);return settings(t);});
  app.post(base+'/compact',async req=>compact(await getTarget(req)));
  app.post(base+'/compact/stop',async req=>{const t=await getTarget(req);await writable(t);const job=jobs.get(t.key);job?.controller.abort('user');await job?.runner?.abort();return {status:job?'stopping':'idle'};});
 }
 app.addHook('onClose',async()=>{for(const job of jobs.values()){job.controller.abort('shutdown');await job.runner?.abort();}});
}
