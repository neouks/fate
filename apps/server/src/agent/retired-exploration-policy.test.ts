import assert from 'node:assert/strict';
import {test} from 'node:test';
import replacements from './retired-exploration-text.json' with {type:'json'};
import {retireExplorationInstructions,migrateRetiredExplorationPolicy,RETIRED_EXPLORATION_MIGRATION} from './retired-exploration-policy.js';
import {workerMandate} from './worker-assignment.js';
import {normalizeContract} from './intent-contract.js';
import {PLANNER_PROMPT,WORKER_PROMPT,hostProtocol,systemRolePrompt} from './prompts.js';
import {effectiveToolDescription} from './tool-descriptions.js';
import {addIntentTool} from '../tools/intents.js';
import {runContext} from '../tools/context.js';
import {openDatabase} from '../db/index.js';

const retired=/自主探索策略|direction-autonomy-v2|【方向级派单】|同一方向的相关步骤保持一个意图|不按接口\/参数拆单|提交前合并共享|不分别派单|不列逐项测试清单/;
const old=(scope:string)=>replacements.filter(r=>r.scope===scope).map(r=>r.before).join('\n');
const custom='自定义：保留接口 /orders/42 的原始证据，使用用户指定的 Skill；禁止写入。';

test('shipped strategy is removed from selected/default/host prompts and tool descriptions; user text survives',async()=>{
  for(const role of ['worker','planner']){
    const before=old(role)+'\n'+custom,after=retireExplorationInstructions(role,before);
    assert.doesNotMatch(after,retired);assert.ok(after.includes(custom));
    assert.equal(retireExplorationInstructions(role,after),after);
    assert.equal(retireExplorationInstructions(role,custom),custom);
    const db={platform:()=>({getAgentByKey:async()=>({id:1}),currentPrompt:async()=>before})};
    assert.doesNotMatch(await systemRolePrompt(db as never,role),retired);
    assert.doesNotMatch(hostProtocol(role),retired);
  }
  assert.doesNotMatch(PLANNER_PROMPT,retired);assert.doesNotMatch(WORKER_PROMPT,retired);
  for(const stored of [undefined,old('add_intent'),old('add_intent')+'\n'+custom]){
    const result=effectiveToolDescription('add_intent','unused',stored);
    assert.doesNotMatch(result.description,retired);
    if(stored?.includes(custom))assert.ok(result.description.includes(custom));
  }
  const tool=addIntentTool(runContext({} as never,1,1,'planner'));
  assert.doesNotMatch(JSON.stringify({description:tool.description,parameters:tool.parameters}),retired);
  assert.match(JSON.stringify(tool.parameters),/可明确接口、参数、步骤/);
});

test('historical policy markers cannot change the assignment, original requirements or validated reductions',()=>{
  const contract=normalizeContract({objective:'比较样本',acceptance:['指定步骤 A','指定步骤 B'],out_of_scope:['禁止修改样本'],allowed_tools:['read']},'读取样本');
  const plain=workerMandate(1,{summary:'读取样本'},contract,'[]',[0]);
  const legacy=workerMandate(1,{summary:'读取样本',autonomy_policy:'direction-autonomy-v2'},contract,'[]',[0]);
  assert.equal(plain,legacy);assert.doesNotMatch(legacy,retired);
  for(const value of ['指定步骤 A','指定步骤 B','禁止修改样本','停止原验收项 [0]'])assert.ok(legacy.includes(value));
  assert.deepEqual(contract.acceptance,['指定步骤 A','指定步骤 B']);
});

const dsn=process.env.TEST_RETIRED_EXPLORATION_DSN;
test('upgrade appends clean selections, survives restart/old selection, preserves history and does not merge distinct work',{skip:!dsn},async t=>{
  assert.match(new URL(dsn!).pathname,/^\/test_/);process.env.SERIES_PG_DSN=dsn;
  const db=await openDatabase();t.after(()=>db.close());
  assert.equal(await db.platform().getSetting('direction_autonomy_v2'),null,'fresh databases never install the retired strategy');
  const ids:Record<string,unknown>={};
  for(const role of ['planner','worker']){
    const agent=(await db.platform().getAgentByKey(role))!;
    const row=(await db.query(`INSERT INTO agent_prompts(agent_id,version,template_text)
      SELECT $1,COALESCE(max(version),0)+1,$2 FROM agent_prompts WHERE agent_id=$1 RETURNING id`,[agent.id,old(role)+'\n'+custom])).rows[0]!;
    ids[role]=row.id;
    await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[agent.id,row.id]);
  }
  await db.query("UPDATE tools SET description=$1,enabled=false,agents='[\"planner\"]' WHERE key='add_intent'",[old('add_intent')+'\n'+custom]);
  await db.query('DELETE FROM settings WHERE key=$1',[RETIRED_EXPLORATION_MIGRATION]);
  await migrateRetiredExplorationPolicy(db);
  const count=async()=>Number((await db.query('SELECT count(*) FROM agent_prompts')).rows[0]!.count);
  const first=await count();await migrateRetiredExplorationPolicy(db);assert.equal(await count(),first);
  for(const role of ['planner','worker']){
    const agent=(await db.platform().getAgentByKey(role))!;
    const current=await db.platform().currentPrompt(agent.id);
    assert.ok(current.includes(custom));assert.doesNotMatch(current,retired);
    assert.equal((await db.query('SELECT template_text FROM agent_prompts WHERE id=$1',[ids[role]])).rows[0]!.template_text,old(role)+'\n'+custom);
    // Explicit historical selection is sanitized at read time, not rewritten in place.
    await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[agent.id,ids[role]]);
    assert.doesNotMatch(await systemRolePrompt(db,role),retired);
  }
  const tool=(await db.query("SELECT description,enabled,agents FROM tools WHERE key='add_intent'")).rows[0]!;
  assert.equal(tool.enabled,false);assert.deepEqual(tool.agents,['planner']);assert.ok(tool.description.includes(custom));assert.doesNotMatch(tool.description,retired);
  await db.query("UPDATE tools SET enabled=true WHERE key='add_intent'");
  const exp=await db.createExploration('fixture','fixture');
  const task=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,status,paused) VALUES('fixture','fixture',$1,'running',false) RETURNING id",[exp])).rows[0]!.id);
  const add=async(summary:string)=>{
    const tool=addIntentTool(runContext(db,task,exp,'planner'));
    const response=await tool.execute('fixture-'+summary,{intents:[{summary}]},undefined,undefined,{} as never);
    assert.ok(!response.isError,JSON.stringify(response));return JSON.parse((response.content[0] as {text:string}).text).intents[0];
  };
  const a=await add('读取订单字段 A，保存原始值'),b=await add('读取订单字段 B，保存原始值');
  assert.notEqual(a.intent_id,b.intent_id);
  for(const id of [a.intent_id,b.intent_id])assert.equal((await db.exploration(exp).getNode(id))!.payload.autonomy_policy,undefined);
  assert.equal((await add('读取订单字段 A，保存原始值')).intent_id,a.intent_id,'exact duplicate work still reuses its identity');
  await db.query("UPDATE exploration_nodes SET state='paused' WHERE id=$1",[a.intent_id]);
  assert.equal((await add('读取订单字段 A，保存原始值')).intent_id,a.intent_id);
  assert.equal((await db.exploration(exp).getNode(a.intent_id))!.state,'paused');
});
