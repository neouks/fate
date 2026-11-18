import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openDatabase} from '../db/index.js';
import {proposeGoalAcceptance} from '../db/goal-integrity.js';
import {plannerConvergenceState} from './planner-convergence.js';
import {PRE_CONVERGENCE_PLANNER_PROMPT} from './prompts.js';
import {PRE_CONVERGENCE_TOOL_DESCRIPTIONS,REVIEWED_CONVERGENCE_PROVE_GOAL} from './tool-descriptions.js';
import {CONVERGENCE_MIGRATION_KEY,migratePlannerConvergence,rollbackPlannerConvergence} from './planner-convergence-migration.js';
import {addIntentTool} from '../tools/intents.js';
import {runContext} from '../tools/context.js';
const dsn=process.env.TEST_CONVERGENCE_DSN;
test('evidence convergence uses direct evidence acceptance, followups and migration ownership',{skip:!dsn&&'isolated PostgreSQL required'},async t=>{
 assert.match(new URL(dsn!).pathname,/^\/test_/);process.env.SERIES_PG_DSN=dsn;
 const db=await openDatabase();t.after(()=>db.close());
 const exp=await db.createExploration('catalog','比较 A、B 价格'),task=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,status) VALUES('catalog','比较 A、B 价格',$1,'running') RETURNING id",[exp])).rows[0]!.id);
 const graph=db.exploration(exp),goal=await graph.addGoal({text:'比较 A、B 价格'},'user');
 const intent=await graph.addNode('intent',{summary:'目录方向',execution_stop:{reason:'completed'}},0,'done','fixture',[]);
 const fact=await graph.addNode('fact',{summary:'A 不一致；B 一致',evidence:'A: 10/12; B: 20/20',from_intent:intent,observation_type:'observed',scope:{tested:'列表和两个详情',untested:'财务',limitations:'当前快照'}},0,'confirmed','worker',[]);
 await t.test('valid proof completes the goal without a human review or new work requirement',async()=>{
  const receipt=await proposeGoalAcceptance(db,task,goal,fact,'A/B 的比较');assert.equal(receipt.verification,'evidence_verified');assert.equal(receipt.met,true);assert.equal(receipt.all_goals_met,true);
  const index=await plannerConvergenceState(db,task,exp);assert.equal(index.goals[0]!.state,'met');assert.equal(String(index.goals[0]!.evidence_id),String(fact));assert.deepEqual(index.observations[0]!.scope,{tested:'列表和两个详情',untested:'财务',limitations:'当前快照'});
  assert.equal((await graph.executionCounts()).met,1);
  const foreign=await db.createExploration('other','other');await assert.rejects(plannerConvergenceState(db,task,foreign),/归属/);
 });
 await t.test('new conflicting observations remain visible and a justified followup remains admissible',async()=>{
  const contradiction=await graph.addNode('fact',{summary:'新版本 A 已变成 10/10',evidence:'New timestamp, A: 10/10',observation_type:'observed'},0,'confirmed','external-observer',[]);
  const index=await plannerConvergenceState(db,task,exp);assert.ok(index.observations.some(n=>Number(n.id)===contradiction));
  const tool=addIntentTool(runContext(db,task,exp,'planner'));
  const result=await tool.execute('new-contradiction',{intents:[{summary:'确认 A 变更后的价格一致性',contract:{objective:'仅核对新快照 A 与旧证据的矛盾',basis:[{node_id:contradiction,version:0}],acceptance:['判定变更后的 A；无需重做 B']}}]},undefined,undefined,{} as never);
  assert.ok(!result.isError,JSON.stringify(result));const body=JSON.parse((result.content[0] as {text:string}).text);assert.ok(body.intents[0].created,JSON.stringify(body));
  await db.query("UPDATE exploration_nodes SET payload=payload||'{\"evidence\":\"A source corrected\"}'::jsonb WHERE id=$1",[fact]);
  assert.equal((await plannerConvergenceState(db,task,exp)).goals[0]!.state,'open','changed evidence cannot preserve stale proof');
 });
 const planner=(await db.platform().getAgentByKey('planner'))!,worker=(await db.platform().getAgentByKey('worker'))!,workerPrompt=await db.platform().currentPrompt(worker.id);
 const select=async(text:string)=>{const p=(await db.query('INSERT INTO agent_prompts(agent_id,version,template_text) SELECT $1,COALESCE(max(version),0)+1,$2 FROM agent_prompts WHERE agent_id=$1 RETURNING id',[planner.id,text])).rows[0]!;await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[planner.id,p.id]);return p.id;};
 const reset=async()=>{await db.query('DELETE FROM settings WHERE key=$1',[CONVERGENCE_MIGRATION_KEY]);await select(PRE_CONVERGENCE_PLANNER_PROMPT);for(const key of ['add_intent','prove_goal'])await db.query('UPDATE tools SET description=$2 WHERE key=$1',[key,PRE_CONVERGENCE_TOOL_DESCRIPTIONS[key]]);};
 await t.test('append-only migration is repeatable and restores only its own configuration',async()=>{
  await reset();await db.query("UPDATE tools SET description=$1 WHERE key='prove_goal'",[REVIEWED_CONVERGENCE_PROVE_GOAL]);const old=(await db.query("SELECT current_prompt_id FROM agents WHERE key='planner'")).rows[0]!.current_prompt_id;
  const result=await migratePlannerConvergence(db);assert.equal(result.prompts.length,1);assert.equal(result.tools.length,2);assert.deepEqual(await migratePlannerConvergence(db),result);assert.equal(await db.platform().currentPrompt(worker.id),workerPrompt);
  assert.equal((await db.query('SELECT template_text FROM agent_prompts WHERE id=$1',[old])).rows[0]!.template_text,PRE_CONVERGENCE_PLANNER_PROMPT);
  await rollbackPlannerConvergence(db);assert.equal(await db.platform().currentPrompt(planner.id),PRE_CONVERGENCE_PLANNER_PROMPT);assert.equal((await migratePlannerConvergence(db)).rolled_back,true);
 });
 await t.test('concurrent prompt and description edits prevent destructive rollback',async()=>{
  await reset();const result=await migratePlannerConvergence(db);await db.query("UPDATE tools SET description='User edit' WHERE key='prove_goal'");await assert.rejects(rollbackPlannerConvergence(db),/工具说明已变化/);
  assert.equal(String((await db.query("SELECT current_prompt_id FROM agents WHERE key='planner'")).rows[0]!.current_prompt_id),String(result.prompts[0]!.new_id));
  await select('User new policy');await assert.rejects(rollbackPlannerConvergence(db),/提示词已变化/);
  await db.query('DELETE FROM settings WHERE key=$1',[CONVERGENCE_MIGRATION_KEY]);const skipped=await migratePlannerConvergence(db);assert.ok(skipped.skipped.includes('planner:unrecognized_prompt'));assert.equal(await db.platform().currentPrompt(planner.id),'User new policy');
 });
});
