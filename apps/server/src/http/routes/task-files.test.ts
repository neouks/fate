import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { openDatabase } from '../../db/index.js';
import { lockTaskWorkspace } from '../../db/task-workspace-lock.js';
import { registerTaskFileRoutes } from './task-files.js';

const dsn = process.env.TEST_TASK_FINDINGS_DSN;
test('task workspace files are paginated, versioned and cleaned under an execution lock', {
  skip: !dsn && 'requires isolated PostgreSQL',
}, async t => {
  assert.match(new URL(dsn!).pathname, /^\/test_[a-z0-9_]+$/);
  process.env.SERIES_PG_DSN = dsn;
  const db = await openDatabase();
  t.after(() => db.close());
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'fate-task-files-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const app = Fastify();
  const otherInstance = Fastify();
  for (const instance of [app, otherInstance]) {
    instance.decorate('db', db).decorate('dataDir', dataDir);
    registerTaskFileRoutes(instance);
    t.after(() => instance.close());
  }
  const task = async () => (await db.query<{ id: string; exploration_id: string }>(`
    WITH e AS (INSERT INTO explorations(goal) VALUES ('fixture') RETURNING id)
    INSERT INTO tasks(description,goal,exploration_id) SELECT 'files','fixture',id FROM e RETURNING id,exploration_id
  `)).rows[0]!;
  const current = await task(), foreign = await task();
  const intent = async (task: typeof current, state: string) =>
    (await db.query<{ id: string }>("INSERT INTO exploration_nodes(exploration_id,kind,state) VALUES ($1,'intent',$2) RETURNING id",
      [task.exploration_id, state])).rows[0]!.id;
  const done = await intent(current, 'done'), paused = await intent(current, 'paused'), foreignIntent = await intent(foreign, 'done');
  const pending = await intent(current, 'done');
  await db.query('INSERT INTO runtime_worker_resumes(task_id,intent_id) VALUES($1,$2)', [current.id, pending]);
  const work = path.join(dataDir, 'tasks', current.id);
  const base = `/api/tasks/${current.id}/files`;
  const put = async (relative: string, content: string | Buffer, root = work) => {
    const filename = path.join(root, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content);
    return filename;
  };
  const request = async (method: 'GET' | 'POST' | 'DELETE', url: string, code = 200, payload?: object, server = app) => {
    const res = await server.inject({ method, url, payload });
    assert.equal(res.statusCode, code, res.body);
    return res;
  };
  const list = async (filters: Record<string,string> = {}) =>
    (await request('GET', base+'?'+new URLSearchParams({view:'flat',...filters}))).json();
  const content = (ref: string, extra: Record<string,string> = {}) => base+'/content?'+new URLSearchParams({ref,preview:'1',...extra});
  const single = (file: {ref:string;version:string}, code = 200) => request('DELETE', base, code, {ref:file.ref, version:file.version});
  const preview = async () => (await request('POST', base+'/cleanup/preview')).json();
  const confirm = (snapshot: string, server = app, code = 200) => request('POST', base+'/cleanup', code, {snapshot}, server);

  await put('a/脚本.sh', '#!/bin/sh\nprintf hello');
  await put('a-brief.txt', 'kept');
  await put(`i${done}/脚本.sh`, 'same name, another scope');
  await put(`i${paused}/.tmp/retain.txt`, 'recoverable');
  await put(`i${pending}/temp/pending.txt`, 'pending');
  await put(`i${foreignIntent}/tmp/foreign.txt`, 'foreign intent copied under this task');
  await put(`i${done}/nested/tmp/keep.txt`, 'not in a top-level temporary directory');
  await put('session.jsonl.owner.json', 'private');
  const outside = await put('outside.txt', 'outside', dataDir);
  await symlink(outside, path.join(work, 'linked.txt'));
  await link(outside, path.join(work, 'hardlink.txt'));
  const attachmentID = randomUUID(), attachmentPath = `artifacts/${attachmentID}/upload.txt`;
  await put(attachmentPath, 'uploaded', dataDir);
  await db.query("INSERT INTO chat_artifacts(id,task_id,name,path,mime,size,sha256) VALUES($1,$2,'upload.txt',$3,'text/plain',8,'fixture')",
    [attachmentID, current.id, attachmentPath]);
  const mixed = (await list()).items;
  assert.ok(mixed.some((row: any) => row.category === 'attachment' && !row.deletable));
  for (const hidden of ['session.jsonl.owner.json','linked.txt','hardlink.txt','foreign.txt']) assert.ok(!mixed.some((row: any) => row.name === hidden));
  const first = await list({ q: '脚本', limit: '1' });
  assert.equal(first.items[0].relative_path, 'a/脚本.sh');
  const second = await list({ q: '脚本', cursor: first.next_cursor, limit: '1' });
  assert.equal(second.items[0].relative_path, `i${done}/脚本.sh`);
  assert.equal(second.next_cursor, null);
  assert.deepEqual((await list({ intent:done, q:'nested/tmp' })).items.map((f:any) => f.name), ['keep.txt']);
  assert.equal((await list({category:'temporary'})).items.length, 2);
  const legacy = (await request('GET',base)).json();
  assert.ok(legacy.items.some((file: any) => file.ref === `work:i${done}` && file.kind === 'directory'));
  await request('GET', content('work:../outside.txt'), 400);
  for (const ref of ['work:linked.txt','work:hardlink.txt','work:session.jsonl.owner.json',`work:i${foreignIntent}/tmp/foreign.txt`]) {
    await request('GET', content(ref), 403);
  }
  await request('DELETE', base, 400, {ref:`attachment:${attachmentID}`,version:'123'});
  await request('GET', content(`attachment:${attachmentID}`).replace('/tasks/'+current.id+'/', '/tasks/'+foreign.id+'/'), 404);

  const text = 'x'.repeat(65535) + '中<script>alert(1)</script>\n';
  await put('report.html', text);
  const a = (await request('GET', content('work:report.html'))).json();
  const b = (await request('GET', content('work:report.html',{version:a.version,offset:String(a.next_offset)}))).json();
  assert.equal(a.content+b.content,text);
  assert.equal(a.next_offset,65535);
  await put('report.html', 'replaced');
  await request('GET', content('work:report.html',{version:a.version}),409);
  await put('vector.svg', '<svg onload="alert(1)"/>');
  assert.equal((await request('GET', content('work:vector.svg'))).json().preview, 'text');
  await request('GET', content('work:vector.svg',{image:'1'}),415);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR5sAAAAASUVORK5CYII=', 'base64');
  await put('image.png', png);
  assert.equal((await request('GET', content('work:image.png'))).json().preview,'image');
  const image = await request('GET', content('work:image.png',{image:'1'}));
  assert.equal(image.headers['content-type'],'image/png');
  assert.deepEqual(image.rawPayload,png);
  const big = Buffer.alloc(2*1024*1024,97);
  await put('large.txt', big);
  assert.equal((await request('GET',content('work:large.txt'))).json().preview,'too_large');
  const download = await request('GET',content('work:large.txt',{download:'1'}));
  assert.deepEqual(download.rawPayload,big);
  assert.match(String(download.headers['content-disposition']),/^attachment/);
  await put('binary.bin',Buffer.from([255,0,1]));
  assert.equal((await request('GET',content('work:binary.bin'))).json().preview,'binary');

  const script = first.items[0];
  await put('a/脚本.sh', 'new contents');
  await single(script,409);
  const row = (await list({q:'a/脚本.sh'})).items[0];
  await single(row);
  await single(row,404);
  await single((await list({q:'retain.txt'})).items[0],403);

  await put('tmp/stale.txt','before');
  await put('tmp/vanishes.txt','before');
  for (let i=0;i<28;i++) await put(`i${done}/tmp/file-${i}.txt`,'123');
  const before = await preview();
  assert.equal(before.count,30);
  assert.equal(before.bytes,96);
  assert.equal(before.skipped,2);
  assert.equal(before.sample.length,20);
  await confirm(before.snapshot,app,200).then(async result => {
    assert.equal(result.json().remaining,5);
    assert.equal(result.json().deleted,25);
  });
  const executor = randomUUID();
  await db.transaction(async tx => {
    await lockTaskWorkspace(tx, Number(current.id));
    await tx.query(`INSERT INTO runtime_role_configs(id,task_id,role,configured,effective,expires_at)
      VALUES ($1,$2,'worker','{}','{}',clock_timestamp()+interval '5 minutes')`,[executor,current.id]);
  });
  assert.equal((await preview()).busy,true);
  assert.equal((await confirm(before.snapshot,otherInstance)).json().busy,5);
  await single((await list({q:'a-brief.txt'})).items[0],409);
  await db.query('UPDATE runtime_role_configs SET finished_at=now() WHERE id=$1',[executor]);
  await put('tmp/stale.txt','replaced');
  await rm(path.join(work,'tmp/vanishes.txt'));
  await put('tmp/new.txt','created after preview');
  const final = {deleted:28,deleted_bytes:84,changed:1,missing:1,protected:0,remaining:0,busy:0};
  const responses = await Promise.all([confirm(before.snapshot),confirm(before.snapshot,otherInstance)]);
  assert.deepEqual(responses.map(response=>response.json()),[final,final]);
  await request('POST',base.replace('/tasks/'+current.id+'/', '/tasks/'+foreign.id+'/')+'/cleanup',404,{snapshot:before.snapshot});
  await access(path.join(work,'tmp/stale.txt'));
  await access(path.join(work,'tmp/new.txt'));
  await access(path.join(work,`i${paused}/.tmp/retain.txt`));
  await access(path.join(work,`i${pending}/temp/pending.txt`));
  await access(path.join(work,`i${done}/nested/tmp/keep.txt`));
  await access(path.join(dataDir,attachmentPath));
});
