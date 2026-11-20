import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Database,openDatabase} from '../db/index.js';
import {ROLE_PROMPTS,systemRolePrompt,hostProtocol} from './prompts.js';
import {PLANNER_STRATEGY_GUIDANCE} from './planner-strategy.js';
import {INTENT_GRANULARITY_GUIDANCE} from './intent-granularity.js';
import {PLANNER_CONVERGENCE_GUIDANCE} from './planner-convergence.js';
import {migratePlannerStrategy,PLANNER_STRATEGY_MIGRATION} from './planner-strategy-migration.js';
import previous from './fixtures/pre-planner-strategy.json' with {type:'json'};

test('planner strategy survives prompt selection once without removing scope or convergence',async()=>{
 assert(hostProtocol('planner').includes(PLANNER_STRATEGY_GUIDANCE),'Settings preview and runtime policy hash include the strategy');
 for(const selected of [ROLE_PROMPTS.planner,previous.planner,'用户自定义汇报风格 {{Goal}}']){
  const db={platform:()=>({getAgentByKey:async()=>({id:1}),currentPrompt:async()=>selected})} as unknown as Database;
  const actual=await systemRolePrompt(db,'planner',{Goal:'核对离线样本'});
  assert.equal(actual.split(PLANNER_STRATEGY_GUIDANCE).length-1,1);
  assert.equal(actual.split(INTENT_GRANULARITY_GUIDANCE).length-1,1);
  assert(actual.includes(PLANNER_CONVERGENCE_GUIDANCE));
  if(selected.startsWith('用户'))assert(actual.includes('用户自定义汇报风格 核对离线样本'));
  const terminal=await systemRolePrompt(db,'planner',{},true);
  assert(!terminal.includes(PLANNER_STRATEGY_GUIDANCE));
 }
});
test('other roles do not acquire autonomous planner strategy',async()=>{
 for(const role of ['mainagent','worker','reporter'] as const){
  const db={platform:()=>({getAgentByKey:async()=>({id:1}),currentPrompt:async()=>ROLE_PROMPTS[role]})} as unknown as Database;
  assert(!(await systemRolePrompt(db,role)).includes(PLANNER_STRATEGY_GUIDANCE));
 }
});

const dsn=process.env.TEST_PLANNER_STRATEGY_DSN;
test('strategy migration preserves history, custom prompts and deliberate rollbacks',{skip:!dsn&&'isolated PostgreSQL required'},async t=>{
 assert.match(new URL(dsn!).pathname,/^\/test_[a-z0-9_]+$/);process.env.SERIES_PG_DSN=dsn;
 const db=await openDatabase();t.after(()=>db.close());
 const a=(await db.platform().getAgentByKey('planner'))!;
 const select=async(template:string)=>{
  const p=(await db.query("INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by) SELECT $1,COALESCE(max(version),0)+1,$2,'fixture','test' FROM agent_prompts WHERE agent_id=$1 RETURNING id",[a.id,template])).rows[0]!;
  await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[a.id,p.id]);return p.id;
 };
 const old=await select(previous.planner);
 await db.query('DELETE FROM settings WHERE key=$1',[PLANNER_STRATEGY_MIGRATION]);
 assert.deepEqual(await migratePlannerStrategy(db),['planner']);
 assert.equal(await db.platform().currentPrompt(a.id),ROLE_PROMPTS.planner);
 assert.equal((await db.query('SELECT template_text FROM agent_prompts WHERE id=$1',[old])).rows[0]!.template_text,previous.planner);
 const count=(await db.query('SELECT count(*) FROM agent_prompts WHERE agent_id=$1',[a.id])).rows[0]!.count;
 await migratePlannerStrategy(db);
 assert.equal((await db.query('SELECT count(*) FROM agent_prompts WHERE agent_id=$1',[a.id])).rows[0]!.count,count);
 await select(previous.planner);await migratePlannerStrategy(db);
 assert.equal(await db.platform().currentPrompt(a.id),previous.planner);
 const custom=previous.planner+'\n用户自定义条款';await select(custom);
 await db.query('DELETE FROM settings WHERE key=$1',[PLANNER_STRATEGY_MIGRATION]);
 assert.deepEqual(await migratePlannerStrategy(db),[]);
 assert.equal(await db.platform().currentPrompt(a.id),custom);
});
