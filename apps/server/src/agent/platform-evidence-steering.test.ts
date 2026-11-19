import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {fauxProvider, fauxAssistantMessage} from '@earendil-works/pi-ai';
import {openDatabase} from '../db/index.js';
import {recordFactTool} from '../tools/graph.js';
import {reportFindingTool} from '../tools/findings.js';
import {runContext} from '../tools/context.js';
import {workerLaunchContext} from '../tools/context-read.js';
import {AgentRunner} from '../pi/runner.js';
import {applyEvidenceRepair, prepareEvidenceRepair} from '../evidence/repair-history-placeholder.js';
import {HISTORY_INDEX_NOTE, HISTORY_EXCERPT_NOTE, HISTORY_OMITTED_NOTE} from '../evidence/history-placeholder.js';
import {CONTEXT_LAYOUT_VERSION} from './prompt-context.js';
import {normalizeContract} from './intent-contract.js';
import {DIRECTION_AUTONOMY_POLICY, latestWorkerSteering, workerMandate} from './direction-autonomy.js';

const dsn = process.env.TEST_PLATFORM_EVIDENCE_DSN;
test('platform evidence writes, shared direction context and durable native steering', {skip: !dsn && 'isolated PostgreSQL required'}, async t => {
  assert.match(new URL(dsn!).pathname, /^\/test_[a-z0-9_]+$/);
  process.env.SERIES_PG_DSN = dsn;
  const db = await openDatabase();
  t.after(() => db.close());
  const exp = await db.createExploration('fixture', 'fixture');
  const task = Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,status) VALUES('fixture','fixture',$1,'running') RETURNING id", [exp])).rows[0]!.id);
  const graph = db.exploration(exp);
  const contract = normalizeContract({objective: '比较样本', acceptance: ['验证样本 A', '验证样本 B'], out_of_scope: ['禁止修改样本']}, 'fixture');
  const payload = {summary: 'fixture', autonomy_policy: DIRECTION_AUTONOMY_POLICY, contract};
  const first = await graph.addNode('intent', payload, 0, 'running', 'fixture', []);
  const second = await graph.addNode('intent', {...payload, summary: '其他方向'}, 0, 'running', 'fixture', []);
  await db.query("UPDATE exploration_nodes SET owner='fixture-worker' WHERE id=ANY($1::bigint[])", [[first, second]]);
  const ctx = runContext(db, task, exp, 'worker', {intentID: first, workerName: 'fixture-worker'});
  const invoke = async (tool: ReturnType<typeof recordFactTool>, args: object, id: string) => {
    const r = await tool.execute(id, args, undefined, undefined, {} as never);
    return {failed: !!r.isError, ...JSON.parse((r.content[0] as {text: string}).text)};
  };
  const facts = recordFactTool(ctx);
  const placeholder = '[历史调用正文已保存至 node:42，版本 0；用 context_get 读取 /payload/evidence]';

  await t.test('single and batch writes cannot persist projected evidence; exact replay remains idempotent', async () => {
    const bad = await invoke(facts, {summary: 'bad', evidence: placeholder}, 'bad-single');
    assert.equal(bad.failed, true);
    for (const history_note of [HISTORY_INDEX_NOTE,HISTORY_EXCERPT_NOTE,HISTORY_OMITTED_NOTE]) {
      const projected = await invoke(facts, {summary: 'invalid projection', evidence: JSON.stringify({history_omitted:true,history_note})}, 'bad-'+history_note);
      assert.equal(projected.failed, true);
    }
    const original = 'fixture original 中文😀\n'.repeat(3000);
    const mixed = await invoke(facts, {facts: [{summary: 'valid', evidence: original}, {summary: 'bad', evidence: placeholder}]}, 'mixed');
    assert.equal(mixed.failed, false);
    assert.ok(mixed.results[0].fact_id > 0);
    assert.equal(mixed.results[1].fact_id, 0);
    const saved = await graph.getNode(mixed.results[0].fact_id);
    assert.equal(saved!.payload.evidence, original);
    assert.ok(!JSON.stringify(mixed).includes(original), 'write receipt returns references rather than echoing the evidence');
    const replay = await invoke(facts, {facts: [{summary: 'valid', evidence: original}, {summary: 'bad', evidence: placeholder}]}, 'mixed');
    assert.equal(replay.results[0].fact_id, mixed.results[0].fact_id);
    assert.equal((await db.query("SELECT count(*) FROM exploration_nodes WHERE exploration_id=$1 AND kind='fact'", [exp])).rows[0]!.count, '1');
    const finding = await invoke(reportFindingTool(ctx) as ReturnType<typeof recordFactTool>, {vulnclass: 'fixture', severity: 'low', summary: 'fixture', evidence: placeholder}, 'bad-finding');
    assert.equal(finding.failed, true);
    assert.match(finding.error, /不是原始证据/);
    assert.equal((await db.query('SELECT count(*) FROM findings WHERE task_id=$1', [task])).rows[0]!.count, '0');
    await graph.link(mixed.results[0].fact_id, 'derived_from', first);
    await graph.link(mixed.results[0].fact_id, 'derived_from', second);
  });

  await t.test('launch includes related assignments, not peer transcripts', async () => {
    const context = await workerLaunchContext(ctx, first);
    assert.deepEqual(context.related_directions.map(p => p.ref), [`node:${second}`]);
    assert.equal(context.related_directions[0]!.summary, '其他方向');
  });

  await t.test('repair uses reviewed original logs and rejects unrelated, future or stale sources', async () => {
    const activity = await graph.appendActivity({node_id: first, worker: 'fixture-worker', kind: 'tool_result', tool: 'bash', detail: 'fixture original output'});
    const unrelated = await graph.appendActivity({node_id: second, worker: 'fixture-worker', kind: 'tool_result', tool: 'bash', detail: 'other output'});
    const legacy = await graph.addNode('fact', {summary: 'legacy fixture', from_intent: first, evidence: placeholder}, 0, 'confirmed', 'fixture-worker', []);
    const future = await graph.appendActivity({node_id: first, worker: 'fixture-worker', kind: 'tool_result', tool: 'bash', detail: 'later output'});
    const item = {node_id: legacy, version: 0, activity_ids: [activity]};
    await db.transaction(async tx => {
      for (const id of [unrelated, future]) await assert.rejects(() => prepareEvidenceRepair(tx, task, {...item, activity_ids: [id]}), /同一 Worker/);
      await assert.rejects(() => prepareEvidenceRepair(tx, task, {...item, version: 9}), /已变化/);
      await assert.rejects(() => prepareEvidenceRepair(tx, task + 1, item), /已变化/);
      await applyEvidenceRepair(tx, task, item);
    });
    const restored = (await graph.getNode(legacy))!;
    assert.match(String(restored.payload.evidence), /fixture original output/);
    assert.ok(!String(restored.payload.evidence).includes(placeholder));
    assert.equal(restored.content_version, 1);
    assert.match((restored.payload.evidence_repair as {previous_evidence_sha256: string}).previous_evidence_sha256, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(restored.payload).includes(placeholder), 'bad reference stays in the backup, not the model-visible fact');
    assert.equal((await db.query('SELECT detail FROM activity WHERE id=$1', [activity])).rows[0]!.detail, 'fixture original output');
    await db.transaction(tx => assert.rejects(() => applyEvidenceRepair(tx, task, item), /已变化/));
  });

  await t.test('latest steering overrides conflicting acceptance after restoration without changing authorization', async () => {
    const steer = async (intent: number, text: string, status = 'submitted') => graph.appendActivity({node_id: intent, worker: 'fixture-worker', kind: 'status', tool: 'steer_work', detail: text,
      metadata: {event_type: 'steering', steering: {status}}});
    await steer(first, 'A 已由其他 Worker 验证；停止 A，只回答 B');
    await steer(second, '其他 Worker 的私有纠偏');
    await steer(first, '未交付的消息', 'failed');
    assert.equal(await latestWorkerSteering(db, exp, first), 'A 已由其他 Worker 验证；停止 A，只回答 B');
    const dir = await mkdtemp(join(tmpdir(), 'fate-steering-'));
    const runtime = await ModelRuntime.create({authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json'), refreshOnCreate: false});
    const faux = fauxProvider({provider: 'steering-fixture'});
    await runtime.registerNativeProvider(faux.provider);
    const options = {cwd: dir, agentDir: dir, resumeSessionPath: join(dir, 'session.jsonl'), modelRuntime: runtime, model: faux.getModel(),
      systemPrompt: 'Local fixture', toolAllowlist: [], contextLayout: CONTEXT_LAYOUT_VERSION,
      boundaryContext: async () => workerMandate(first, payload, contract, '[]', await latestWorkerSteering(db, exp, first))};
    let runner: AgentRunner | undefined;
    const inspect = (expected: string) => (context: {messages: unknown[]}) => {
      const text = JSON.stringify(context.messages);
      for (const part of [expected, '已被纠偏取消的项无需补做', '禁止修改样本', '已有有效的共享事实可作为结论依据']) assert.ok(text.includes(part), part);
      assert.ok(!text.includes('其他 Worker 的私有纠偏'));
      return fauxAssistantMessage('已引用共享证据，无需重复操作');
    };
    try {
      runner = await AgentRunner.create(options);
      faux.setResponses([inspect('停止 A，只回答 B')]);
      await runner.prompt('fixture');
      await runner.dispose(); runner = undefined;
      await steer(first, 'B 也已有充分证据，结束当前意图');
      runner = await AgentRunner.create(options);
      faux.setResponses([inspect('B 也已有充分证据')]);
      await runner.prompt('恢复后核对当前工作');
      assert.deepEqual((await graph.getNode(first))!.payload.contract, contract, 'authorization contract is not rewritten by steering');
    } finally {
      await runner?.dispose();
      await rm(dir, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
    }
  });
});
