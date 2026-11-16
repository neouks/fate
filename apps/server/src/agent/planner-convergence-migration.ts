import {createHash} from 'node:crypto';
import type {Database} from '../db/index.js';
import {PRE_CONVERGENCE_PLANNER_PROMPT} from './prompts.js';
import {PLANNER_CONVERGENCE_POLICY,upgradePlannerConvergencePrompt} from './planner-convergence.js';
import {PRE_CONVERGENCE_TOOL_DESCRIPTIONS,REVIEWED_CONVERGENCE_PROVE_GOAL,TOOL_DESCRIPTIONS} from './tool-descriptions.js';

export const CONVERGENCE_MIGRATION_KEY='planner_evidence_convergence_v1';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const reviewed='c86a1062e34c8e6220741717a496980c38c31fa5800ba1f54e6a9e7306f100cc';
export async function migratePlannerConvergence(db:Database){
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(4200000018)');
    const existing=await tx.platform().getSetting(CONVERGENCE_MIGRATION_KEY);if(existing)return JSON.parse(existing);
    const result:{policy:string;prompts:Record<string,unknown>[];tools:Record<string,unknown>[];skipped:string[]}={policy:PLANNER_CONVERGENCE_POLICY,prompts:[],tools:[],skipped:[]};
    const row=(await tx.query("SELECT a.id,a.current_prompt_id,p.version,p.template_text FROM agents a LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key='planner' FOR UPDATE OF a")).rows[0];
    if(row){
      const before=String(row.template_text??''),after=upgradePlannerConvergencePrompt(before),digest=hash(before);
      if(before!==after){
        if(digest!==reviewed&&digest!==hash(PRE_CONVERGENCE_PLANNER_PROMPT))result.skipped.push('planner:unrecognized_prompt');
        else if(digest===reviewed&&Number(row.version)!==33)result.skipped.push('planner:changed_version');
        else{
          const saved=(await tx.query("INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by) SELECT $1,COALESCE(max(version),0)+1,$2,'按证据收敛；保留补全及矛盾复核；保留历史版本','migration' FROM agent_prompts WHERE agent_id=$1 RETURNING id",[row.id,after])).rows[0]!;
          await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[row.id,saved.id]);
          result.prompts.push({role:'planner',agent_id:row.id,previous_id:row.current_prompt_id,new_id:saved.id,previous_hash:digest,new_hash:hash(after)});
        }
      }
    }else result.skipped.push('planner:missing');
    for(const key of ['add_intent','prove_goal']){
      const tool=(await tx.query('SELECT description FROM tools WHERE key=$1 FOR UPDATE',[key])).rows[0];
      if(!tool||tool.description===TOOL_DESCRIPTIONS[key])continue;
      if(tool.description!==PRE_CONVERGENCE_TOOL_DESCRIPTIONS[key]&&!(key==='prove_goal'&&tool.description===REVIEWED_CONVERGENCE_PROVE_GOAL)){result.skipped.push(key+':unrecognized_description');continue;}
      await tx.query('UPDATE tools SET description=$2 WHERE key=$1',[key,TOOL_DESCRIPTIONS[key]]);
      result.tools.push({key,previous_description:tool.description,new_description:TOOL_DESCRIPTIONS[key]});
    }
    await tx.platform().setSetting(CONVERGENCE_MIGRATION_KEY,JSON.stringify(result));return result;
  });
}
export async function rollbackPlannerConvergence(db:Database){
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(4200000018)');
    const saved=await tx.platform().getSetting(CONVERGENCE_MIGRATION_KEY);if(!saved)return;
    const state=JSON.parse(saved);if(state.rolled_back)return state;
    for(const item of state.prompts){
      const row=(await tx.query('SELECT a.current_prompt_id,p.template_text FROM agents a JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.id=$1 FOR UPDATE OF a',[item.agent_id])).rows[0];
      if(!row||String(row.current_prompt_id)!==String(item.new_id)||hash(String(row.template_text))!==item.new_hash)throw new Error('Planner 提示词已变化，停止回退');
      await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[item.agent_id,item.previous_id]);
    }
    for(const item of state.tools){
      const row=(await tx.query('SELECT description FROM tools WHERE key=$1 FOR UPDATE',[item.key])).rows[0];
      if(!row||row.description!==item.new_description)throw new Error('工具说明已变化，停止回退：'+item.key);
      await tx.query('UPDATE tools SET description=$2 WHERE key=$1',[item.key,item.previous_description]);
    }
    state.rolled_back=true;await tx.platform().setSetting(CONVERGENCE_MIGRATION_KEY,JSON.stringify(state));return state;
  });
}
