import replacements from './retired-exploration-text.json' with {type:'json'};
import type {Database} from '../db/index.js';

export const RETIRED_EXPLORATION_MIGRATION='retire_exploration_policy_v1';

/** Known shipped instructions are removal inputs only, never prompt defaults.
 * Preserve unrelated user text and audit history, including custom additions.
 * Read-time cleanup also covers an operator selecting an old prompt later.
 */
export function retireExplorationInstructions(scope:string,text:string):string {
  let cleaned=text;
  for(const rule of replacements)if(rule.scope===scope)cleaned=cleaned.replaceAll(rule.before,rule.after);
  return cleaned===text?text:cleaned.replace(/\n{3,}/g,'\n\n').trim();
}

/** Append clean selected versions; old versions remain audit records only. */
export async function migrateRetiredExplorationPolicy(db:Database) {
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(4200000018)');
    if(await tx.platform().getSetting(RETIRED_EXPLORATION_MIGRATION)==='done')return;
    const rows=(await tx.query(`SELECT a.id,a.key,p.template_text FROM agents a
      LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id
      WHERE a.key IN ('planner','worker') FOR UPDATE OF a`)).rows;
    for(const row of rows){
      const before=String(row.template_text??''),after=retireExplorationInstructions(String(row.key),before);
      if(after===before)continue;
      const saved=(await tx.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by)
        SELECT $1,COALESCE(max(version),0)+1,$2,'删除自主探索策略及强制派单粒度；保留无关配置和历史','migration'
        FROM agent_prompts WHERE agent_id=$1 RETURNING id`,[row.id,after])).rows[0]!;
      await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[row.id,saved.id]);
    }
    const tool=(await tx.query("SELECT description FROM tools WHERE key='add_intent' FOR UPDATE")).rows[0];
    if(tool){
      const before=String(tool.description??''),after=retireExplorationInstructions('add_intent',before);
      if(after!==before)await tx.query("UPDATE tools SET description=$1 WHERE key='add_intent'",[after]);
    }
    await tx.platform().setSetting(RETIRED_EXPLORATION_MIGRATION,'done');
  });
}
