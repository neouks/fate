import {createHash} from 'node:crypto';
import type {Database} from '../db/index.js';

const KEY='planner_no_target_execution_v1';
// Exact shipped template allowing three initial probes. Never match edited text.
const PREVIOUS='0d832afdb2c67c25835c3a69dc43380ccb1397910fc4ac495c5cc603b45ffa9a';
export async function migratePlannerCapabilitiesPrompt(db:Database,template:string){
 await db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(4200000018)');
  if(await tx.platform().getSetting(KEY)==='done')return;
  const row=(await tx.query(`SELECT a.id,p.template_text FROM agents a LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key='planner' FOR UPDATE OF a`)).rows[0];
  if(row&&createHash('sha256').update(String(row.template_text)).digest('hex')===PREVIOUS){
   const saved=(await tx.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by)
    SELECT $1,COALESCE(max(version),0)+1,$2,'Planner 禁止直接探测，实测下发 Worker；保留旧版本','migration'
    FROM agent_prompts WHERE agent_id=$1 RETURNING id`,[row.id,template])).rows[0]!;
   await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[row.id,saved.id]);
  }
  await tx.platform().setSetting(KEY,'done');
 });
}
