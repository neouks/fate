import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../db/index.js';
import {Engine, defaultEngineConfig} from '../engine/engine.js';
import {workerSessionFile} from '../agent/roles.js';
import {runContext} from './context.js';
import {addIntentTool, killWorkTool} from './intents.js';

const dsn = process.env.TEST_INTENT_REPLACEMENT_DSN;
test('objective replacement stops the old worker before dispatch and never revives user-paused work',
  {skip: !dsn && 'isolated PostgreSQL required'}, async t => {
  assert.match(new URL(dsn!).pathname, /^\/test_[a-z0-9_]+$/);
  process.env.SERIES_PG_DSN = dsn;
  const db = await openDatabase(), dir = await mkdtemp(join(tmpdir(), 'fate-replacement-'));
  const engine = new Engine(db, defaultEngineConfig(), async () => {throw new Error('No model requests in this fixture');}, dir);
  t.after(async () => {await engine.shutdown(); await db.close(); await rm(dir, {recursive: true, force: true});});
  const exp = await db.createExploration('fixture', 'compare local fixtures');
  const task = Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,status) VALUES('fixture','fixture',$1,'running') RETURNING id", [exp])).rows[0]!.id);
  const graph = db.exploration(exp), internals = engine as any;
  const rt = await internals.loadRuntime(task);
  rt.lease = await internals.coordinator.acquire(task); rt.started = true;
  const ctx = runContext(db, task, exp, 'planner', {hooks: {killWork: async (_exp, id, reason, source) => engine.killWork(task, id, reason, source)}});
  let call = 0;
  const invoke = async (tool: ReturnType<typeof addIntentTool> | ReturnType<typeof killWorkTool>, args: object) => {
    const result = await tool.execute(`fixture-${++call}`, args, undefined, undefined, {} as never);
    return {failed: !!result.isError, ...JSON.parse((result.content[0] as {text: string}).text)};
  };
  const add = (summary: string, replaces_intent_id?: number) => invoke(addIntentTool(ctx), {intents: [{summary, replaces_intent_id}]});
  const kill = (id: number) => invoke(killWorkTool(ctx), {intent_id: id, reason: '业务目标已变化'});
  const count = async () => Number((await db.query("SELECT count(*) FROM exploration_nodes WHERE exploration_id=$1 AND kind='intent'", [exp])).rows[0]!.count);

  await t.test('running worker must finish cancellation before a replacement can enter the frontier', async () => {
    const original = (await add('比较本地样本 A')).ids[0];
    await graph.setIntentState(original, 'running');
    let aborted!: () => void, finish!: () => void;
    const abortedPromise = new Promise<void>(resolve => {aborted = resolve;});
    const done = new Promise<void>(resolve => {finish = resolve;});
    rt.work.set(original, {abort: async () => {aborted();}, done});
    try {
      const stopping = kill(original);
      await abortedPromise;
      const before = await count();
      const early = await add('比较本地样本 B', original);
      assert.equal(early.failed, true); assert.match(early.error, /已经结束/);
      assert.equal(await count(), before);
      await graph.setIntentState(original, 'stopped');
      finish(); rt.work.delete(original);
      const stopped = await stopping;
      assert.equal(stopped.failed, false); assert.equal(stopped.state, 'stopped');
      const created = await add('比较本地样本 B', original);
      assert.equal(created.failed, false); assert.equal(created.submitted, 1);
      assert.notEqual(created.ids[0], original);
      assert.notEqual(workerSessionFile(dir, exp, created.ids[0]), workerSessionFile(dir, exp, original));
      assert.equal((await graph.getNode(created.ids[0]))!.payload.replaces_intent_id, original);
      const replay = await add('比较本地样本 B', original);
      assert.equal(replay.failed, false); assert.deepEqual(replay.ids, created.ids); assert.equal(replay.submitted, 0);
      const conflict = await add('比较本地样本 C', original);
      assert.equal(conflict.failed, true); assert.match(conflict.error, /已由.*替代/);
      assert.equal((await graph.getNode(original))!.state, 'stopped');
    } finally {finish(); rt.work.delete(original);}
  });

  await t.test('queued intent can be stopped; a persisted stopped state alone does not prove the executor exited', async () => {
    const original = (await add('本地队列样本 D')).ids[0];
    assert.equal((await kill(original)).state, 'stopped');
    assert.equal((await kill(original)).state, 'stopped', 'stop receipt is retryable');
    const slot = await internals.coordinator.workerSlot(task, rt.lease);
    assert.ok(slot);
    await db.query('UPDATE engine_worker_slots SET intent_id=$2 WHERE id=$1', [slot, original]);
    try {
      const blocked = await add('本地队列样本 E', original);
      assert.equal(blocked.failed, true); assert.match(blocked.error, /尚未退出/);
    } finally {await internals.coordinator.releaseSlot(slot);}
    assert.equal((await add('本地队列样本 E', original)).failed, false);
  });

  await t.test('pause, cancellation, foreign IDs, same objectives and conflicting batches cannot create replacements', async () => {
    for (const state of ['paused', 'stopped']) {
      const original = (await add(`受用户控制的本地样本 ${state}`)).ids[0];
      await graph.setIntentState(original, state);
      if (state === 'stopped') await db.query("UPDATE exploration_nodes SET payload=payload||'{\"cancelled_by_user\":true}'::jsonb WHERE id=$1", [original]);
      assert.equal((await kill(original)).failed, true);
      assert.equal((await add(`替代受控样本 ${state}`, original)).failed, true);
    }
    const otherExp = await db.createExploration('other', 'other');
    const foreign = await db.exploration(otherExp).addNode('intent', {summary: 'foreign'}, 0, 'stopped', 'fixture', []);
    assert.equal((await add('不能替代其他任务', foreign)).failed, true);
    const original = (await add('相同目标样本 F')).ids[0];
    await kill(original);
    assert.equal((await add('相同目标样本 F', original)).failed, true);
    const before = await count();
    const mixed = await invoke(addIntentTool(ctx), {intents: [{summary: '本地样本 G', replaces_intent_id: original}, {summary: '本地样本 H', replaces_intent_id: foreign}]});
    assert.equal(mixed.failed, true); assert.equal(await count(), before, 'invalid batch rolls back all new intents');
    const dual = await invoke(addIntentTool(ctx), {intents: [{summary: '冲突参数', replaces_intent_id: original, retry_of: original}]});
    assert.equal(dual.failed, true);
  });
});
