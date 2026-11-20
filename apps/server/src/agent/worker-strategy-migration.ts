import type {Database} from '../db/index.js';
import previous from './fixtures/pre-worker-strategy.json' with {type:'json'};
import {WORKER_PROMPT} from './prompts.js';
export const WORKER_STRATEGY_MIGRATION='worker_in_intent_strategy_v1';
/** Exact shipped default only. Preserve custom selections and append history. */
export async function migrateWorkerStrategy(db:Database){
 return db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(4200000018)');
  const done=await tx.platform().getSetting(WORKER_STRATEGY_MIGRATION);if(done)return JSON.parse(done) as string[];
  const updated:string[]=[];
  const row=(await tx.query(`SELECT a.id,p.template_text FROM agents a LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key='worker' FOR UPDATE OF a`)).rows[0];
  if(row?.template_text===previous.worker){
   const saved=(await tx.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by)
    SELECT $1,COALESCE(max(version),0)+1,$2,'参考 Series 强化意图内替代方法与线索反馈；保留历史版本','migration'
    FROM agent_prompts WHERE agent_id=$1 RETURNING id`,[row.id,WORKER_PROMPT])).rows[0]!;
   await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[row.id,saved.id]);updated.push('worker');
  }
  await tx.platform().setSetting(WORKER_STRATEGY_MIGRATION,JSON.stringify(updated));return updated;
 });
}
