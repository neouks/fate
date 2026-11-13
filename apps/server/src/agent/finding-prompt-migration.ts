import {createHash} from 'node:crypto';
import type {Database} from '../db/index.js';
import {effectiveToolDescription,TOOL_DESCRIPTIONS} from './tool-descriptions.js';

const KEY='finding_supplement_policy_v1';
const PREVIOUS:Record<string,string>={
  planner:'8ecb1120ef40e9fec0abf2db690883ef085bd20231c9d59a8949bc30a83bc093',
  worker:'3d98e41a15a5aa8c4e542f6f952e6e74dd0474474370a4d87fa7e18826582480',
};

/** Exact shipped defaults only. Custom text, old prompt versions and bindings survive. */
export async function migrateFindingWritePolicy(db:Database,templates:Record<string,string>){
  await db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(4200000018)');
    if(await tx.platform().getSetting(KEY)==='done')return;
    for(const [role,hash] of Object.entries(PREVIOUS)){
      const row=(await tx.query(`SELECT a.id,p.template_text FROM agents a
        LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key=$1 FOR UPDATE OF a`,[role])).rows[0];
      if(!row||createHash('sha256').update(String(row.template_text)).digest('hex')!==hash)continue;
      const saved=(await tx.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by)
        SELECT $1,COALESCE(max(version),0)+1,$2,'补正已有漏洞沿用原编号；保留旧版本','migration'
        FROM agent_prompts WHERE agent_id=$1 RETURNING id`,[row.id,templates[role]])).rows[0]!;
      await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[row.id,saved.id]);
    }
    const tools=(await tx.query("SELECT key,description FROM tools WHERE key IN ('report_finding','report_conversation_finding') AND system AND kind='builtin' FOR UPDATE")).rows;
    for(const tool of tools){
      const key=String(tool.key),next=effectiveToolDescription(key,TOOL_DESCRIPTIONS[key]!,tool.description);
      if(next.source==='builtin'&&next.description!==tool.description){
        await tx.platform().setSetting(KEY+'_previous_description_'+key,String(tool.description));
        await tx.query('UPDATE tools SET description=$2 WHERE key=$1',[key,next.description]);
      }
    }
    await tx.platform().setSetting(KEY,'done');
  });
}
