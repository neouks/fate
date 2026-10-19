import type {Database} from './index.js';
import {ROLE_PROMPTS,ARTEX_PREVIOUS_PROMPTS,promptHash,isLegacyPrompt,PLANNER_WRAPUP,PLANNER_TASK_TIMEOUT_WRAPUP} from '../agent/prompts.js';
import {TOOL_DESCRIPTIONS,effectiveToolDescription} from '../agent/tool-descriptions.js';

/** Exact-default, append-only upgrade. Invoke only after stopping old executors. */
export async function migrateArtex(db:Database){
 await db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(4200000019)');
  if(await tx.platform().getSetting('pi_artex_alignment_v1')==='done')return;
  const previous=(await tx.query("SELECT to_jsonb(t) config FROM tools t WHERE kind='shell' OR key IN ('record_plan_decision','write','edit','record_fact','report_finding','insert_assets','http_request','traffic_body')")).rows;
  await tx.platform().setSetting('pi_artex_previous_tools',JSON.stringify(previous));
  const planner=(await tx.query("SELECT wrapup_prompt,task_timeout_wrapup_prompt FROM agents WHERE key='planner'")).rows[0];
  if(planner){
   await tx.platform().setSetting('pi_artex_previous_planner_wrapup',JSON.stringify(planner));
   if(planner.wrapup_prompt==='本轮预算将尽，不再查找新方向。保存已有规划决策后结束；没有新工作可以等待。')await tx.query("UPDATE agents SET wrapup_prompt=$1 WHERE key='planner'",[PLANNER_WRAPUP]);
   if(planner.task_timeout_wrapup_prompt==='整个任务已超时，不再派单。仅用现有证据核对目标并保存最终规划决策，然后结束。')await tx.query("UPDATE agents SET task_timeout_wrapup_prompt=$1 WHERE key='planner'",[PLANNER_TASK_TIMEOUT_WRAPUP]);
  }
  for(const [role,template] of Object.entries(ROLE_PROMPTS)){
   const row=(await tx.query('SELECT a.id,p.template_text FROM agents a LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key=$1 FOR UPDATE OF a',[role])).rows[0];
   if(!row?.template_text||!(promptHash(String(row.template_text))===ARTEX_PREVIOUS_PROMPTS[role]||isLegacyPrompt(role,String(row.template_text))))continue;
   if(row.template_text===template)continue;
   const saved=(await tx.query("INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by) SELECT $1,COALESCE(max(version),0)+1,$2,'ARTEX / PI 原生流程；保留历史模板','migration' FROM agent_prompts WHERE agent_id=$1 RETURNING id",[row.id,template])).rows[0]!;
   await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[row.id,saved.id]);
  }
  for(const row of (await tx.query("SELECT key,description FROM tools WHERE system AND kind='builtin'")).rows){
   const resolved=effectiveToolDescription(String(row.key),TOOL_DESCRIPTIONS[String(row.key)]??String(row.description),row.description);
   if(resolved.source==='builtin'&&resolved.description!==row.description)await tx.query('UPDATE tools SET description=$2 WHERE key=$1',[row.key,resolved.description]);
  }
  const bindings:Array<[string[],string[],string[]]>=[
   [['write','edit'],['worker','pentest'],['planner','mainagent']],
   [['record_fact','report_finding','insert_assets'],['worker'],['mainagent']],
   [['http_request'],['worker','pentest','retester'],['planner','mainagent']],
   [['traffic_body'],['worker','pentest','reporter','retester'],['planner','mainagent']],
  ];
  for(const [keys,before,added] of bindings)await tx.query("UPDATE tools SET agents=agents||$3::jsonb WHERE key=ANY($1::text[]) AND agents=$2::jsonb AND enabled",[keys,JSON.stringify(before),JSON.stringify(added)]);
  // Callable shell entries retain their behavior as command tools. Plain shell
  // declarations remain declarations; the complete previous catalog is above.
  for(const tool of await tx.platform().listTools())if(tool.kind==='shell'&&(Object.keys(tool.exec).length||Object.keys((tool.schema.properties??{}) as object).length)){
   const kind=tool.exec.url?'http':tool.exec.code?'script':'command';
   const exec=Object.keys(tool.exec).length?tool.exec:{legacy_shell_args:true,command:`'${tool.executable.replaceAll("'","'\\''")}' {args}`};
   await tx.query('UPDATE tools SET kind=$2,exec=$3::jsonb WHERE key=$1',[tool.key,kind,JSON.stringify(exec)]);
  }
  await tx.query("DELETE FROM tools WHERE key='record_plan_decision' AND kind='builtin' AND system");
  // Old staged proposals remain readable but require explicit revalidation.
  await tx.query(`UPDATE exploration_nodes SET payload=payload||'{"needs_replanning":true,"dispatch_requested":false}'::jsonb
   WHERE kind='intent' AND state='open' AND origin='planner' AND payload ? 'planning_round' AND payload->>'dispatch_requested' IS DISTINCT FROM 'true'`);
  await tx.query("DELETE FROM engine_worker_slots WHERE phase IN ('planning','ready')");
  await tx.query("UPDATE blackboard_planning_rounds SET status='rejected' WHERE status='planning'");
  await tx.platform().setSetting('pi_artex_alignment_v1','done');
 });
}
