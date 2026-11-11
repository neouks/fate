import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { openDatabase } from '../../db/index.js';
import { FILE_CHANGE_BYTES } from '../../db/turn-file-changes.js';
import { WorkerOperationJournal } from '../../db/operation-journal.js';
import { journalTools } from '../../pi/operation-tools.js';
import { nativeWorkspaceFileTools, trackWorkspaceFileWrites } from '../../pi/workspace-file-changes.js';
import type { ToolRunContext } from '../../tools/context.js';
import { registerTurnRoutes } from './turns.js';

const dsn = process.env.TEST_TASK_FINDINGS_DSN;
test('native writes produce immutable net diffs in terminal, authorized turns', {
  skip: !dsn && 'requires an isolated PostgreSQL database',
}, async t => {
  assert.match(new URL(dsn!).pathname, /^\/test_[a-z0-9_]+$/);
  process.env.SERIES_PG_DSN = dsn;
  const db = await openDatabase();
  t.after(() => db.close());
  const app = Fastify();
  app.decorate('db', db);
  registerTurnRoutes(app);
  t.after(() => app.close());
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'fate-file-changes-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const makeTask = async () => (await db.query(`WITH exploration AS (INSERT INTO explorations(goal) VALUES ('fixture') RETURNING id)
    INSERT INTO tasks(description,goal,exploration_id) SELECT 'fixture','fixture',id FROM exploration RETURNING id,exploration_id`)).rows[0]!;
  // Keep exploration and task IDs distinct.
  await db.query("INSERT INTO explorations(goal) VALUES ('unattached')");
  const task = await makeTask(), other = await makeTask();
  const intent = Number((await db.query("INSERT INTO exploration_nodes(exploration_id,kind,state) VALUES ($1,'intent','done') RETURNING id",
    [task.exploration_id])).rows[0]!.id);
  const taskID = Number(task.id);
  const turnID = 'worker:file-changes';
  const cwd = path.join(dataDir, 'tasks', task.id, `i${intent}`);
  await mkdir(cwd, { recursive: true });
  const observedWrite = trackWorkspaceFileWrites(db, { scope: { kind: 'task', id: taskID, turnID }, taskID, intentID: intent, cwd, dataDir });
  assert.ok(observedWrite);
  const [write, edit] = nativeWorkspaceFileTools(cwd, observedWrite);
  const ctx = { cwd } as Parameters<typeof write.execute>[4];
  const put = (file: string, content: string) => write.execute('write', { path: file, content }, undefined, undefined, ctx);
  const change = (file: string, oldText: string, newText: string) =>
    edit.execute('edit', { path: file, edits: [{ oldText, newText }] }, undefined, undefined, ctx);
  const taskEvent = (event_type: string, status: string) => db.query(`INSERT INTO activity(exploration_id,node_id,kind,worker,summary,metadata)
    VALUES($1,$2,$3,'work#1','fixture',$4)`,
  [task.exploration_id, intent, event_type === 'turn_start' ? 'status' : 'result', { turn_id: turnID, event_type, status, role: 'worker' }]);
  await taskEvent('turn_start', 'running');
  await writeFile(path.join(cwd, 'existing.txt'), 'old\nunchanged\n');
  await put('existing.txt', 'middle\nunchanged\n');
  await change('existing.txt', 'middle', 'final');
  await put('existing.txt', 'final\nunchanged\n');
  await put('reports/new.txt', 'hello\nworld\n');
  await put('empty.txt', '');
  await writeFile(path.join(cwd, 'reverted.txt'), 'initial\n');
  await put('reverted.txt', 'temporary\n');
  await put('reverted.txt', 'initial\n');
  await writeFile(path.join(cwd, 'binary.dat'), Buffer.from([0xff, 0]));
  await put('binary.dat', 'now text');
  await put('big.txt', 'a'.repeat(FILE_CHANGE_BYTES + 1));
  await put('diff-limit.txt', '\n'.repeat(180_000));
  await put('diff-limit.txt', 'x\n'.repeat(120_000));
  await put('overlap.txt', 'initial\n');
  await writeFile(path.join(cwd, 'overlap.txt'), 'changed outside the tool\n');
  await put('overlap.txt', 'latest\n');
  const outside = path.join(dataDir, 'outside.txt');
  await writeFile(outside, 'outside before\n');
  await symlink(outside, path.join(cwd, 'symlink.txt'));
  await put('symlink.txt', 'outside after\n');
  await put('../outside-worker.txt', 'other workspace\n');
  await put('session.jsonl', 'runtime data\n');
  await put('session.jsonl.owner.json', 'runtime ownership\n');
  for (let i = 0; i < 25; i++) await put(`extra-${i}.txt`, 'extra\n');

  const base = `/api/tasks/${task.id}/turns`;
  const url = `${base}/${turnID}/file-changes`;
  const get = async (url: string) => {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  assert.equal((await get(`${base}?ids=${turnID}`)).items[0].file_changes, undefined);
  assert.equal((await app.inject(url)).statusCode, 404);
  await taskEvent('lifecycle', 'stopped');
  const preview = (await get(`${base}?ids=${turnID}`)).items[0].file_changes;
  assert.equal(preview.total, 32);
  assert.equal(preview.items.length, 10);
  const page1 = await get(url);
  const page2 = await get(`${url}?cursor=${page1.next_cursor}`);
  assert.equal(page1.items.length, 20);
  assert.equal(page2.items.length, 12);
  assert.equal(page2.next_cursor, null);
  const entries = Object.fromEntries([...page1.items, ...page2.items].map(row => [row.path, row]));
  assert.equal(Object.keys(entries).length, 32);
  for (const absent of ['symlink.txt', 'session.jsonl', 'session.jsonl.owner.json', 'reverted.txt', '../outside-worker.txt']) assert.equal(entries[absent], undefined);
  assert.equal(await readFile(outside, 'utf8'), 'outside after\n');
  assert.deepEqual([entries['existing.txt'].additions, entries['existing.txt'].deletions], [1, 1]);
  assert.deepEqual([entries['reports/new.txt'].kind, entries['reports/new.txt'].additions], ['added', 2]);
  assert.deepEqual([entries['empty.txt'].kind, entries['empty.txt'].additions], ['added', 0]);
  assert.equal(entries['binary.dat'].status, 'binary');
  assert.equal(entries['big.txt'].status, 'too_large');
  assert.equal(entries['diff-limit.txt'].status, 'too_large');
  assert.equal(entries['overlap.txt'].status, 'uncertain');
  await writeFile(path.join(cwd, 'existing.txt'), 'changed after the turn\n');
  const saved = await get(`${url}/${entries['existing.txt'].id}`);
  assert.match(saved.patch, /-old\n\+final/);
  assert.doesNotMatch(saved.patch, /middle|changed after/);
  assert.equal((await app.inject(`${url}/${entries['binary.dat'].id}`)).json().patch, null);
  assert.equal((await app.inject(`${url.replace(`/tasks/${task.id}/`, `/tasks/${other.id}/`)}/${saved.id}`)).statusCode, 404);
  assert.equal((await app.inject(`${url}?cursor=9223372036854775808`)).statusCode, 400);

  const conversationID = Number((await db.query("INSERT INTO conversations(agent_key,title) VALUES ('auto','fixture') RETURNING id")).rows[0]!.id);
  const conversationDir = path.join(dataDir, 'conversations', String(conversationID));
  await mkdir(conversationDir, { recursive: true });
  const conversationWrite = trackWorkspaceFileWrites(db, { scope: { kind: 'conversation', id: conversationID, turnID },
    taskID: 0, cwd: conversationDir, dataDir });
  await conversationWrite!(path.join(conversationDir, 'existing.txt'), 'conversation only\n');
  await db.query(`INSERT INTO conversation_activities(conversation_id,kind,worker,summary,metadata)
    VALUES($1,'result','assistant','fixture',$2)`,
  [conversationID, { turn_id: turnID, event_type: 'lifecycle', status: 'failed', role: 'auto' }]);
  const independent = `/api/conversations/${conversationID}/turns/${turnID}/file-changes`;
  const [entry] = (await get(independent)).items;
  assert.match((await get(`${independent}/${entry.id}`)).patch, /\+conversation only/);
  assert.equal((await app.inject(`${independent}/${saved.id}`)).statusCode, 404);

  await t.test('the native Worker operation replay does not create another file card', async () => {
    await db.query("UPDATE exploration_nodes SET state='running',owner='work#1' WHERE id=$1", [intent]);
    const ctx = { db, taskID, intentID: intent, workerName: 'work#1', hooks: {} } as ToolRunContext;
    const args = { path: 'replay.txt', content: 'original execution\n' };
    const run = async (id: string) => {
      const journal = new WorkerOperationJournal(ctx);
      await journal.start();
      const observe = trackWorkspaceFileWrites(db, { scope: { kind: 'task', id: taskID, turnID: id }, taskID, intentID: intent, cwd, dataDir });
      const [write] = nativeWorkspaceFileTools(cwd, observe);
      const result = await journalTools(journal, ctx, new Set(['write']))(write).execute(id, args, undefined, undefined,
        { cwd } as Parameters<typeof write.execute>[4]);
      await db.query(`INSERT INTO activity(exploration_id,node_id,kind,worker,summary,metadata)
        VALUES($1,$2,'result','work#1','fixture',$3)`,
      [task.exploration_id, intent, { turn_id: id, event_type: 'outcome', status: 'done' }]);
      return result.content[0];
    };
    await run('initial-write');
    await writeFile(path.join(cwd, 'replay.txt'), 'changed externally\n');
    assert.match(JSON.stringify(await run('replayed-write')), /复用 operation/);
    assert.equal(await readFile(path.join(cwd, 'replay.txt'), 'utf8'), 'changed externally\n');
    assert.equal((await get(`${base}/initial-write/file-changes`)).items.length, 1);
    assert.equal((await get(`${base}/replayed-write/file-changes`)).items.length, 0);
  });
  await db.query('UPDATE tasks SET deleted_at=now() WHERE id=$1', [taskID]);
  assert.equal((await app.inject(`${url}/${saved.id}`)).statusCode, 404);
});
