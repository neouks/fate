import type {Database} from '../db/index.js';
import previous from './fixtures/pre-direction-review.json' with {type:'json'};
import {ROLE_PROMPTS} from './prompts.js';
export const DIRECTION_MIGRATION='direction_evidence_reasoning_v1';
export async function migrateDirectionReasoning(db:Database){
 return db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(4200000018)');
  if(await tx.platform().getSetting(DIRECTION_MIGRATION))return;
  for(const role of ['planner','worker','mainagent'] as const){
   const row=(await tx.query(`SELECT a.id,p.template_text FROM agents a LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key=$1 FOR UPDATE OF a`,[role])).rows[0];
   if(row?.template_text!==previous[role])continue;
   const saved=(await tx.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by)
    SELECT $1,COALESCE(max(version),0)+1,$2,'限定失败结论范围并保留正向线索；保留历史版本','migration'
    FROM agent_prompts WHERE agent_id=$1 RETURNING id`,[row.id,ROLE_PROMPTS[role]])).rows[0]!;
   await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[row.id,saved.id]);
  }
  await tx.platform().setSetting(DIRECTION_MIGRATION,'done');
 });
}
