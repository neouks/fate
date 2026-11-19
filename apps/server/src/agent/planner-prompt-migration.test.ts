import historical from './fixtures/historical-assignment-prompts.json' with {type:'json'};
import {FINDING_PLANNER_GUIDANCE} from './finding-write-policy.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PLANNER_PROMPT,hostProtocol,systemRolePrompt} from './prompts.js';
import {migratePlannerCapabilitiesPrompt} from './planner-prompt-migration.js';
import {PLANNER_CAPABILITY_PROTOCOL} from './planner-capabilities.js';
import type {Database} from '../db/index.js';

const old=historical.planner.replace(FINDING_PLANNER_GUIDANCE+'\n','').replace('开局证据不足也不得直接探测目标，先查重，再用 add_intent 将实测方向下发给 Worker。','仅开局无 Worker 事实且态势不足时可三次轻量只读探测，后续测试交 Worker。');
function fixture(template:string){
 const settings=new Map<string,string>();let writes=0,saved='';
 const tx={platform:()=>({getSetting:async(k:string)=>settings.get(k),setSetting:async(k:string,v:string)=>settings.set(k,v)}),query:async(sql:string,args:unknown[]=[])=>{
  if(sql.startsWith('SELECT a.id'))return{rows:[{id:'planner-id',template_text:template}]};
  if(sql.startsWith('INSERT')){writes++;saved=String(args[1]);return{rows:[{id:22}]};}
  return{rows:[]};
 }};
 return {db:{...tx,transaction:async(fn:(tx:unknown)=>unknown)=>fn(tx)} as unknown as Database,get:()=>({writes,saved})};
}
test('exact old Planner default upgrades once, custom and explicit rollback remain unchanged',async()=>{
 const f=fixture(old);await migratePlannerCapabilitiesPrompt(f.db,PLANNER_PROMPT);await migratePlannerCapabilitiesPrompt(f.db,PLANNER_PROMPT);
 assert.deepEqual(f.get(),{writes:1,saved:PLANNER_PROMPT});
 const custom=fixture(old+'\n用户自定义内容');await migratePlannerCapabilitiesPrompt(custom.db,PLANNER_PROMPT);assert.equal(custom.get().writes,0);
});
test('custom Planner prompt retains text and receives host ceiling; final review stays constrained',async()=>{
 assert.ok(hostProtocol('planner').includes(PLANNER_CAPABILITY_PROTOCOL));
 assert.doesNotMatch(PLANNER_PROMPT,/可三次轻量/);
 const db={platform:()=>({getAgentByKey:async()=>({id:'planner'}),currentPrompt:async()=>'原自定义提示词 {{Goal}}'})} as unknown as Database;
 const text=await systemRolePrompt(db,'planner',{Goal:'本地合成目标'});
 assert.match(text,/原自定义提示词 本地合成目标/);assert.ok(text.includes(PLANNER_CAPABILITY_PROTOCOL));
 assert.ok((await systemRolePrompt(db,'planner',{},true,'仅收尾')).includes(PLANNER_CAPABILITY_PROTOCOL));
});
