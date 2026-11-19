import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openDatabase} from '../db/index.js';
import {migrateWorkerInstructionCleanup,normalizeWorkerInstructions,WORKER_COMPLETION_GUIDANCE,WORKER_FACT_GUIDANCE} from './worker-fact-policy.js';
import {systemRolePrompt} from './prompts.js';

const dsn=process.env.TEST_WORKER_INSTRUCTIONS_DSN;
test('cleanup persists one new version and closing text; selecting history stays clean at read time',{skip:!dsn&&'isolated PostgreSQL required'},async()=>{
 assert.match(new URL(dsn!).pathname,/^\/test_worker_instructions_[a-z0-9_]+$/);process.env.SERIES_PG_DSN=dsn;
 const db=await openDatabase();
 try{
  const agent=await db.platform().getAgentByKey('worker');assert.ok(agent);
  const original='**边发现边写回**（写进图才算数，脑子/文字里的不算；每得一个结果立刻写，别攒到最后被步数耗尽丢掉）。三种写回，别串图：\n同一结论的相关观察合并保存；独立结论分别写回，不规定一意图通常只能写一条事实。\n用户要求：关键结论须独立复核两次，保留原始证据。';
  const row=(await db.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note)
   SELECT $1,COALESCE(MAX(version),0)+1,$2,'historical fixture' FROM agent_prompts WHERE agent_id=$1 RETURNING id`,[agent.id,original])).rows[0]!;
  const closing='边发现边写回，不必等到结束：只保存已有证据。';
  await db.query('UPDATE agents SET current_prompt_id=$2,wrapup_prompt=$3,task_timeout_wrapup_prompt=$3 WHERE id=$1',[agent.id,row.id,closing]);
  await db.query("DELETE FROM settings WHERE key='worker_instruction_cleanup_v2'");
  const count=Number((await db.query('SELECT count(*) n FROM agent_prompts WHERE agent_id=$1',[agent.id])).rows[0]!.n);
  await migrateWorkerInstructionCleanup(db);await migrateWorkerInstructionCleanup(db);
  assert.equal(Number((await db.query('SELECT count(*) n FROM agent_prompts WHERE agent_id=$1',[agent.id])).rows[0]!.n),count+1);
  assert.equal((await db.query('SELECT template_text FROM agent_prompts WHERE id=$1',[row.id])).rows[0]!.template_text,original);
  assert.equal(await db.platform().currentPrompt(agent.id),normalizeWorkerInstructions(original));
  const selected=(await db.query('SELECT wrapup_prompt,task_timeout_wrapup_prompt FROM agents WHERE id=$1',[agent.id])).rows[0]!;
  assert.equal(selected.wrapup_prompt,normalizeWorkerInstructions(closing));assert.equal(selected.task_timeout_wrapup_prompt,normalizeWorkerInstructions(closing));
  await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[agent.id,row.id]);
  const prompt=await systemRolePrompt(db,'worker');
  assert.ok(!prompt.includes('每得一个结果立刻写'));assert.ok(prompt.includes('关键结论须独立复核两次'));
  assert.equal(prompt.split(WORKER_FACT_GUIDANCE).length,2);assert.equal(prompt.split(WORKER_COMPLETION_GUIDANCE).length,2);
  assert.equal((await db.query('SELECT current_prompt_id FROM agents WHERE id=$1',[agent.id])).rows[0]!.current_prompt_id,row.id,'read-time cleanup must not mutate selected history');
 }finally{await db.close();}
});
