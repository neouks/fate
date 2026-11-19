import type {Database} from '../db/index.js';
import {REPORTER_PROMPT,isLegacyPrompt} from './prompts.js';
export async function migrateReproduction(db:Database){
 await db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(4200000028)');
  if(await tx.platform().getSetting('finding_reproduction_v1')==='done')return;
  const row=(await tx.query(`SELECT a.id,p.template_text FROM agents a LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key='reporter' FOR UPDATE OF a`)).rows[0];
  const text=String(row?.template_text??'');
  if(row && isLegacyPrompt('reporter',text) && text!==REPORTER_PROMPT){
   const saved=(await tx.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by) SELECT $1,COALESCE(max(version),0)+1,$2,'分步骤漏洞报告；保留原文与历史版本','migration' FROM agent_prompts WHERE agent_id=$1 RETURNING id`,[row.id,REPORTER_PROMPT])).rows[0]!;
   await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[row.id,saved.id]);
  }
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
