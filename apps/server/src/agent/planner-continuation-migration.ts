import type {Database} from '../db/index.js';
import previous from './fixtures/pre-planner-continuation.json' with {type:'json'};
import {PLANNER_CONTINUATION_GUIDANCE,PLANNER_CONTINUATION_WRAPUP} from './planner-continuation.js';

export const PLANNER_CONTINUATION_MIGRATION='planner_unfinished_continuation_v1';
/** Exact shipped text only; retain selected custom prompts and all old versions. */
export async function migratePlannerContinuation(db:Database){
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(4200000018)');
    const existing=await tx.platform().getSetting(PLANNER_CONTINUATION_MIGRATION);
    if(existing)return JSON.parse(existing);
    const result:Record<string,unknown>={prompt_updated:false,wrapup_updated:false};
    const row=(await tx.query(`SELECT a.id,a.current_prompt_id,a.wrapup_prompt,p.template_text
      FROM agents a LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key='planner' FOR UPDATE OF a`)).rows[0];
    if(row){
      if(row.template_text===previous.planner){
        const saved=(await tx.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by)
          SELECT $1,COALESCE(max(version),0)+1,$2,'目标未完成持续调度；精确升级旧内置提示词，保留历史版本','migration'
          FROM agent_prompts WHERE agent_id=$1 RETURNING id`,[row.id,previous.planner+'\n\n'+PLANNER_CONTINUATION_GUIDANCE])).rows[0]!;
        await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[row.id,saved.id]);
        Object.assign(result,{prompt_updated:true,previous_prompt_id:row.current_prompt_id,new_prompt_id:saved.id});
      }
      if(row.wrapup_prompt===previous.wrapup){
        await tx.query('UPDATE agents SET wrapup_prompt=$2 WHERE id=$1',[row.id,PLANNER_CONTINUATION_WRAPUP]);
        Object.assign(result,{wrapup_updated:true,previous_wrapup:row.wrapup_prompt});
      }
    }
    await tx.platform().setSetting(PLANNER_CONTINUATION_MIGRATION,JSON.stringify(result));
    return result;
  });
}
