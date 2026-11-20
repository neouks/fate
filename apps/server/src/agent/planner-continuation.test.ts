import assert from 'node:assert/strict';
import {test} from 'node:test';
import previous from './fixtures/pre-planner-continuation.json' with {type:'json'};
import {PLANNER_PROMPT,PLANNER_WRAPUP,hostProtocol,systemRolePrompt} from './prompts.js';
import {PLANNER_CONTINUATION_GUIDANCE} from './planner-continuation.js';
import {migratePlannerContinuation} from './planner-continuation-migration.js';
import type {Database} from '../db/index.js';

function fixture(prompt=previous.planner,wrapup=previous.wrapup){
  const settings=new Map<string,string>(),versions=[prompt];let selected=0,currentWrapup=wrapup;
  const tx={platform:()=>({getSetting:async(k:string)=>settings.get(k),setSetting:async(k:string,v:string)=>settings.set(k,v)}),query:async(sql:string,args:unknown[]=[])=>{
    if(sql.startsWith('SELECT a.id'))return {rows:[{id:'planner',current_prompt_id:selected,template_text:versions[selected],wrapup_prompt:currentWrapup}]};
    if(sql.startsWith('INSERT INTO agent_prompts')){versions.push(String(args[1]));return {rows:[{id:versions.length-1}]};}
    if(sql.startsWith('UPDATE agents SET current_prompt_id'))selected=Number(args[1]);
    if(sql.startsWith('UPDATE agents SET wrapup_prompt'))currentWrapup=String(args[1]);
    return {rows:[]};
  }};
  return {db:{...tx,transaction:async(fn:(db:unknown)=>unknown)=>fn(tx)} as unknown as Database,versions,get:()=>({selected,currentWrapup}),select:(id:number)=>{selected=id;}};
}
test('continuation migration matches only exact builtins and preserves history, edits and rollback selection',async()=>{
  const f=fixture();const result=await migratePlannerContinuation(f.db);
  assert.equal(result.prompt_updated,true);assert.equal(result.wrapup_updated,true);
  assert.deepEqual(f.versions,[previous.planner,previous.planner+'\n\n'+PLANNER_CONTINUATION_GUIDANCE]);assert.equal(f.get().currentWrapup,PLANNER_WRAPUP);
  assert.deepEqual(await migratePlannerContinuation(f.db),result);assert.equal(f.versions.length,2);
  f.select(0);await migratePlannerContinuation(f.db);assert.equal(f.get().selected,0);
  const custom=fixture(previous.planner+'\n自定义要求',previous.wrapup+' 自定义');
  await migratePlannerContinuation(custom.db);assert.equal(custom.versions.length,1);assert.equal(custom.get().currentWrapup,previous.wrapup+' 自定义');
});
test('default and custom Planner prompts carry continuation policy; terminal protocol forbids dispatch',async()=>{
  assert.ok(PLANNER_PROMPT.includes(PLANNER_CONTINUATION_GUIDANCE));assert.ok(hostProtocol('planner').includes(PLANNER_CONTINUATION_GUIDANCE));
  const db={platform:()=>({getAgentByKey:async()=>({id:'planner'}),currentPrompt:async()=>'自定义 {{Goal}}'})} as unknown as Database;
  assert.ok((await systemRolePrompt(db,'planner',{Goal:'目标'})).includes(PLANNER_CONTINUATION_GUIDANCE));
  const terminal=await systemRolePrompt(db,'planner',{},true);
  assert.match(terminal,/整个任务已超时，不再派单/);assert.ok(!terminal.includes(PLANNER_CONTINUATION_GUIDANCE));
});
