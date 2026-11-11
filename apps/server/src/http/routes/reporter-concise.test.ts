import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { migrateReporterConcisePrompt } from '../../agent/reproduction-migration.js';
import { REPORTER_PROMPT, REPORTER_REPRO_PROMPT, systemRolePrompt } from '../../agent/prompts.js';
import { openDatabase } from '../../db/index.js';
import { reportSections } from '../../evidence/report-sections.js';
import { AgentRunner, type RunnerActivity } from '../../pi/runner.js';
import { runContext } from '../../tools/context.js';
import { conversationDomainTools } from '../../tools/conversations.js';
import { registerFindingReproductionRoutes } from './finding-reproduction.js';
import { makeFindingsExportHandler } from './findings-extra.js';

const concise = { description:'未登录也能查看他人的订单详情。', impact:[], remediation:['在读取订单前检查登录状态和订单归属。'] };
const sixty = '例A，1😀'.repeat(12);

test('Reporter counts Unicode characters after trimming and leaves unsupported discovery fields empty', () => {
  const boundary = { description:` ${sixty} `, impact:[], remediation:[], discovery:{ vulnerability:sixty, asset:sixty } };
  assert.deepEqual(reportSections(boundary,true),{...boundary,description:sixty});
  for (const [key, label] of [['description','漏洞描述'],['vulnerability','漏洞发现思路'],['asset','资产发现思路']] as const) {
    const invalid = key === 'description' ? {...boundary,description:sixty+'！'} : {...boundary,discovery:{...boundary.discovery,[key]:sixty+'！'}};
    assert.throws(()=>reportSections(invalid,true), new RegExp(`${label}实际 61 字，上限 60 字`));
  }
  assert.deepEqual(reportSections({...concise,discovery:{asset:' '}},true).discovery,{});
  assert.throws(()=>reportSections(concise,true),/需要 report_sections.discovery/);
  assert.equal(reportSections({...concise,description:sixty+'！'}).description,sixty+'！');
});

const dsn=process.env.TEST_TASK_FINDINGS_DSN;
test('native Reporter corrects an overlong report, and detail, manual edits and export preserve evidence', {
  skip: !dsn && 'requires isolated PostgreSQL',
}, async t=>{
  assert.match(new URL(dsn!).pathname,/^\/test_[a-z0-9_]+$/);
  process.env.SERIES_PG_DSN=dsn;
  const db=await openDatabase();
  t.after(()=>db.close());
  const directory=await mkdtemp(join(tmpdir(),'fate-reporter-concise-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const app=Fastify();
  app.decorate('db',db);
  registerFindingReproductionRoutes(app);
  app.get('/api/exploration/findings/export',makeFindingsExportHandler(app));
  t.after(()=>app.close());

  const {id:taskID,exploration_id:expID}=(await db.query(`WITH e AS (INSERT INTO explorations(goal) VALUES ('fixture') RETURNING id)
    INSERT INTO tasks(description,goal,exploration_id) SELECT 'fixture','fixture',id FROM e RETURNING id,exploration_id`)).rows[0]!;
  const request='GET /orders/42 HTTP/1.1';
  const response='HTTP/1.1 200 OK\r\n\r\n{"owner":"fixture"}';
  const evidence=request+'\n'+response;
  const repro={entry_point:'/orders/42',prerequisites:[],provenance:'历史资产及发现过程原文',steps:[
    {id:'original-step',action:'打开订单详情',request,response,proves:'未登录也能读取订单',source:'evidence',verified:true},
  ]};
  const finding=Number((await db.query(`INSERT INTO findings(task_id,name,vulnclass,severity,status,evidence,report,reproduction,evidence_version,report_evidence_version,report_revision)
    VALUES ($1,'合成订单问题','越权','high','confirmed',$2,'历史报告正文',$3,2,2,5) RETURNING id`,[taskID,evidence,repro])).rows[0]!.id);
  const base=`/api/exploration/findings/${finding}`;
  const old=await app.inject(base+'/reproduction');
  assert.equal(old.statusCode,200,old.body);
  assert.match(old.json().markdown,/## 发现来源\n历史资产及发现过程原文/);

  const args={finding_id:finding,evidence_version:2,report_revision:5};
  const discovery={vulnerability:'未登录打开订单详情，页面仍显示他人的订单。',asset:'订单列表的链接指向订单详情页。'};
  const faux=fauxProvider({provider:'reporter-concise'});
  const modelRuntime=await ModelRuntime.create({authPath:join(directory,'auth.json'),modelsPath:join(directory,'models.json'),refreshOnCreate:false});
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('get_finding',{finding_id:finding})]),
    fauxAssistantMessage([fauxToolCall('update_finding_report',{...args,report_sections:{...concise,discovery:{...discovery,vulnerability:sixty+'！'}}})]),
    fauxAssistantMessage([fauxToolCall('update_finding_report',{...args,report_sections:{...concise,discovery}})]),
    fauxAssistantMessage('保存完成'),
  ]);
  const activities:RunnerActivity[]=[];
  let saved=false;
  const tools=conversationDomainTools(runContext(db,Number(taskID),Number(expID),'reporter'),{} as never,{onSaved:()=>{saved=true;}});
  const runner=await AgentRunner.create({
    cwd:directory,agentDir:directory,inMemory:true,modelRuntime,model:faux.getModel(),
    systemPrompt:await systemRolePrompt(db,'reporter'),toolAllowlist:tools.map(tool=>tool.name),customTools:tools,
    maxTurns:6,maxDurationMs:10000,onActivity:activity=>{activities.push(activity);},
  });
  try { await runner.prompt('整理合成漏洞报告'); } finally { await runner.dispose(); }
  assert.ok(saved);
  assert.ok(activities.some(activity=>activity.kind==='tool_end'&&activity.toolName==='update_finding_report'&&activity.text?.includes('漏洞发现思路实际 61 字')));
  const detail=(await app.inject(base+'/reproduction')).json();
  assert.equal(detail.report_revision,6);
  assert.deepEqual(detail.report_sections,{...concise,discovery});
  assert.deepEqual(detail.reproduction,repro);
  const reportText=detail.markdown;
  for(const [label,value] of [['漏洞发现思路',discovery.vulnerability],['资产发现思路',discovery.asset]])
    assert.ok(reportText.includes(`## ${label}\n${value}`));
  assert.ok(!reportText.includes('## 发现来源'));
  assert.ok(!reportText.includes('## 具体影响'));
  assert.ok(reportText.includes(response));
  const previous=await app.inject(base+'/report-versions/5');
  assert.equal(previous.json().report,'历史报告正文');
  assert.deepEqual(previous.json().reproduction,repro);

  const edit=await app.inject({method:'PATCH',url:base+'/reproduction',payload:{
    evidence_version:2,report_revision:6,reproduction:repro,report_sections:{...concise,description:'未登录可以读取订单。'},
  }});
  assert.equal(edit.statusCode,200,edit.body);
  const updated=(await app.inject(base+'/reproduction')).json();
  assert.deepEqual(updated.report_sections.discovery,discovery);
  const exportResponse=await app.inject(`/api/exploration/findings/export?context_task=${taskID}&scope=selected&ids=${finding}&format=md`);
  assert.equal(exportResponse.statusCode,200,exportResponse.body);
  assert.ok(exportResponse.body.startsWith('# 发现导出\n\n'+updated.markdown+'\n'));

  await t.test('prompt migration is exact, idempotent and preserves previous versions and custom selections',async()=>{
    const {id}=await db.platform().getAgentByKey('reporter');
    const select=async (template:string)=>{
      const row=(await db.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by)
        SELECT $1,COALESCE(max(version),0)+1,$2,'fixture','test' FROM agent_prompts WHERE agent_id=$1 RETURNING id`,[id,template])).rows[0]!;
      await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[id,row.id]);
      return row.id;
    };
    const previous=await select(REPORTER_REPRO_PROMPT);
    await db.platform().setSetting('finding_report_concise_v1','');
    await migrateReporterConcisePrompt(db);
    assert.equal(await db.platform().currentPrompt(id),REPORTER_PROMPT);
    assert.equal((await db.query('SELECT template_text FROM agent_prompts WHERE id=$1',[previous])).rows[0]?.template_text,REPORTER_REPRO_PROMPT);
    await select(REPORTER_REPRO_PROMPT);
    await migrateReporterConcisePrompt(db);
    assert.equal(await db.platform().currentPrompt(id),REPORTER_REPRO_PROMPT);
    const custom=REPORTER_REPRO_PROMPT+'\n自定义：保留人工作者习惯。';
    await select(custom);
    await db.platform().setSetting('finding_report_concise_v1','');
    await migrateReporterConcisePrompt(db);
    assert.equal(await db.platform().currentPrompt(id),custom);
  });
});
