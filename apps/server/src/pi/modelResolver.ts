import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Database } from '../db/index.js';
import type { LLMProfile } from '../db/platform.js';
import type { ModelResolver } from '../engine/engine.js';
import type { ModelSource } from '../agent/roles.js';
import { buildModelSource } from './providerFromProfile.js';

/** The management DTO and all role sessions use this same precedence and ordered chain. */
export async function resolveModelProfiles(db:Database,taskID:number,role:string) {
  const task=await db.tasks().getTask(taskID);
  if(!task)throw new Error(`任务 #${taskID} 不存在`);
  const chain=await db.query(`SELECT profile_id,status,position,last_error FROM task_llm_profiles WHERE task_id=$1 ORDER BY position`,[taskID]);
  const agent=await db.query(`SELECT llm_profile_id AS id,enabled FROM agents WHERE key=$1`,[role]);
  let ids=chain.rows.filter(r=>r.status==='ready').map(r=>Number(r.profile_id));
  const active=Number(task.active_llm_profile_id ?? task.llm_profile_id ?? 0);
  if(ids.includes(active))ids=[active,...ids.filter(id=>id!==active)];
  let source='task_chain';
  if(!chain.rows.length){
    const id=active || Number(agent.rows[0]?.id ?? 0);
    source=active?'task_chain':id?'agent_binding':'global_profile';
    if(id) ids=[id]; else { const global=await db.platform().activeProfile();if(global)ids=[global.id]; }
  }
  const profiles:LLMProfile[]=[];
  for(const id of ids){ const p=await db.platform().profileByID(id);if(p)profiles.push(p); }
  const p=profiles[0];
  return {profiles,chain:chain.rows,source,resolution:{profile_id:p?.id,name:p?.name??'',model:p?.model??'',format:p?.format??'',source,
    available:!!p && agent.rows[0]?.enabled!==false,
    ...(!p?{reason:chain.rows.length?'任务模型候补链已耗尽':'未配置 LLM'}:agent.rows[0]?.enabled===false?{reason:'角色已禁用'}:{})}};
}

function cleanError(error:string,profiles:LLMProfile[]){
  for(const p of profiles)if(p.apiKey)error=error.split(p.apiKey).join('[redacted]');
  return error.replace(/(?:Bearer\s+|\bsk-)[\w.-]+/gi,'[redacted]').slice(0,2000);
}

/** Shared database limiter: reservations are serialized per profile across tasks and processes. */
async function reserveRequest(db:Database,p:LLMProfile,signal?:AbortSignal){
  const spacing=Math.max(p.ratePerSecond>0?1000/p.ratePerSecond:0,p.ratePerMinute>0?60000/p.ratePerMinute:0);
  if(!spacing)return;
  const wait=await db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock($1)',[4_000_000_000+p.id]);
    const r=await tx.query(`INSERT INTO llm_request_limits(profile_id,next_at) VALUES($1,clock_timestamp()) ON CONFLICT(profile_id) DO UPDATE SET next_at=GREATEST(llm_request_limits.next_at,clock_timestamp()) RETURNING EXTRACT(EPOCH FROM (next_at-clock_timestamp()))*1000 AS wait`,[p.id]);
    await tx.query(`UPDATE llm_request_limits SET next_at=next_at+($2 * interval '1 millisecond') WHERE profile_id=$1`,[p.id,spacing]);
    return Math.max(0,Number(r.rows[0]?.wait??0));
  });
  if(wait)await delay(wait,undefined,{signal});
  signal?.throwIfAborted();
}

export function makeModelResolver(db:Database,build=buildModelSource):ModelResolver {
  const cache=new Map<string,Promise<ModelSource>>();
  return async(taskID,role)=>{
    const resolved=await resolveModelProfiles(db,taskID,role);
    if(!resolved.resolution.available)throw new Error(resolved.resolution.reason);
    const profiles=resolved.profiles, sources:ModelSource[]=[];
    for(const profile of profiles){
      const key=createHash('sha256').update(JSON.stringify(profile)).digest('hex');
      let source=cache.get(key);
      if(!source){if(cache.size>=32)cache.clear();source=build(profile);cache.set(key,source);source.catch(()=>cache.delete(key));}
      sources.push(await source);
    }
    const runtime=await ModelRuntime.create({refreshOnCreate:false});
    for(const source of sources){const provider=source.modelRuntime.getProvider(source.model.provider);if(!provider)throw new Error('模型 provider 未注册');await runtime.registerNativeProvider(provider);}
    await runtime.refresh({allowNetwork:false});
    let index=0,retries=0,lastError='',attemptID:number|undefined;
    runtime.registerVirtualModel({provider:'series-router',id:`task-${taskID}-${role}`,name:`任务 ${taskID} / ${role}`,input:sources.every(s=>s.model.input.includes('image'))?['text','image']:['text'],
      contextWindow:Math.min(...sources.map(s=>s.model.contextWindow)),maxTokens:Math.min(...sources.map(s=>s.model.maxTokens)),
      route:async request=>{
        await reserveRequest(db,profiles[index]!,request.signal);
        const p=profiles[index]!,source=sources[index]!;
        const row=await db.query(`INSERT INTO llm_request_attempts(task_id,role,profile_id,model,status) VALUES($1,$2,$3,$4,'running') RETURNING id`,[taskID,role,p.id,p.model]);
        attemptID=Number(row.rows[0]!.id);
        return {model:source.model,thinkingLevel:source.thinkingLevel??'off'};
      }});
    return {modelRuntime:runtime,model:runtime.getModel('series-router',`task-${taskID}-${role}`)!,modelPolicy:{
      async onResponse(message){
        const m=message as {stopReason?:string;errorMessage?:string;usage?:unknown};
        lastError=m.stopReason==='error'?cleanError(m.errorMessage??'模型调用失败',profiles):'';
        if(attemptID)await db.query(`UPDATE llm_request_attempts SET status=$2,error=$3,usage=$4::jsonb,finished_at=now() WHERE id=$1`,[attemptID,m.stopReason==='aborted'?'aborted':lastError?'failed':'completed',lastError,JSON.stringify(m.usage??{})]);
        attemptID=undefined;
        if(!lastError)retries=0;
      },
      async retry(){
        if(!lastError)return false;
        const p=profiles[index]!;
        const hard=/401|403|invalid.?api.?key|unauthori|insufficient|quota|credit|balance/i.test(lastError);
        const retryLimit=Math.max(0,Math.min(3,p.retry?.connect?.attempts??0));
        if(!hard && retries++<retryLimit){await delay(Math.min(p.retry?.connect?.interval_ms||250,10_000));return true;}
        await db.query(`UPDATE task_llm_profiles SET last_error=$3,status=CASE WHEN $4 THEN 'quota_exhausted' ELSE status END,exhausted_at=CASE WHEN $4 THEN now() ELSE exhausted_at END WHERE task_id=$1 AND profile_id=$2`,[taskID,p.id,lastError,hard]);
        if(index+1>=sources.length)return false;
        index++;retries=0;
        if(resolved.source==='task_chain')await db.query('UPDATE tasks SET active_llm_profile_id=$2 WHERE id=$1',[taskID,profiles[index]!.id]);
        return true;
      },
    }};
  };
}
