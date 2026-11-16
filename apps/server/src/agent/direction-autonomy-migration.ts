import {createHash} from 'node:crypto';
import type {Database} from '../db/index.js';
import {DIRECTION_AUTONOMY_POLICY,upgradeDirectionPrompt} from './direction-autonomy.js';
import {PRE_AUTONOMY_PLANNER_PROMPT,PRE_AUTONOMY_WORKER_PROMPT} from './prompts.js';
import {TOOL_DESCRIPTIONS} from './tool-descriptions.js';

export const AUTONOMY_MIGRATION_KEY='direction_autonomy_v2';
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const reviewed:Record<string,string[]>={
  planner:['0d832afdb2c67c25835c3a69dc43380ccb1397910fc4ac495c5cc603b45ffa9a'],
  worker:['dd2d5f04cef40651761a0762787465e80130f21379c701226f5bd6603116ce3c'],
};

/** Append-only, exact-baseline migration. Unknown edits are reported, never overwritten. */
export async function migrateDirectionAutonomy(db:Database){
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(4200000018)');
    const prior=await tx.platform().getSetting(AUTONOMY_MIGRATION_KEY);
    if(prior)return JSON.parse(prior);
    const result:{policy:string;prompts:Record<string,unknown>[];tools:Record<string,unknown>[];skipped:string[]}={policy:DIRECTION_AUTONOMY_POLICY,prompts:[],tools:[],skipped:[]};
    for(const [role,baseline] of [['planner',PRE_AUTONOMY_PLANNER_PROMPT],['worker',PRE_AUTONOMY_WORKER_PROMPT]] as const){
      const row=(await tx.query(`SELECT a.id,a.current_prompt_id,p.version,p.template_text FROM agents a
        LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key=$1 FOR UPDATE OF a`,[role])).rows[0];
      if(!row){result.skipped.push(role+':missing');continue;}
      const before=String(row.template_text??''),after=upgradeDirectionPrompt(role,before);
      if(before===after)continue;
      if(![digest(baseline),...reviewed[role]!].includes(digest(before))){result.skipped.push(role+':unrecognized_prompt');continue;}
      // The reviewed live selections were version 32. A later selection, even
      // with identical text, is an operator decision and must not be replaced.
      if(reviewed[role]!.includes(digest(before))&&Number(row.version)!==32){result.skipped.push(role+':changed_version');continue;}
      const saved=(await tx.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by)
        SELECT $1,COALESCE(max(version),0)+1,$2,'方向级派单与 Worker 自主探索 v2；保留历史','migration'
        FROM agent_prompts WHERE agent_id=$1 RETURNING id`,[row.id,after])).rows[0]!;
      await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[row.id,saved.id]);
      result.prompts.push({role,agent_id:row.id,previous_id:row.current_prompt_id,new_id:saved.id,previous_hash:digest(before),new_hash:digest(after)});
    }
    const tool=(await tx.query("SELECT key,description FROM tools WHERE key='add_intent' FOR UPDATE")).rows[0];
    if(tool&&tool.description!==TOOL_DESCRIPTIONS.add_intent){
      const before=String(tool.description??'');
      if(digest(before)===digest('按有价值的方向派单：summary 简述目的，asset_ids 给入口范围，parent_ids 引用依据；Worker 自选步骤，contract 仅按需补边界。不按接口或参数拆单；局部重叠见 dedup.related_intent_ids，派前核对已有方向。Main 以宿主下发回执为准。')){
        await tx.query('UPDATE tools SET description=$2 WHERE key=$1',[tool.key,TOOL_DESCRIPTIONS.add_intent]);
        result.tools.push({key:tool.key,previous_description:before,new_description:TOOL_DESCRIPTIONS.add_intent});
      }else result.skipped.push('add_intent:unrecognized_description');
    }
    await tx.platform().setSetting(AUTONOMY_MIGRATION_KEY,JSON.stringify(result));
    return result;
  });
}

/** Restore only this migration's selections; abort atomically if an operator edited them. */
export async function rollbackDirectionAutonomy(db:Database){
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(4200000018)');
    const saved=await tx.platform().getSetting(AUTONOMY_MIGRATION_KEY);
    if(!saved)return;
    const state=JSON.parse(saved);
    if(state.rolled_back)return state;
    for(const item of state.prompts){
      const row=(await tx.query('SELECT a.current_prompt_id,p.version,p.template_text FROM agents a JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.id=$1 FOR UPDATE OF a',[item.agent_id])).rows[0];
      if(!row||String(row.current_prompt_id)!==String(item.new_id)||digest(String(row.template_text))!==item.new_hash)throw new Error('提示词已变化，停止回退：'+item.role);
      await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[item.agent_id,item.previous_id]);
    }
    for(const item of state.tools){
      const row=(await tx.query('SELECT description FROM tools WHERE key=$1 FOR UPDATE',[item.key])).rows[0];
      if(!row||row.description!==item.new_description)throw new Error('工具说明已变化，停止回退：'+item.key);
      await tx.query('UPDATE tools SET description=$2 WHERE key=$1',[item.key,item.previous_description]);
    }
    state.rolled_back=true;
    await tx.platform().setSetting(AUTONOMY_MIGRATION_KEY,JSON.stringify(state));
    return state;
  });
}
