import type {Database} from '../db/index.js';
import {REPORTER_PROMPT,isLegacyPrompt} from './prompts.js';
export const REPRO_GUIDANCE='确认漏洞时用 report_finding.reproduction 当场保存入口、前置条件和完整利用链。steps 按自然语言说明操作、真实请求或命令、真实响应或输出及证明内容；保留流量 ID。缺失内容留空，不推测报文。一个漏洞一条利用链，不将每次探测拆成事实。';
export async function migrateReproduction(db:Database){
 await db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(4200000028)');
  if(await tx.platform().getSetting('finding_reproduction_v1')==='done')return;
  for(const role of ['worker','reporter']){
   const row=(await tx.query(`SELECT a.id,p.template_text FROM agents a LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key=$1 FOR UPDATE OF a`,[role])).rows[0];if(!row)continue;
   const text=String(row.template_text??'');
   // Worker seed text is read from the canonical builtin without overwriting custom versions.
   const {WORKER_PROMPT}=await import('./prompts.js');
   const match=role==='reporter'?isLegacyPrompt(role,text):text===WORKER_PROMPT;
   if(!match)continue;
   const next=role==='reporter'?REPORTER_PROMPT:text+'\n'+REPRO_GUIDANCE;
   if(text===next)continue;
   const saved=(await tx.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by) SELECT $1,COALESCE(max(version),0)+1,$2,'分步骤漏洞报告；保留原文与历史版本','migration' FROM agent_prompts WHERE agent_id=$1 RETURNING id`,[row.id,next])).rows[0]!;
   await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[row.id,saved.id]);
  }
  await tx.query(`UPDATE tools SET description=description||$1 WHERE key='report_finding' AND description=ANY($2::text[])`,[' 通过 reproduction 保存入口、前置条件、有序利用链及真实请求/响应；缺失留空。',['提交亲自验证且可复现的漏洞和真实证据，成功立即入图。asset_ids 只列实际受影响资产，缺省不继承意图范围；scope 说明已验证范围和限制。先 context_search 按 finding 查重；疑似结论用 record_fact。']]);
  await tx.platform().setSetting('finding_reproduction_v1','done');
 });
}

export async function migrateReporterConcisePrompt(db:Database){
 await db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(4200000028)');
  if(await tx.platform().getSetting('finding_report_concise_v1')==='done')return;
  const row=(await tx.query(`SELECT a.id,p.template_text FROM agents a
   LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key='reporter' FOR UPDATE OF a`)).rows[0];
  if(row?.template_text && isLegacyPrompt('reporter',String(row.template_text))){
   const saved=(await tx.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by)
    SELECT $1,COALESCE(max(version),0)+1,$2,'精简漏洞描述与发现思路；保留历史模板','migration'
    FROM agent_prompts WHERE agent_id=$1 RETURNING id`,[row.id,REPORTER_PROMPT])).rows[0]!;
   await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[row.id,saved.id]);
  }
  await tx.platform().setSetting('finding_report_concise_v1','done');
 });
}

/** Versioned exact-default upgrade; custom and explicitly reselected prompts survive. */
export async function migrateReporterNaturalPrompt(db:Database){
 await db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(4200000028)');
  if(await tx.platform().getSetting('finding_report_natural_http_v2')==='done')return;
  const row=(await tx.query(`SELECT a.id,p.template_text FROM agents a
   LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key='reporter' FOR UPDATE OF a`)).rows[0];
  if(row?.template_text && isLegacyPrompt('reporter',String(row.template_text))){
   const saved=(await tx.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by)
    SELECT $1,COALESCE(max(version),0)+1,$2,'报告改为精简自然语言与完整 HTTP 报文；保留旧模板','migration'
    FROM agent_prompts WHERE agent_id=$1 RETURNING id`,[row.id,REPORTER_PROMPT])).rows[0]!;
   await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[row.id,saved.id]);
  }
  await tx.platform().setSetting('finding_report_natural_http_v2','done');
 });
}
