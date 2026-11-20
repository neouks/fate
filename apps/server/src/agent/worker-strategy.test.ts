import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Database,openDatabase} from '../db/index.js';
import {ROLE_PROMPTS,systemRolePrompt,hostProtocol} from './prompts.js';
import {WORKER_STRATEGY_GUIDANCE} from './worker-strategy.js';
import {WORKER_COMPLETION_GUIDANCE,WORKER_FACT_GUIDANCE} from './worker-fact-policy.js';
import {migrateWorkerStrategy,WORKER_STRATEGY_MIGRATION} from './worker-strategy-migration.js';
import previous from './fixtures/pre-worker-strategy.json' with {type:'json'};

test('worker strategy survives prompt selection once without removing scope or convergence',async()=>{
 assert(hostProtocol('worker').includes(WORKER_STRATEGY_GUIDANCE),'Settings preview and runtime policy hash include the strategy');
 for(const selected of [ROLE_PROMPTS.worker,previous.worker,'用户自定义汇报风格 {{Goal}}']){
  const db={platform:()=>({getAgentByKey:async()=>({id:1}),currentPrompt:async()=>selected})} as unknown as Database;
  const actual=await systemRolePrompt(db,'worker',{Goal:'核对离线样本'});
  assert.equal(actual.split(WORKER_STRATEGY_GUIDANCE).length-1,1);
  assert.equal(actual.split(WORKER_FACT_GUIDANCE).length-1,1);
  assert(actual.includes(WORKER_COMPLETION_GUIDANCE));
  if(selected.startsWith('用户'))assert(actual.includes('用户自定义汇报风格 核对离线样本'));
  const terminal=await systemRolePrompt(db,'worker',{},true);
  assert(!terminal.includes(WORKER_STRATEGY_GUIDANCE));
 }
});
test('other roles do not acquire autonomous worker strategy',async()=>{
 for(const role of ['mainagent','planner','reporter'] as const){
  const db={platform:()=>({getAgentByKey:async()=>({id:1}),currentPrompt:async()=>ROLE_PROMPTS[role]})} as unknown as Database;
  assert(!(await systemRolePrompt(db,role)).includes(WORKER_STRATEGY_GUIDANCE));
 }
});

const dsn=process.env.TEST_WORKER_STRATEGY_DSN;
test('strategy migration preserves history, custom prompts and deliberate rollbacks',{skip:!dsn&&'isolated PostgreSQL required'},async t=>{
 assert.match(new URL(dsn!).pathname,/^\/test_[a-z0-9_]+$/);process.env.SERIES_PG_DSN=dsn;
 const db=await openDatabase();t.after(()=>db.close());
 const a=(await db.platform().getAgentByKey('worker'))!;
 const select=async(template:string)=>{
  const p=(await db.query("INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by) SELECT $1,COALESCE(max(version),0)+1,$2,'fixture','test' FROM agent_prompts WHERE agent_id=$1 RETURNING id",[a.id,template])).rows[0]!;
  await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[a.id,p.id]);return p.id;
 };
 const old=await select(previous.worker);
 await db.query('DELETE FROM settings WHERE key=$1',[WORKER_STRATEGY_MIGRATION]);
 assert.deepEqual(await migrateWorkerStrategy(db),['worker']);
 assert.equal(await db.platform().currentPrompt(a.id),ROLE_PROMPTS.worker);
 assert.equal((await db.query('SELECT template_text FROM agent_prompts WHERE id=$1',[old])).rows[0]!.template_text,previous.worker);
 const count=(await db.query('SELECT count(*) FROM agent_prompts WHERE agent_id=$1',[a.id])).rows[0]!.count;
 await migrateWorkerStrategy(db);
 assert.equal((await db.query('SELECT count(*) FROM agent_prompts WHERE agent_id=$1',[a.id])).rows[0]!.count,count);
 await select(previous.worker);await migrateWorkerStrategy(db);
 assert.equal(await db.platform().currentPrompt(a.id),previous.worker);
 const custom=previous.worker+'\n用户自定义条款';await select(custom);
 await db.query('DELETE FROM settings WHERE key=$1',[WORKER_STRATEGY_MIGRATION]);
 assert.deepEqual(await migrateWorkerStrategy(db),[]);
 assert.equal(await db.platform().currentPrompt(a.id),custom);
});
