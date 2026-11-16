import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {openDatabase} from '../db/index.js';
import {normalizeContract} from './intent-contract.js';
import {DIRECTION_AUTONOMY_POLICY,upgradeDirectionPrompt,workerMandate} from './direction-autonomy.js';
import {AUTONOMY_MIGRATION_KEY,migrateDirectionAutonomy,rollbackDirectionAutonomy} from './direction-autonomy-migration.js';
import {addIntentTool} from '../tools/intents.js';
import {runContext} from '../tools/context.js';

test('reviewed custom Worker upgrade preserves unrelated rules and distinguishes legacy mandates',async()=>{
  const baseline=JSON.parse(await readFile(new URL('./fixtures/autonomy-reviewed-prompts.json',import.meta.url),'utf8'));
  const text=upgradeDirectionPrompt('worker',baseline.worker);
  assert.ok(text.includes('用户主动封禁、撤回、删除、异常隔离仍禁止访问'));
  assert.ok(text.includes('严禁把"版本/指纹匹配到 CVE"'));
  assert.ok(!text.includes('一意图通常只一条'));assert.ok(!text.includes('**穷尽这条意图内的手段再下结论**'));
  assert.equal(upgradeDirectionPrompt('worker',text),text);
  assert.ok(!text.includes('探索图，传 intent_id'));assert.ok(!text.includes('标 confidence（observed'));assert.ok(text.includes('observation_type'));
  const contract=normalizeContract({allowed_tools:['read'],acceptance:['原始指定步骤'],out_of_scope:['禁止其他模块']},'复核');
  const legacy=workerMandate(1,{summary:'复核'},contract,'[]');
  assert.match(legacy,/历史策略/);assert.ok(legacy.includes(JSON.stringify(contract)));
  const current=workerMandate(2,{summary:'复核',autonomy_policy:DIRECTION_AUTONOMY_POLICY},contract,'[]');
  for(const part of ['【探索目标】','【授权与禁止事项】','【证据依据】','【结果要求】','【参考线索解释】','原始指定步骤','禁止其他模块'])assert.ok(current.includes(part));
  assert.match(current,/用户明确要求的步骤和限制不是参考/);assert.match(current,/insert_assets 仅保存资产身份，不代替这条事实/);assert.match(text,/仅登记入口不等于已将线索交回 Planner/);
});

const dsn=process.env.TEST_AUTONOMY_DSN;
test('autonomy metadata and exact prompt migration preserve history, duplicate identity and operator edits',{skip:!dsn&&'isolated PostgreSQL required'},async t=>{
  assert.match(new URL(dsn!).pathname,/^\/test_/);process.env.SERIES_PG_DSN=dsn;
  const db=await openDatabase();t.after(()=>db.close());
  const baseline=JSON.parse(await readFile(new URL('./fixtures/autonomy-reviewed-prompts.json',import.meta.url),'utf8'));
  const setPrompt=async(role:string,text:string)=>{
    const a=(await db.platform().getAgentByKey(role))!;
    const existing=text===baseline[role]?(await db.query('SELECT id FROM agent_prompts WHERE agent_id=$1 AND version=32',[a.id])).rows[0]:undefined;
    const p=existing??(await db.query("INSERT INTO agent_prompts(agent_id,version,template_text) SELECT $1,GREATEST(COALESCE(max(version),0)+1,32),$2 FROM agent_prompts WHERE agent_id=$1 RETURNING id",[a.id,text])).rows[0]!;
    await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[a.id,p.id]);return p.id;
  };
  const clear=()=>db.query('DELETE FROM settings WHERE key=$1',[AUTONOMY_MIGRATION_KEY]);
  await t.test('reviewed selections append versions, idempotent restart and rollback preserve old texts',async()=>{
    await clear();const ids=[await setPrompt('planner',baseline.planner),await setPrompt('worker',baseline.worker)];
    await db.query("UPDATE tools SET description=$1,enabled=false,agents='[\"planner\"]' WHERE key='add_intent'",[baseline.add_intent]);
    const first=await migrateDirectionAutonomy(db);assert.equal(first.prompts.length,2);assert.equal(first.tools.length,1);
    const tool=(await db.query("SELECT enabled,agents FROM tools WHERE key='add_intent'")).rows[0]!;assert.equal(tool.enabled,false);assert.deepEqual(tool.agents,['planner']);
    assert.deepEqual(await migrateDirectionAutonomy(db),first);
    assert.deepEqual((await db.query('SELECT template_text FROM agent_prompts WHERE id=ANY($1::bigint[]) ORDER BY id',[ids])).rows.map(r=>r.template_text),[baseline.planner,baseline.worker]);
    const restored=await rollbackDirectionAutonomy(db);assert.equal(restored.rolled_back,true);
    assert.deepEqual((await db.query("SELECT current_prompt_id FROM agents WHERE key IN ('planner','worker') ORDER BY key")).rows.map(r=>String(r.current_prompt_id)),ids.map(String));
    assert.equal((await migrateDirectionAutonomy(db)).rolled_back,true);
    assert.equal((await db.query("SELECT description FROM tools WHERE key='add_intent'")).rows[0]!.description,baseline.add_intent);
    await db.query("UPDATE tools SET enabled=true WHERE key='add_intent'");
  });
  await t.test('unrecognized concurrent prompt edits are preserved',async()=>{
    await clear();const edited=baseline.worker+'\n自定义新增要求';await setPrompt('worker',edited);
    const result=await migrateDirectionAutonomy(db);assert.ok(result.skipped.includes('worker:unrecognized_prompt'));
    assert.equal(await db.platform().currentPrompt((await db.platform().getAgentByKey('worker'))!.id),edited);
  });
  await t.test('rollback CAS is atomic when a migrated selection was subsequently edited',async()=>{
    await clear();await setPrompt('worker',baseline.worker);await setPrompt('planner',baseline.planner);
    const applied=await migrateDirectionAutonomy(db);await setPrompt('worker','用户后续修改');
    await assert.rejects(()=>rollbackDirectionAutonomy(db),/已变化/);
    assert.equal(String((await db.query("SELECT current_prompt_id FROM agents WHERE key='planner'")).rows[0]!.current_prompt_id),String(applied.prompts.find((p:any)=>p.role==='planner').new_id));
  });
  await t.test('tool description edits prevent atomic configuration rollback',async()=>{
    await clear();await setPrompt('planner',baseline.planner);await setPrompt('worker',baseline.worker);await db.query("UPDATE tools SET description=$1 WHERE key='add_intent'",[baseline.add_intent]);const applied=await migrateDirectionAutonomy(db);assert.equal(applied.tools.length,1);await db.query("UPDATE tools SET description='用户新工具说明' WHERE key='add_intent'");
    await assert.rejects(()=>rollbackDirectionAutonomy(db),/工具说明已变化/);assert.equal(String((await db.query("SELECT current_prompt_id FROM agents WHERE key='planner'")).rows[0]!.current_prompt_id),String(applied.prompts.find((p:any)=>p.role==='planner').new_id));
  });
  await t.test('identical text selected as a newer version is not overwritten',async()=>{
    await clear();const a=(await db.platform().getAgentByKey('worker'))!;const p=(await db.query("INSERT INTO agent_prompts(agent_id,version,template_text) SELECT $1,max(version)+1,$2 FROM agent_prompts WHERE agent_id=$1 RETURNING id",[a.id,baseline.worker])).rows[0]!;await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[a.id,p.id]);
    const result=await migrateDirectionAutonomy(db);assert.ok(result.skipped.includes('worker:changed_version'));assert.equal(String((await db.query('SELECT current_prompt_id FROM agents WHERE id=$1',[a.id])).rows[0]!.current_prompt_id),String(p.id));
  });
  const exp=await db.createExploration('autonomy fixture','read local fixture');
  const task=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,status,paused) VALUES('fixture','fixture',$1,'running',false) RETURNING id",[exp])).rows[0]!.id);
  const add=async(summary:string)=>{
    const tool=addIntentTool(runContext(db,task,exp,'planner'));
    const r=await tool.execute('add-'+Math.random(),{intents:[{summary}]},undefined,undefined,{} as never);
    assert.ok(!r.isError,JSON.stringify(r));return JSON.parse((r.content[0] as {text:string}).text).intents[0];
  };
  await t.test('only new host-created intents acquire policy metadata; duplicates retain identity',async()=>{
    const fresh=await add('目录一致性探索');const stored=(await db.exploration(exp).getNode(fresh.intent_id))!;
    assert.equal(stored.payload.autonomy_policy,DIRECTION_AUTONOMY_POLICY);
    assert.equal((stored.payload.contract as any).allowed_tools,undefined);
    const duplicate=await add('目录一致性探索');assert.equal(duplicate.intent_id,fresh.intent_id);assert.equal(duplicate.created,false);
    await db.query("UPDATE exploration_nodes SET payload=payload-'autonomy_policy' WHERE id=$1",[fresh.intent_id]);
    await add('目录一致性探索');assert.equal((await db.exploration(exp).getNode(fresh.intent_id))!.payload.autonomy_policy,undefined);
  });
  await t.test('paused intent is not replaced with a new autonomous intent',async()=>{
    const saved=await add('暂停目录方向');await db.query("UPDATE exploration_nodes SET state='paused' WHERE id=$1",[saved.intent_id]);
    const result=await add('暂停目录方向');assert.equal(result.intent_id,saved.intent_id);assert.equal(result.created,false);
    assert.equal((await db.exploration(exp).getNode(saved.intent_id))!.state,'paused');
  });
});
