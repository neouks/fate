import {ACTIVE_ROLES} from '../../agent/tool-registry.js';
import {toolLoadingSettingKey} from '../../agent/tool-loading-preferences.js';
import {roleSupportsMcp} from '../../agent/resource-policy.js';
import type {FastifyInstance} from 'fastify';
import type {Agent} from '../../db/platform.js';
import type {Database} from '../../db/index.js';
import {assertActiveRole} from '../../agent/retired-roles.js';
import {resolveRolePrompt, PROMPT_VERSION, hostProtocol, MAIN_WRAPUP, PLANNER_WRAPUP, WORKER_WRAPUP, PLANNER_TASK_TIMEOUT_WRAPUP, WORKER_TASK_TIMEOUT_WRAPUP} from '../../agent/prompts.js';

const fail = (statusCode:number,message:string) => Object.assign(new Error(message),{statusCode});
export function agentDTO(a:Agent) {
  // Keep camelCase fields for old clients; the settings UI uses the snake_case contract.
  return {...a,id:String(a.id),mcp_supported:roleSupportsMcp(a.key),deletable:!a.builtin&&!ACTIVE_ROLES.some(role=>role===a.key),llm_profile_id:a.llmProfileID,max_turns:a.maxTurns,run_seconds:a.runSeconds,
    web_search:a.webSearch,interactive_shell:a.interactiveShell,trigger_run_mode:a.triggerRunMode,
    trigger_merge_mode:a.triggerMergeMode,trigger_max_parallel:a.triggerMaxParallel};
}
async function requireAgent(db:Database,key:string) {
  assertActiveRole(key);
  const a=await db.platform().getAgentByKey(key);
  if(!a)throw fail(404,'Agent 不存在或已删除');
  return a;
}
async function versions(db:Database,id:number) {
  return (await db.query('SELECT version,created_at AS ts,COALESCE(note,\'\') AS note,template_text FROM agent_prompts WHERE agent_id=$1 ORDER BY version DESC',[id])).rows;
}
async function bindings(db:Database,id:number,key:string) {
  const mcp=await db.query("SELECT resource_id FROM agent_visibility WHERE agent_id=$1 AND resource_kind='mcp' AND mcp_tool_name='' AND enabled",[id]);
  const skill=await db.query('SELECT skill_name FROM agent_skill_visibility WHERE agent_id=$1 AND enabled',[id]);
  return {mcp:roleSupportsMcp(key)?mcp.rows.map(r=>Number(r.resource_id)):[],skill:skill.rows.map(r=>String(r.skill_name))};
}
export function registerAgentManagementRoutes(app:FastifyInstance) {
  app.get('/api/agents',async()=>{
    const agents=await app.db.platform().listAgents();
    const counts=(await app.db.query(`SELECT a.key,
      (SELECT count(*) FROM agent_visibility v WHERE v.agent_id=a.id AND v.resource_kind='mcp' AND v.mcp_tool_name='' AND v.enabled) AS mcp_count,
      (SELECT count(*) FROM agent_skill_visibility v WHERE v.agent_id=a.id AND v.enabled) AS skill_count,
      (SELECT count(*) FROM tools t WHERE t.agents ? a.key AND t.enabled) AS tool_count FROM agents a`)).rows;
    return {agents:agents.map(a=>{const c=counts.find(r=>r.key===a.key);return {...agentDTO(a),mcp_count:roleSupportsMcp(a.key)?Number(c?.mcp_count??0):0,skill_count:Number(c?.skill_count??0),tool_count:Number(c?.tool_count??0)};})};
  });
  app.post('/api/agents',async(req,reply)=>{
    const b=(req.body??{}) as Record<string,unknown>;
    const key=typeof b.key==='string'?b.key.trim():'';
    assertActiveRole(key);
    if(!/^[a-z][a-z0-9_]{0,63}$/.test(key))throw fail(400,'Key 须以小写字母开头，仅含小写字母、数字、下划线，最多 64 个字符');
    const name=typeof b.name==='string'?b.name.trim():'';
    if(!name||Array.from(name).length>120)throw fail(400,'名称不能为空且最多 120 个字符');
    if(b.description!==undefined&&typeof b.description!=='string')throw fail(400,'描述必须是文本');
    await app.db.transaction(async tx=>{
      // Serialize key reuse with deletion. Existing conversation identities must never be reassigned.
      await tx.query('SELECT pg_advisory_xact_lock(4200000004)');
      if((await tx.query('SELECT 1 FROM conversations WHERE agent_key=$1 LIMIT 1',[key])).rowCount)throw fail(409,'该 Key 已有历史会话，请使用新的 Key');
      try {await tx.query("INSERT INTO agents(key,name,description,role,builtin,enabled) VALUES($1,$2,$3,'assistant',false,true)",[key,name,b.description??'']);}
      catch(e){if((e as {code?:string}).code==='23505')throw fail(409,'该 Agent Key 已存在');throw e;}
    });
    return reply.code(201).send(agentDTO(await requireAgent(app.db,key)));
  });
  app.get('/api/agents/:key',async req=>{
    const key=(req.params as {key:string}).key,a=await requireAgent(app.db,key);
    const effective=await resolveRolePrompt(app.db,key),agent=agentDTO(a);
    return {...agent,agent,prompt:effective.template,variables:await app.db.platform().promptVars(a.id),versions:await versions(app.db,a.id),
      visibility:await bindings(app.db,a.id,a.key),llm_profiles:(await app.db.platform().listProfiles()).map(p=>({id:p.id,name:p.name,model:p.model,is_default:p.isDefault})),
      prompt_source:effective.source,effective_prompt:effective.template,builtin_version:PROMPT_VERSION,prompt_candidate:effective.candidate,host_protocol:hostProtocol(key),
      wrapup_prompt:a.wrapupPrompt,wrapup_max_turns:a.wrapupMaxTurns,wrapup_max_turns_default:3,
      wrapup_default:key==='planner'?PLANNER_WRAPUP:key==='worker'?WORKER_WRAPUP:key==='mainagent'?MAIN_WRAPUP:'',
      task_timeout_wrapup_supported:['planner','worker'].includes(key),task_timeout_wrapup_prompt:a.taskTimeoutWrapupPrompt,
      task_timeout_wrapup_max_turns:a.taskTimeoutWrapupMaxTurns,task_timeout_wrapup_max_turns_default:3,
      task_timeout_wrapup_default:key==='planner'?PLANNER_TASK_TIMEOUT_WRAPUP:key==='worker'?WORKER_TASK_TIMEOUT_WRAPUP:''};
  });
  app.patch('/api/agents/:key',async req=>{
    const key=(req.params as {key:string}).key;await requireAgent(app.db,key);
    const b=(req.body??{}) as Record<string,unknown>;
    if(b.name===undefined&&b.description===undefined)throw fail(400,'没有可修改字段');
    if(b.name!==undefined&&(typeof b.name!=='string'||!b.name.trim()||Array.from(b.name.trim()).length>120))throw fail(400,'名称不能为空且最多 120 个字符');
    if(b.description!==undefined&&typeof b.description!=='string')throw fail(400,'描述必须是文本');
    const result=await app.db.query('UPDATE agents SET name=COALESCE($2,name),description=COALESCE($3,description) WHERE key=$1 RETURNING id',[key,typeof b.name==='string'?b.name.trim():null,b.description??null]);
    if(!result.rowCount)throw fail(404,'Agent 不存在或已删除');return {ok:true};
  });
  app.get('/api/agents/:key/prompts',async req=>({versions:await versions(app.db,(await requireAgent(app.db,(req.params as {key:string}).key)).id)}));
  app.get('/api/agents/:key/variables',async req=>({variables:await app.db.platform().promptVars((await requireAgent(app.db,(req.params as {key:string}).key)).id)}));
  app.put('/api/agents/:key/prompt',async req=>{
    const a=await requireAgent(app.db,(req.params as {key:string}).key),b=(req.body??{}) as Record<string,unknown>;
    if(typeof b.template!=='string'||!b.template.trim())throw fail(400,'template 不能为空');
    return {version:await app.db.platform().savePrompt(a.id,b.template,typeof b.note==='string'?b.note:'','user')};
  });
  app.delete('/api/agents/:key',async req=>{
    const key=(req.params as {key:string}).key;assertActiveRole(key);
    await app.db.transaction(async tx=>{
      // Same boundaries as trigger collection and conversation claim; never interrupt an executor here.
      await tx.query('SELECT pg_advisory_xact_lock(4200000004)');
      await tx.query('SELECT pg_advisory_xact_lock(4200000003)');
      const a=(await tx.query('SELECT id,builtin FROM agents WHERE key=$1 FOR UPDATE',[key])).rows[0];
      if(!a)throw fail(404,'Agent 不存在或已删除');
      if(a.builtin||ACTIVE_ROLES.some(role=>role===key))throw fail(409,'内置 Agent 不能删除，可在配置中停用');
      const busy=await tx.query(`SELECT 1 FROM conversations c WHERE c.agent_key=$1 AND (
        EXISTS(SELECT 1 FROM conversation_runs r WHERE r.conversation_id=c.id AND r.status IN ('queued','running')) OR
        EXISTS(SELECT 1 FROM runtime_session_leases l WHERE l.key='conversation:'||c.id AND l.expires_at>now())) LIMIT 1`,[key]);
      if(busy.rowCount)throw fail(409,'该 Agent 仍有排队或运行中的会话，请先停止会话并等待执行器退出');
      await tx.query('DELETE FROM agent_triggers WHERE agent_key=$1',[key]);
      await tx.query('DELETE FROM settings WHERE key=$1',[toolLoadingSettingKey(key)]);
      await tx.query('UPDATE tools SET agents=agents-$1::text WHERE agents ? $1',[key]);
      await tx.query('DELETE FROM agents WHERE id=$1',[a.id]);
    });
    return {deleted:key};
  });
}
