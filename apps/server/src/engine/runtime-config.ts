import {waitForHumanInput,interruptHumanInputs,reconcileHumanInputs} from '../db/human-input.js';
import {acquireRuntimeResources,resourceScope,type RuntimeResourceLease} from './runtime-resources.js';
import {prepareToolLoading} from '../agent/tool-loading.js';
import {assertToolBinding} from '../agent/tool-registry.js';
import {skillReadAccess} from '../agent/resources.js';
import {platformPolicy,validatePlatformRunner} from '../pi/platform-policy.js';
import {resolveRolePrompt,hostProtocol} from '../agent/prompts.js';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import type {Database} from '../db/index.js';
import {AgentRunner,type AgentRunnerOptions} from '../pi/runner.js';
import {resolveModelProfiles} from '../pi/modelResolver.js';
import {registerNativeActivityRun} from './native-activity-recovery.js';
import { trackWorkspaceFileWrites } from '../pi/workspace-file-changes.js';
import { lockTaskWorkspace } from '../db/task-workspace-lock.js';
import {readSessionPreferences,applySessionTools} from '../db/session-preferences.js';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function configuredRole(db:Database,taskID:number,role:string,conversationID?:number,sessionKey?:string){
 const agent=await db.platform().getAgentByKey(role);
 const prompt=await resolveRolePrompt(db,role);
 const tools=(await db.query('SELECT key,enabled,description,exec FROM tools WHERE agents ? $1 ORDER BY key',[role])).rows;
 const resources=(await db.query(`SELECT v.resource_kind,v.resource_id,v.mcp_tool_name,v.enabled,m.enabled AS server_enabled,m.transport,m.url,m.command,m.args,m.env,m.insecure
  FROM agent_visibility v JOIN agents a ON a.id=v.agent_id LEFT JOIN mcp_servers m ON m.id=v.resource_id
  WHERE a.key=$1 ORDER BY v.resource_id,v.mcp_tool_name`,[role])).rows;
 const skills=(await db.query('SELECT v.skill_name,v.enabled FROM agent_skill_visibility v JOIN agents a ON a.id=v.agent_id WHERE a.key=$1 ORDER BY v.skill_name',[role])).rows;
 const conv=conversationID?(await db.query('SELECT llm_profile_id FROM conversations WHERE id=$1',[conversationID])).rows[0]:undefined;
 const resolved=await resolveModelProfiles(db,taskID,role,{conversationID,profileID:Number(conv?.llm_profile_id)||undefined,sessionKey});
 return {planner_context_budget_tokens:role==='planner'?await db.platform().getSetting('planner_context_budget_tokens'):undefined,
  worker_context_budget_tokens:role==='worker'?await db.platform().getSetting('worker_context_budget_tokens'):undefined,
  platform_policy:await platformPolicy(db,role),enabled:agent?.enabled??true,prompt_source:prompt.source,prompt_version:prompt.version,agent_hash:digest(agent),prompt_hash:digest([prompt.template,hostProtocol(role)]),tools_hash:digest(tools),resources_hash:digest([resources,skills]),
  model_hash:digest(resolved.profiles),model:resolved.resolution};
}

/** Domain observability only: pi continues to own the session/tool loop. */
export async function createTrackedRunner(db:Database,taskID:number,role:string,options:AgentRunnerOptions,conversationID?:number){
 validatePlatformRunner(role,options,taskID);
 const scope={taskID,role,intentID:options.intentID,conversationID,mainSegment:options.mainSegment};
 options.resourceLease?.assert(resourceScope(db,scope));
 const ownsResource=!options.resourceLease;
 const resourceLease=options.resourceLease??await acquireRuntimeResources(db,scope,options.signal,
  ()=>options.onActivity?.({kind:'host_status',phase:'resource_wait',text:'正在等待执行资源；尚未加载模型会话或连接 MCP'}));
 try{return await createAdmittedRunner(db,taskID,role,{...options,resourceLease},conversationID,ownsResource);}
 catch(error){resourceLease.ready();if(ownsResource)resourceLease.release();throw error;}
}
async function createAdmittedRunner(db:Database,taskID:number,role:string,options:AgentRunnerOptions&{resourceLease:RuntimeResourceLease},conversationID:number|undefined,ownsResource:boolean){
 await options.resourceLease.beginInitialization(options.signal);
 options.signal?.throwIfAborted();
 const preferences=await readSessionPreferences(db,{taskID,conversationID,sessionKey:options.intentID?`intent:${options.intentID}`:options.mainSegment!==undefined?`main:${options.mainSegment}`:['planner','goals'].includes(role)?'plan':undefined});
 options={...options,...applySessionTools(options,preferences.tool_preset)};
 const configured=await configuredRole(db,taskID,role,conversationID,options.intentID?`intent:${options.intentID}`:options.mainSegment!==undefined?`main:${options.mainSegment}`:undefined),id=randomUUID();
 if(options.nativeActivity&&!options.inMemory)options={...options,nativeActivityRuntime:id};
 if(options.mcpEntries?.length){
  const servers=await db.query('SELECT id,name FROM mcp_servers WHERE name=ANY($1::text[])',[options.mcpEntries.map(e=>e.name)]);
  options={...options,resourceServers:new Map(servers.rows.map(r=>[String(r.name),Number(r.id)]))};
 }
 if(taskID>0 && !conversationID && options.toolAllowlist?.some(name=>['write','edit','bash','shell_open'].includes(name))){
  const note='工作区文件：把可丢弃的中间文件放在当前工作区的 tmp/。供后续执行引用的脚本、产出及证据不要放进 tmp/、.tmp/ 或 temp/。';
  if(options.contextLayout)options={...options,taskContext:[options.taskContext,note].filter(Boolean).join('\n')};
  else if(options.systemPrompt)options={...options,systemPrompt:options.systemPrompt+'\n\n'+note};
 }
 if (options.nativeActivity && options.turnID && (conversationID || taskID > 0)) {
  options = { ...options, writeWorkspaceFile: trackWorkspaceFileWrites(db, {
   scope: { kind: conversationID ? 'conversation' : 'task', id: conversationID ?? taskID, turnID: options.turnID },
   taskID, intentID: options.intentID, cwd: options.cwd, dataDir: path.dirname(options.agentDir),
  }) };
 }
 options={...options,...await prepareToolLoading(db,role,options,configured.platform_policy.builtinLoading==='direct',configured.platform_policy.fallback)};
 options.modelPolicy?.setRuntimeID?.(id);
 options.modelPolicy?.setScope?.({intentID:options.intentID,mainSegment:options.mainSegment,turnID:options.turnID});
 const controller=new AbortController();
 const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
 const effective={resource_reservation:{id:options.resourceLease.id,bytes:options.resourceLease.bytes,lane:options.resourceLease.lane},usage_scope:{intentID:options.intentID,mainSegment:options.mainSegment,turnID:options.turnID},goals_phase:options.goalsPhase,tool_loading:options.toolLoading,context_layout:options.contextLayout??'legacy',collaboration_policy:'blackboard-v1',platform_policy:configured.platform_policy,max_turns:options.maxTurns??null,max_duration_ms:options.maxDurationMs??null,wrapup_max_turns:options.maxWrapupTurns??null,
  model:configured.model,model_route:{provider:options.model.provider,id:options.model.id},streaming:options.streaming!==false,
  prompt_hash:digest(options.systemPrompt??''),tools:options.toolAllowlist??[],skills:options.allowedSkills??[],mcp:(options.mcpEntries??[]).map(e=>e.name)};
 const guard=options.guard;
  const register = async (tx: Database) => {
   if(taskID>0)await lockTaskWorkspace(tx,taskID);
   await tx.query('INSERT INTO runtime_role_configs(id,task_id,conversation_id,role,configured,effective,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,now()+interval \'20 seconds\')',[id,taskID||null,conversationID??null,role,JSON.stringify(configured),JSON.stringify(effective)]);
  };
  if(taskID>0)await db.transaction(register);
  else await register(db);
 let renewing=false;
 const heartbeat=setInterval(()=>{if(renewing)return;renewing=true;void db.control().query("UPDATE runtime_role_configs SET expires_at=now()+interval '20 seconds' WHERE id=$1 AND finished_at IS NULL AND expires_at>clock_timestamp() RETURNING id",[id]).then(r=>{if(!r.rowCount)controller.abort('执行器已过期');}).catch(()=>{}).finally(()=>{renewing=false;});},5000);heartbeat.unref();
 let runner!:AgentRunner;
 try{
 runner=await AgentRunner.create({...options,signal,
  humanInput:taskID>0&&!conversationID&&['worker','planner','mainagent'].includes(role)?(prompt,signal)=>{options.resourceLease.ready();return waitForHumanInput(db,{taskID,runtimeID:id,role,turnID:options.turnID??id,intentID:options.intentID,mainSegment:options.mainSegment},prompt,signal);}:undefined,
  liveAllowedSkills:options.skillsDir?async()=>{const rows=(await db.query('SELECT v.skill_name FROM agent_skill_visibility v JOIN agents a ON a.id=v.agent_id WHERE a.key=$1 AND a.enabled AND v.enabled',[role])).rows;return (options.allowedSkills??[]).filter(name=>rows.some(row=>row.skill_name===name));}:undefined,platform:{role,taskID,conversationID,policy:configured.platform_policy},
  onRequestSize:async (size,purpose)=>{
   await options.onRequestSize?.(size,purpose);
   const updated=await db.query(`UPDATE runtime_role_configs SET effective=effective||jsonb_build_object(
    'last_request_size',$2::jsonb,'first_request_size',COALESCE(effective->'first_request_size',$2::jsonb),
    'request_count',COALESCE((effective->>'request_count')::int,0)+1,
    'last_request_purpose',$3::text,'active_tools',$4::jsonb,'prompt_diagnostics',$5::jsonb,
    'compaction_request_count',COALESCE((effective->>'compaction_request_count')::int,0)+CASE WHEN $3='compaction' THEN 1 ELSE 0 END) WHERE id=$1 AND finished_at IS NULL AND expires_at>clock_timestamp() RETURNING id`,[id,JSON.stringify(size),purpose??'conversation',JSON.stringify(runner.activeToolNames),JSON.stringify(runner.promptDiagnostics)]);
   if(!updated.rowCount){controller.abort('执行器已过期');throw new Error('执行器已过期，禁止发起模型请求');}
  },
  guard:async g=>{
   if(!(await db.query('SELECT id FROM runtime_role_configs WHERE id=$1 AND finished_at IS NULL AND expires_at>clock_timestamp()',[id])).rowCount){controller.abort('执行器已过期');return {block:true,reason:'执行器已过期'};}
   const agent=(await db.query<{enabled:boolean;id:string;interactive_shell:boolean}>('SELECT enabled,id,interactive_shell FROM agents WHERE key=$1',[role])).rows[0];
   if(g.toolName.startsWith('shell_')&&agent?.interactive_shell!==true)return {block:true,reason:'交互终端已禁用'};
   if(agent?.enabled===false)return {block:true,reason:'角色已禁用'};
   try{await assertToolBinding(db,role,g.toolName);}catch{return {block:true,reason:'工具或规范入口已禁用或解除角色绑定'};}
   const tool=(await db.query('SELECT enabled,agents FROM tools WHERE key=$1',[g.toolName])).rows[0];
   if(tool&&(tool.enabled===false||!Array.isArray(tool.agents)||!tool.agents.includes(role)))return {block:true,reason:'工具已禁用或解除角色绑定'};
   const skillAccess=g.toolName==='read'&&typeof g.args.path==='string'
    ? await skillReadAccess(db,agent?.id,options,g.args.path) : undefined;
   if(skillAccess==='disabled')return {block:true,reason:'Skill 已禁用或解除角色绑定'};
   return guard?.({...g,skillDocument:skillAccess==='document'});
  },
  discoveryGuard:async name=>{
   if(name.startsWith('shell_')&&!(await db.query('SELECT 1 FROM agents WHERE key=$1 AND enabled AND interactive_shell',[role])).rowCount)
    throw new Error('交互终端已禁用');
   await assertToolBinding(db,role,name);
   await options.discoveryGuard?.(name);
  },
  mcpGuard:async(server,method,tool)=>{
   if(method.startsWith('notifications/')||method==='ping')return;
   const discovery=['initialize','tools/list'].includes(method);
   const allowed=await db.query(`SELECT 1 FROM mcp_servers m JOIN agents a ON a.key=$1
    WHERE m.name=$2 AND m.enabled AND a.enabled
    AND NOT EXISTS(SELECT 1 FROM agent_visibility v WHERE v.agent_id=a.id AND v.resource_kind='mcp' AND v.resource_id=m.id AND v.mcp_tool_name='' AND NOT v.enabled)
    AND (
      ($4::boolean AND EXISTS(SELECT 1 FROM agent_visibility v WHERE v.agent_id=a.id AND v.resource_kind='mcp' AND v.resource_id=m.id AND v.enabled))
      OR ($5::boolean AND EXISTS(SELECT 1 FROM agent_visibility v WHERE v.agent_id=a.id AND v.resource_kind='mcp' AND v.resource_id=m.id AND v.enabled AND v.mcp_tool_name=$3))
      OR (EXISTS(SELECT 1 FROM agent_visibility v WHERE v.agent_id=a.id AND v.resource_kind='mcp' AND v.resource_id=m.id AND v.enabled AND v.mcp_tool_name='')
       AND NOT EXISTS(SELECT 1 FROM agent_visibility v WHERE v.agent_id=a.id AND v.resource_kind='mcp' AND v.resource_id=m.id AND NOT v.enabled AND v.mcp_tool_name=$3)))`,[role,server,tool??'',discovery,method==='tools/call']);
   if(!allowed.rowCount)throw new Error('MCP 服务或工具已禁用或解除角色绑定');
   await options.mcpGuard?.(server,method,tool);
  }});
 Object.assign(effective,{context_policy:options.contextPolicy,active_tools:runner.activeToolNames,prompt_diagnostics:runner.promptDiagnostics,prompt_source:configured.prompt_source,prompt_version:configured.prompt_version});
  await db.query('UPDATE runtime_role_configs SET effective=$2::jsonb WHERE id=$1',[id,JSON.stringify(effective)]);
  if(options.nativeActivityRuntime)await registerNativeActivityRun(db,id,runner,options.nativeActivity!,options.flushNativeSession);
 }
 catch(error){clearInterval(heartbeat);controller.abort();try{await runner?.dispose();}finally{await interruptHumanInputs(db,id);await db.query('UPDATE runtime_role_configs SET finished_at=now(),expires_at=now() WHERE id=$1',[id]);}throw error;}
 options.resourceLease.ready();
 const dispose=runner.dispose.bind(runner);
 const prompt=runner.prompt.bind(runner);
 runner.prompt=async(...args:Parameters<typeof runner.prompt>)=>{
  const task=taskID?await db.tasks().getTask(taskID):null;
  await options.onActivity?.({kind:'run_metadata',runtimeID:id,role,mode:conversationID?'conversation':task?.execution_mode??'unknown',startedAt:new Date().toISOString()});
  return prompt(...args);
 };
 let disposing:Promise<void>|undefined;
 runner.dispose=()=>disposing??=(async()=>{clearInterval(heartbeat);try{await dispose();
  await interruptHumanInputs(db,id);
  if(options.nativeActivityRuntime&&runner.nativeActivitiesAcknowledged){
   await options.flushNativeSession?.();
   await db.query('UPDATE native_activity_runs SET completed=true,last_error=NULL,updated_at=now() WHERE runtime_id=$1',[id]);
  }
 }finally{await db.query("UPDATE runtime_role_configs SET finished_at=COALESCE(finished_at,now()),expires_at=LEAST(expires_at,now()),effective=effective||jsonb_build_object('compaction',$2::jsonb,'activity_delivery',$3::jsonb,'native_archive',$4::jsonb,'native_run_history',$5::jsonb) WHERE id=$1",[id,JSON.stringify(runner.compactionDiagnostics),JSON.stringify(runner.activityDiagnostics),JSON.stringify(options.archiveDiagnostics?.()??null),JSON.stringify(runner.runHistoryDiagnostics??null)]);}})().finally(()=>{if(ownsResource)options.resourceLease.release();});
 return runner;
}

/** Reconcile a dead process without declaring success or inventing token usage.
 * Heartbeats and this update serialize on the runtime row; an expired runtime
 * cannot revive itself. Legacy unlinked attempts remain unknown, never guessed. */
export async function recoverExpiredRuntimes(db:Database) {
 return db.transaction(async tx=>{
  const expired=await tx.query(`UPDATE runtime_role_configs SET finished_at=now(),
   effective=effective||'{"stop_reason":"executor_expired","recovered":true}'::jsonb
   WHERE finished_at IS NULL AND expires_at<=clock_timestamp() RETURNING id`);
  const attempts=await tx.query(`UPDATE llm_request_attempts a SET status='aborted',finished_at=now(),
   error='执行器失联或进程退出；请求已中断，用量以计量记录为准',usage=usage||jsonb_build_object('unavailable',COALESCE(usage->>'_quality','unknown') NOT IN ('complete','not_sent'))
   WHERE a.status='running' AND EXISTS(SELECT 1 FROM runtime_role_configs r WHERE r.id=a.runtime_id AND r.finished_at IS NOT NULL)
   RETURNING a.id`);
  await reconcileHumanInputs(tx);
  return {runtimes:expired.rowCount??0,requests:attempts.rowCount??0};
 });
}

export async function runtimeConfiguration(db:Database,scope:{taskID?:number;conversationID?:number}){
 const rows=(await db.query(`SELECT * FROM runtime_role_configs WHERE ${scope.conversationID?'conversation_id':'task_id'}=$1 AND finished_at IS NULL AND expires_at>now() ORDER BY started_at`,[scope.conversationID??scope.taskID])).rows;
 const active=[];
 for(const row of rows){
  const usage=(row.effective as {usage_scope?:{intentID?:number;mainSegment?:number}})?.usage_scope;
  const sessionKey=usage?.intentID?`intent:${usage.intentID}`:usage?.mainSegment!==undefined?`main:${usage.mainSegment}`:undefined;
  const current=await configuredRole(db,Number(row.task_id)||0,String(row.role),Number(row.conversation_id)||undefined,sessionKey),before=row.configured as Record<string,unknown>;
  const changed=Object.keys(current).filter(key=>key!=='model'&&JSON.stringify(current[key as keyof typeof current])!==JSON.stringify(before[key]));
  active.push({id:row.id,role:row.role,started_at:row.started_at,effective:row.effective,pending:changed.length?{changed_fields:changed,configuration:current,applies:'next_session'}:null});
 }
 const task=scope.taskID?await db.tasks().getTask(scope.taskID):null;
 return {active,configured:{workers:await db.platform().workers(),plan_heartbeat_seconds:task?.plan_heartbeat_seconds??null},application:{disabled_and_authorization:'next_tool_boundary',workers:'next_claim',heartbeat:'next_planner_round',model_prompt_tools:'next_session'}};
}
