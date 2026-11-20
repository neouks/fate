import assert from 'node:assert/strict';
import {test} from 'node:test';
import {INTENT_GRANULARITY_GUIDANCE} from './intent-granularity.js';
import {ROLE_PROMPTS,systemRolePrompt} from './prompts.js';
import {effectiveToolDescription} from './tool-descriptions.js';
import {addIntentTool} from '../tools/intents.js';
import {runContext} from '../tools/context.js';
import {Database,openDatabase} from '../db/index.js';
import {migrateIntentGranularity,INTENT_GRANULARITY_MIGRATION} from './intent-granularity-migration.js';
import previous from './fixtures/pre-intent-granularity.json' with {type:'json'};

for(const role of ['planner','mainagent'] as const){
 test(`${role} gets one current granularity rule with default, custom and restored prompts`,async()=>{
  for(const selected of [ROLE_PROMPTS[role],previous[role],'用户自定义风格：简明汇报 {{Goal}}']){
   const db={platform:()=>({getAgentByKey:async()=>({id:role}),currentPrompt:async()=>selected})} as unknown as Database;
   const actual=await systemRolePrompt(db,role,{Goal:'样本核对'});
   assert.equal(actual.split(INTENT_GRANULARITY_GUIDANCE).length-1,1);
   if(selected.startsWith('用户'))assert.match(actual,/用户自定义风格：简明汇报 样本核对/);
  }
  const tool=addIntentTool(runContext({} as Database,1,1,role));
  assert(tool.description.includes(INTENT_GRANULARITY_GUIDANCE));
  assert.match(JSON.stringify(tool.parameters),/前置已满足、可独立验收/);
 });
}
test('custom add_intent help cannot drop the shared scope rule, and re-resolution does not duplicate it',()=>{
 const first=effectiveToolDescription('add_intent','unused','用户派单说明：保留业务名词。');
 assert.equal(first.source,'custom');assert(first.description.includes(INTENT_GRANULARITY_GUIDANCE));
 const second=effectiveToolDescription('add_intent','unused',first.description);
 assert.equal(second.description.split(INTENT_GRANULARITY_GUIDANCE).length-1,1);
});
test('granularity does not impose one operation or one acceptance item per intent',async()=>{
 const tool=addIntentTool(runContext({} as Database,1,1,'planner'));
 const {intents:items}=await tool.prepareArguments!({intents:[{summary:'核对样本 A 是否符合格式',contract:{objective:'核对样本 A 格式',acceptance:['记录编码','记录列名','给出格式结论']} as never},{summary:'核对样本 B 是否符合格式'}]});
 assert.equal(items.length,2);assert.equal(items[0]!.contract!.acceptance.length,3);
});

const dsn=process.env.TEST_INTENT_GRANULARITY_DSN;
test('default migration appends history once and preserves selected custom prompts',{skip:!dsn&&'isolated PostgreSQL required'},async t=>{
 assert.match(new URL(dsn!).pathname,/^\/test_[a-z0-9_]+$/);process.env.SERIES_PG_DSN=dsn;
 const db=await openDatabase();t.after(()=>db.close());
 const set=async(role:string,template:string)=>{
  const a=(await db.query('SELECT id FROM agents WHERE key=$1',[role])).rows[0]!;
  const p=(await db.query("INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by) SELECT $1,COALESCE(max(version),0)+1,$2,'fixture','test' FROM agent_prompts WHERE agent_id=$1 RETURNING id",[a.id,template])).rows[0]!;
  await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[a.id,p.id]);return p.id;
 };
 const ids=[];for(const role of ['planner','mainagent'] as const)ids.push(await set(role,previous[role]));
 await db.query('DELETE FROM settings WHERE key=$1',[INTENT_GRANULARITY_MIGRATION]);
 assert.deepEqual(await migrateIntentGranularity(db),['planner','mainagent']);
 for(const role of ['planner','mainagent'] as const){
  const a=await db.platform().getAgentByKey(role);assert.equal(await db.platform().currentPrompt(a!.id),ROLE_PROMPTS[role]);
 }
 const history=(await db.query('SELECT template_text FROM agent_prompts WHERE id=ANY($1::bigint[]) ORDER BY id',[ids])).rows;
 assert.deepEqual(history.map(r=>r.template_text),[previous.planner,previous.mainagent]);
 const custom=previous.mainagent+'\n用户自定义条款';const customID=await set('mainagent',custom);
 await set('planner',previous.planner);
 await migrateIntentGranularity(db); // deliberate rollback after migration remains selected
 assert.equal(await db.platform().currentPrompt((await db.platform().getAgentByKey('planner'))!.id),previous.planner);
 await db.query('DELETE FROM settings WHERE key=$1',[INTENT_GRANULARITY_MIGRATION]);
 assert.deepEqual(await migrateIntentGranularity(db),['planner']);
 assert.equal((await db.query("SELECT current_prompt_id FROM agents WHERE key='mainagent'")).rows[0]!.current_prompt_id,String(customID));
});
