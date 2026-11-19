import historical from './fixtures/historical-assignment-prompts.json' with {type:'json'};
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PLANNER_PROMPT,WORKER_PROMPT,BASE_PLANNER_PROMPT,BASE_WORKER_PROMPT,hostProtocol,systemRolePrompt} from './prompts.js';
import {FINDING_PLANNER_GUIDANCE,FINDING_WRITE_GUIDANCE,PREVIOUS_FINDING_DESCRIPTION} from './finding-write-policy.js';
import {effectiveToolDescription} from './tool-descriptions.js';
import {migrateFindingWritePolicy} from './finding-prompt-migration.js';
import {openDatabase,type Database} from '../db/index.js';
import {runContext} from '../tools/context.js';
import {reportFindingTool} from '../tools/findings.js';
import {validateToolArguments} from '@earendil-works/pi-ai';
import {compactToolSchema} from './tool-loading.js';

test('Planner/Worker host guidance, actual tool schema and custom text agree on supplement mode',async()=>{
  assert.ok(PLANNER_PROMPT.includes(FINDING_PLANNER_GUIDANCE));
  assert.ok(WORKER_PROMPT.includes(FINDING_WRITE_GUIDANCE));
  assert.ok(hostProtocol('planner').includes(FINDING_PLANNER_GUIDANCE));
  assert.ok(hostProtocol('worker').includes(FINDING_WRITE_GUIDANCE));
  const db={platform:()=>({getAgentByKey:async()=>({id:1}),currentPrompt:async()=>'保留我的自定义正文'})} as unknown as Database;
  for(const role of ['planner','worker']){
    const result=await systemRolePrompt(db,role);
    assert.match(result,/保留我的自定义正文/);assert.match(result,/finding_id/);
    assert.match(await systemRolePrompt(db,role,{},true,'仅收尾'),/finding_id/);
  }
  const tool=reportFindingTool(runContext(db,1,1,'worker'));
  assert.match(tool.description,/finding_id,evidence_version/);
  assert.match(reportFindingTool(runContext(db,1,1,'pentest')).description,/report_conversation_finding\(/);
  for(const entry of [tool,compactToolSchema(tool)]){
    const validate=(args:Record<string,unknown>)=>validateToolArguments(entry,{type:'toolCall',id:'fixture',name:entry.name,arguments:args});
    assert.deepEqual(validate({finding_id:1,evidence_version:0,asset_ids:[2]}),{finding_id:1,evidence_version:0,asset_ids:[2]});
    assert.throws(()=>validate({finding_id:1,asset_ids:[2]}));
    assert.throws(()=>validate({}));
  }
  for(const previous of [PREVIOUS_FINDING_DESCRIPTION,PREVIOUS_FINDING_DESCRIPTION+' 通过 reproduction 保存入口、前置条件、有序利用链及真实请求/响应；缺失留空。']){
    const actual=effectiveToolDescription('report_finding','unused',previous);
    assert.equal(actual.source,'builtin');assert.match(actual.description,/finding_id,evidence_version/);
  }
  assert.deepEqual(effectiveToolDescription('report_finding','unused','我的工具说明'),{source:'custom',description:'我的工具说明'});
});

const dsn=process.env.TEST_FINDING_AMENDMENTS_DSN;
test('exact prompt migration preserves custom, disabled binding, history and explicit rollback',{
  skip:!dsn&&'isolated PostgreSQL required',
},async t=>{
  assert.match(new URL(dsn!).pathname,/^\/test_[a-z0-9_]+$/);process.env.SERIES_PG_DSN=dsn;
  const db=await openDatabase();t.after(()=>db.close());
  const previousPlanner=historical.planner.replace(FINDING_PLANNER_GUIDANCE+'\n','');
  const previousWorker=historical.worker.replace(FINDING_WRITE_GUIDANCE+'\n','');
  const set=async(role:string,text:string)=>{
    const agent=(await db.query('SELECT id FROM agents WHERE key=$1',[role])).rows[0]!;
    const prompt=(await db.query(`INSERT INTO agent_prompts(agent_id,version,template_text)
      SELECT $1,COALESCE(max(version),0)+1,$2 FROM agent_prompts WHERE agent_id=$1 RETURNING id`,[agent.id,text])).rows[0]!;
    await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[agent.id,prompt.id]);return prompt.id;
  };
  const read=async(role:string)=>String((await db.query('SELECT p.template_text FROM agents a JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key=$1',[role])).rows[0]!.template_text);
  await db.platform().setSetting('finding_supplement_policy_v1','');
  const workerOriginal=await set('worker',previousWorker);
  await set('planner',previousPlanner+'\n用户自定义内容');
  await db.query("UPDATE tools SET description=$1,enabled=false,agents='[\"worker\"]' WHERE key='report_finding'",[PREVIOUS_FINDING_DESCRIPTION]);
  const templates={planner:BASE_PLANNER_PROMPT,worker:BASE_WORKER_PROMPT};
  await migrateFindingWritePolicy(db,templates);
  assert.equal(await read('worker'),BASE_WORKER_PROMPT);
  assert.equal(await read('planner'),previousPlanner+'\n用户自定义内容');
  const config=(await db.query("SELECT * FROM tools WHERE key='report_finding'")).rows[0]!;
  assert.equal(config.enabled,false);assert.deepEqual(config.agents,['worker']);assert.match(config.description,/finding_id,evidence_version/);
  assert.equal((await db.query('SELECT template_text FROM agent_prompts WHERE id=$1',[workerOriginal])).rows[0]!.template_text,previousWorker);
  await set('worker',previousWorker);await migrateFindingWritePolicy(db,templates);
  assert.equal(await read('worker'),previousWorker,'explicit rollback after migration remains selected');
  await db.platform().setSetting('finding_supplement_policy_v1','');
  await set('worker',previousWorker+'\n自定义');await set('planner',previousPlanner);
  await db.query("UPDATE tools SET description='自定义工具正文' WHERE key='report_finding'");
  await migrateFindingWritePolicy(db,templates);
  assert.equal(await read('planner'),BASE_PLANNER_PROMPT);assert.equal(await read('worker'),previousWorker+'\n自定义');
  assert.equal((await db.query("SELECT description FROM tools WHERE key='report_finding'")).rows[0]!.description,'自定义工具正文');
});
