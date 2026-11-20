import type {Database} from '../db/index.js';
import {toolIdentity} from './tool-registry.js';
import previousPrompts from './fixtures/pre-user-tool-policy.json' with {type:'json'};
import {builtinPrompt} from './prompts.js';

export const TOOL_CLEANUP_ARCHIVE='tool_catalog_cleanup_v2';
/** Remove only built-in entries without a current entrypoint. Retain every
 * historical row in settings; user-authored tools and live bindings are untouched. */
export async function cleanupToolCatalog(db:Database){
 return db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(4200000018)');
  const rows=(await tx.query("SELECT * FROM tools WHERE kind='builtin' FOR UPDATE")).rows;
  const removed=rows.filter(row=>['retired','unsupported'].includes(toolIdentity(String(row.key)).implementation_status));
  for(const row of removed){
   await tx.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING',[`${TOOL_CLEANUP_ARCHIVE}:${row.key}`,JSON.stringify(row)]);
  }
  const names=removed.map(row=>String(row.key));
  if(names.length)await tx.query("DELETE FROM tools WHERE kind='builtin' AND key=ANY($1::text[])",[names]);
  const settings=(await tx.query("SELECT key,value FROM settings WHERE key LIKE 'agent_tool_loading_v1:%' FOR UPDATE")).rows;
  for(const row of settings){
   const saved=JSON.parse(String(row.value));
   const next=Object.fromEntries(Object.entries(saved).filter(([name])=>!names.includes(name)));
   if(Object.keys(next).length===Object.keys(saved).length)continue;
   await tx.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING',[`${TOOL_CLEANUP_ARCHIVE}:${row.key}`,row.value]);
   await tx.query('UPDATE settings SET value=$2 WHERE key=$1',[row.key,JSON.stringify(next)]);
  }
  // Selected built-in prompts are upgraded exactly once; custom text and all
  // prior versions survive. A deliberate later rollback stays selected.
  const marker='user_tool_policy_prompts_v1';
  if(!await tx.platform().getSetting(marker)){
   for(const [role,previous] of Object.entries(previousPrompts)){
    const next=builtinPrompt(role);if(!next||next===previous)continue;
    const row=(await tx.query(`SELECT a.id,p.template_text FROM agents a LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key=$1 FOR UPDATE OF a`,[role])).rows[0];
    if(!row||row.template_text!==previous)continue;
    const saved=(await tx.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by)
      SELECT $1,COALESCE(max(version),0)+1,$2,'工具能力由用户配置；保留历史版本','migration' FROM agent_prompts WHERE agent_id=$1 RETURNING id`,[row.id,next])).rows[0]!;
    await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[row.id,saved.id]);
   }
   await tx.platform().setSetting(marker,'done');
  }
  return {removed:names};
 });
}
