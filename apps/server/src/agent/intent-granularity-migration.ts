import type {Database} from '../db/index.js';
import previous from './fixtures/pre-intent-granularity.json' with {type:'json'};
import {builtinPrompt} from './prompts.js';
export const INTENT_GRANULARITY_MIGRATION='intent_single_question_v1';
/** Exact shipped defaults only, with append-only prompt history. */
export async function migrateIntentGranularity(db:Database){
 return db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(4200000018)');
  const done=await tx.platform().getSetting(INTENT_GRANULARITY_MIGRATION);if(done)return JSON.parse(done);
  const updated:string[]=[];
  for(const [role,old] of Object.entries(previous)){
   const row=(await tx.query(`SELECT a.id,p.template_text FROM agents a LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key=$1 FOR UPDATE OF a`,[role])).rows[0];
   if(!row||row.template_text!==old)continue;
   const saved=(await tx.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by)
    SELECT $1,COALESCE(max(version),0)+1,$2,'单意图独立验收；依赖结果后另行派单，保留历史版本','migration'
    FROM agent_prompts WHERE agent_id=$1 RETURNING id`,[row.id,builtinPrompt(role)])).rows[0]!;
   await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[row.id,saved.id]);updated.push(role);
  }
  await tx.platform().setSetting(INTENT_GRANULARITY_MIGRATION,JSON.stringify(updated));return updated;
 });
}
