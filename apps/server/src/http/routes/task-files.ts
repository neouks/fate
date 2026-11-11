import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, realpath, readdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../db/index.js';
import { lockTaskWorkspace, taskWorkspaceBusy } from '../../db/task-workspace-lock.js';

const fail = (message: string, statusCode = 400): never => { throw Object.assign(new Error(message), { statusCode }); };
const status = (error: unknown) => (error as { statusCode?: number }).statusCode;
const temporary = new Set(['tmp', '.tmp', 'temp']);
const internal = /^(?:\.git|\.series(?:[.-].*)?|\.env(?:\..*)?|jwt\.key|session(?:[.-].*)?\.jsonl(?:\..*)?)$/i;
const intentPattern = /^i([1-9]\d*)$/;
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const textLimit = 1024 * 1024;
const imageLimit = 10 * 1024 * 1024;
const snapshotLimit = 2000;
const batchSize = 25;

export function fileParts(value: string): string[] {
  if (!value || Buffer.byteLength(value) > 4096 || path.isAbsolute(value)) return fail('无效文件引用');
  const parts = value.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[\x00-\x1f\x7f\\]/.test(p) ||
    (process.platform === 'win32' && /:|[. ]$/.test(p)))) return fail('无效文件路径');
  return parts;
}

function safeFileError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return fail('文件不存在', 404);
  if (code === 'EACCES' || code === 'ELOOP' || code === 'EPERM') return fail('文件不可访问', 403);
  throw error;
}

export async function safeFilePath(root: string, relative: string) {
  try {
    const base = await realpath(root);
    let current = base;
    for (const part of fileParts(relative)) {
      current = path.join(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
        return fail('不允许访问链接或特殊文件', 403);
      }
    }
    const resolved = await realpath(current);
    const relation = path.relative(base, resolved);
    if (!relation || relation === '..' || relation.startsWith('..' + path.sep) || path.isAbsolute(relation)) {
      return fail('文件超出任务目录', 403);
    }
    return resolved;
  } catch (error) { return safeFileError(error); }
}

const versionOf = (s: Stats) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
const legacyVersion = (s: Stats) => [s.ino, s.size, s.mtimeMs].join(':');
const taskID = (raw: string) => {
  const id = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(id)) return fail('无效任务');
  return id;
};
type Intents = Map<string, { state: string; pending: boolean }>;
type Category = 'work' | 'temporary' | 'attachment';
type FileInfo = {
  ref: string;
  absolute: string;
  relative_path: string;
  name: string;
  origin: 'work' | 'attachment';
  category: Category;
  intent_id?: string;
  stat: Stats;
};
type Candidate = { ref: string; version: string; size: number };
type Removal = 'deleted' | 'changed' | 'missing' | 'protected';
type CleanupResult = Record<Removal, number> & { deleted_bytes: number };
const emptyResult = (): CleanupResult => ({ deleted: 0, changed: 0, missing: 0, protected: 0, deleted_bytes: 0 });

function imageType(data: Buffer) {
  if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
}

function deletionReason(file: FileInfo, intents: Intents, busy: boolean) {
  if (file.origin !== 'work' || !file.stat.isFile()) return '此文件只读';
  if (busy) return '任务工作区正在使用，请在执行器空闲时重试';
  if (file.intent_id) {
    const intent = intents.get(file.intent_id);
    if (intent?.state !== 'done' || intent.pending) return '意图尚未完成或仍可恢复';
  }
  return null;
}

function dto(file: FileInfo, intents: Intents, busy: boolean) {
  const reason = deletionReason(file, intents, busy);
  return {
    ref: file.ref, name: file.name, kind: file.stat.isDirectory() ? 'directory' : 'file',
    relative_path: file.relative_path, origin: file.origin, category: file.category, intent_id: file.intent_id,
    size: file.stat.size, modified_at: file.stat.mtime.toISOString(), version: versionOf(file.stat),
    deletable: !reason, delete_reason: reason,
  };
}

export function registerTaskFileRoutes(app: FastifyInstance) {
  async function owner(id: number, db = app.db, lock = false) {
    const row = (await db.query<{ exploration_id: string }>(
      'SELECT exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL' + (lock ? ' FOR SHARE' : ''), [id],
    )).rows[0];
    return row ?? fail('任务不存在或已归档', 404);
  }

  async function intentsFor(db: Database, id: number, exploration: string): Promise<Intents> {
    const { rows } = await db.query<{ id: string; state: string; pending: boolean }>(`SELECT n.id::text,n.state,
      EXISTS(SELECT 1 FROM runtime_worker_resumes r WHERE r.task_id=$1 AND r.intent_id=n.id AND r.status='pending') AS pending
      FROM exploration_nodes n WHERE n.exploration_id=$2 AND n.kind='intent'
        AND exploration_node_readable(n.exploration_id,n.id)`, [id, exploration]);
    return new Map(rows.map(({id, ...state}) => [id, state]));
  }

  async function workspaceFile(id: number, ref: string, intents: Intents): Promise<FileInfo> {
    if (!ref.startsWith('work:')) return fail('无效工作文件引用');
    const relative = ref.slice(5), parts = fileParts(relative);
    if (parts.some(part => internal.test(part))) return fail('平台内部文件不可访问', 403);
    const intent = intentPattern.exec(parts[0]!)?.[1];
    if (intent && !intents.has(intent)) return fail('意图文件未获授权', 403);
    const scope = intent ? parts.slice(1) : parts;
    const absolute = await safeFilePath(app.dataDir, `tasks/${id}/${relative}`);
    return {
      absolute, ref, relative_path: relative, name: parts.at(-1)!, intent_id: intent, origin: 'work',
      category: scope.length > 1 && temporary.has(scope[0]!) ? 'temporary' : 'work',
      stat: await lstat(absolute).catch(safeFileError),
    };
  }

  async function attachment(id: number, ref: string): Promise<FileInfo> {
    const uuid = ref.slice(11);
    if (!uuidPattern.test(uuid)) return fail('无效附件引用');
    const row = (await app.db.query('SELECT name,path FROM chat_artifacts WHERE id=$1 AND task_id=$2', [uuid, id])).rows[0];
    if (!row) return fail('附件不属于当前任务', 404);
    const relative = String(row.path);
    if (!relative.startsWith(`artifacts/${uuid}/`)) return fail('无效附件路径', 403);
    const absolute = await safeFilePath(app.dataDir, relative);
    return { absolute, ref, name: String(row.name), relative_path: String(row.name), origin: 'attachment', category: 'attachment', stat: await lstat(absolute).catch(safeFileError) };
  }

  function allowedEntry(error: unknown) {
    if (![400, 403, 404].includes(status(error) ?? 0)) throw error;
  }

  async function* attachments(id: number, after: string): AsyncGenerator<FileInfo> {
    if (after.startsWith('work:')) return;
    let cursor = after.startsWith('attachment:') ? after.slice(11) : '';
    for (;;) {
      const { rows } = await app.db.query('SELECT id FROM chat_artifacts WHERE task_id=$1 AND id>$2 ORDER BY id LIMIT 100', [id, cursor]);
      for (const {id: refID} of rows) {
        cursor = String(refID);
        try { yield await attachment(id, `attachment:${cursor}`); } catch (error) { allowedEntry(error); }
      }
      if (rows.length < 100) return;
    }
  }

  async function* walk(id: number, intents: Intents, after: string, onlyIntent?: string, tempOnly = false, dir = ''): AsyncGenerator<FileInfo> {
    let entries;
    try {
      const absolute = await safeFilePath(app.dataDir, `tasks/${id}${dir ? '/' + dir : ''}`);
      entries = await readdir(absolute, { withFileTypes: true }).catch(safeFileError);
    } catch (error) { allowedEntry(error); return; }
    const sortKey = (item: typeof entries[number]) => item.name + (item.isDirectory() ? '/' : '');
    entries.sort((a, b) => sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0);
    for (const item of entries) {
      if (internal.test(item.name) || (!item.isFile() && !item.isDirectory())) continue;
      const relative = dir ? `${dir}/${item.name}` : item.name, ref = `work:${relative}`;
      const intent = !dir ? intentPattern.exec(item.name)?.[1] : undefined;
      if (intent && !intents.has(intent)) continue;
      if (!dir && onlyIntent && intent !== onlyIntent) continue;
      // Only these directory roots can be selected by the cleanup preview.
      if (tempOnly && (!dir || intentPattern.test(dir)) && !intent && !temporary.has(item.name)) continue;
      try { fileParts(relative); } catch (error) { allowedEntry(error); continue; }
      if (item.isDirectory()) {
        const prefix = ref + '/';
        if (after >= prefix && !after.startsWith(prefix)) continue;
        yield* walk(id, intents, after, onlyIntent, tempOnly, relative);
      } else if (ref > after) {
        try { yield await workspaceFile(id, ref, intents); } catch (error) { allowedEntry(error); }
      }
    }
  }

  app.get('/api/tasks/:id/files', async (req, reply) => {
    const id = taskID((req.params as { id: string }).id), q = req.query as Record<string, string | undefined>;
    const task = await owner(id);
    const [intents, busy] = await Promise.all([intentsFor(app.db, id, task.exploration_id), taskWorkspaceBusy(app.db, id)]);
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(q.limit) || 100)));
    const after = typeof q.cursor === 'string' ? q.cursor : '';
    const items: ReturnType<typeof dto>[] = [];
    reply.header('Cache-Control', 'private, no-store');
    if (q.view === 'flat') {
      const category = q.category ?? 'all', intent = q.intent || undefined;
      if (!['all', 'work', 'temporary', 'attachment'].includes(category) ||
          (intent && (typeof intent !== 'string' || !/^[1-9]\d*$/.test(intent)))) return fail('无效文件筛选');
      const query = String(q.q ?? '').trim().slice(0, 240).toLowerCase();
      async function* files() {
        if (!intent && (category === 'all' || category === 'attachment')) yield* attachments(id, after);
        if (category !== 'attachment') yield* walk(id, intents, after, intent, category === 'temporary');
      }
      for await (const file of files()) {
        if (!file.stat.isFile() || (category !== 'all' && file.category !== category)) continue;
        if (query && ![file.name, file.relative_path].some(value => value.toLowerCase().includes(query))) continue;
        items.push(dto(file, intents, busy));
        if (items.length > limit) break;
      }
    } else {
      const refs: string[] = [];
      if (q.ref) {
        const dir = await workspaceFile(id, String(q.ref), intents);
        if (!dir.stat.isDirectory()) return fail('不是目录');
        refs.push(...(await readdir(dir.absolute).catch(safeFileError)).map(name => `${q.ref}/${name}`));
      } else {
        for await (const file of attachments(id, after)) {
          items.push(dto(file, intents, busy));
          if (items.length > limit) break;
        }
        refs.push(...[...intents.keys()].map(intent => `work:i${intent}`));
      }
      for (const ref of refs.sort()) {
        if (items.length > limit) break;
        if (ref <= after) continue;
        try { items.push(dto(await workspaceFile(id, ref, intents), intents, busy)); }
        catch (error) { allowedEntry(error); }
      }
    }
    return { items: items.slice(0, limit), next_cursor: items.length > limit ? items[limit - 1]!.ref : null, busy };
  });

  app.get('/api/tasks/:id/files/content', async (req, reply) => {
    const id = taskID((req.params as { id: string }).id), q = req.query as Record<string, string>;
    const task = await owner(id);
    const ref = typeof q.ref === 'string' ? q.ref : '';
    const file = ref.startsWith('attachment:') ? await attachment(id, ref) : await workspaceFile(id, ref, await intentsFor(app.db, id, task.exploration_id));
    if (!file.stat.isFile()) return fail('不是普通文件');
    const handle = await open(file.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(safeFileError);
    let streamed = false;
    try {
      const stat = await handle.stat();
      const latestPath = await safeFilePath(app.dataDir, path.relative(await realpath(app.dataDir), file.absolute).split(path.sep).join('/'));
      if (!stat.isFile() || stat.nlink !== 1 || versionOf(await lstat(latestPath)) !== versionOf(stat)) return fail('文件已变化，请刷新', 409);
      const version = versionOf(stat);
      if (q.version && q.version !== version && q.version !== legacyVersion(stat)) return fail('文件已变化，请刷新', 409);
      reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
      if (q.download === '1') {
        reply.type('application/octet-stream').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`);
        if (!stat.size) return reply.send(Buffer.alloc(0));
        streamed = true;
        return reply.send(handle.createReadStream({ autoClose: true, start: 0, end: stat.size - 1 }));
      }
      const prefix = Buffer.alloc(Math.min(stat.size, 12));
      if (prefix.length) await handle.read(prefix, 0, prefix.length, 0);
      const image = imageType(prefix);
      const tooLarge = (q.preview === '1' || q.image === '1') && stat.size > (image ? imageLimit : textLimit);
      if (q.image === '1') {
        if (!image || tooLarge) return fail('图片无法在线预览', 415);
        const data = Buffer.alloc(stat.size);
        const { bytesRead } = await handle.read(data, 0, data.length, 0);
        if (bytesRead !== stat.size || versionOf(await handle.stat()) !== version || imageType(data) !== image) return fail('文件已变化，请刷新', 409);
        return reply.type(image).header('Content-Security-Policy', "default-src 'none'; sandbox").send(data);
      }
      const offset = Number(q.offset ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size) return fail('无效读取位置');
      let content = '', end = offset, preview: 'text' | 'image' | 'binary' | 'too_large' = tooLarge ? 'too_large' : image ? 'image' : 'text';
      if (preview === 'text') {
        const buffer = Buffer.alloc(Math.min(65536, stat.size - offset));
        const { bytesRead } = buffer.length ? await handle.read(buffer, 0, buffer.length, offset) : { bytesRead: 0 };
        let length = bytesRead;
        if (length && offset + length < stat.size) {
          let start = length - 1;
          while (start >= 0 && (buffer[start]! & 0xc0) === 0x80) start--;
          if (start >= 0) {
            const byte = buffer[start]!, width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
            if (start + width > length) length = start;
          }
        }
        try {
          content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
          if (content.includes('\0') || (length === 0 && offset < stat.size)) preview = 'binary';
          else end += length;
        } catch { preview = 'binary'; }
      }
      if (versionOf(await handle.stat()) !== version) return fail('文件正在变化，请刷新', 409);
      return { ref, version, offset, next_offset: end, total: stat.size, preview, has_more: preview === 'text' && end < stat.size,
        binary: preview !== 'text', content: preview === 'text' ? content : '' };
    } catch (error) { return safeFileError(error); } finally { if (!streamed) await handle.close(); }
  });

  async function withCleanupLock<T>(id: number, act: (db: Database, intents: Intents, busy: boolean) => Promise<T>) {
    return app.db.transaction(async tx => {
      await lockTaskWorkspace(tx, id);
      const task = await owner(id, tx, true);
      const graphLocked = (await tx.query('SELECT pg_try_advisory_xact_lock(-$1::bigint) AS locked', [task.exploration_id])).rows[0]?.locked === true;
      const busy = !graphLocked || await taskWorkspaceBusy(tx, id);
      return act(tx, busy ? new Map() : await intentsFor(tx, id, task.exploration_id), busy);
    });
  }

  async function remove(id: number, candidate: Candidate, intents: Intents, tempOnly: boolean): Promise<Removal> {
    try {
      const file = await workspaceFile(id, candidate.ref, intents);
      if (deletionReason(file, intents, false) || (tempOnly && file.category !== 'temporary')) return 'protected';
      if (versionOf(file.stat) !== candidate.version) return 'changed';
      await unlink(file.absolute).catch(safeFileError);
      return 'deleted';
    } catch (error) {
      if (status(error) === 404) return 'missing';
      if ([400, 403].includes(status(error) ?? 0)) return 'protected';
      throw error;
    }
  }

  app.delete('/api/tasks/:id/files', async (req, reply) => {
    const id = taskID((req.params as { id: string }).id);
    const {ref, version} = (req.body ?? {}) as Partial<Candidate>;
    if (typeof ref !== 'string' || !ref.startsWith('work:') || typeof version !== 'string' || version.length > 200) return fail('需要工作文件引用及文件版本');
    const result = await withCleanupLock(id, async (_tx, intents, busy) => {
      if (busy) return fail('任务工作区正在使用，请在执行器空闲时重试', 409);
      return remove(id, {ref, version, size: 0}, intents, false);
    });
    if (result === 'changed') return fail('文件已变化，请刷新后重新确认', 409);
    if (result === 'protected') return fail('此文件受保护或意图仍可恢复', 403);
    if (result === 'missing') return fail('文件不存在', 404);
    return reply.send({ deleted: true });
  });

  app.post('/api/tasks/:id/files/cleanup/preview', async (req, reply) => {
    const id = taskID((req.params as { id: string }).id);
    const task = await owner(id);
    const [intents, busy] = await Promise.all([intentsFor(app.db, id, task.exploration_id), taskWorkspaceBusy(app.db, id)]);
    const candidates: Candidate[] = [];
    const sample: { path: string; size: number }[] = [];
    let skipped = 0, bytes = 0, has_more = false;
    for await (const file of walk(id, intents, '', undefined, true)) {
      if (file.category !== 'temporary' || !file.stat.isFile()) continue;
      if (deletionReason(file, intents, false)) { skipped++; continue; }
      if (candidates.length === snapshotLimit) { has_more = true; break; }
      candidates.push({ ref: file.ref, version: versionOf(file.stat), size: file.stat.size });
      if (sample.length < 20) sample.push({ path: file.relative_path, size: file.stat.size });
      bytes += file.stat.size;
    }
    await app.db.query('DELETE FROM task_file_cleanups WHERE id IN (SELECT id FROM task_file_cleanups WHERE expires_at<=clock_timestamp() LIMIT 100)');
    const snapshot = candidates.length && !busy ? randomUUID() : null;
    if (snapshot) await app.db.query('INSERT INTO task_file_cleanups(id,task_id,candidates) VALUES($1,$2,$3::jsonb)', [snapshot, id, JSON.stringify(candidates)]);
    reply.header('Cache-Control', 'private, no-store');
    return { snapshot, count: candidates.length, bytes, sample, skipped, busy, has_more };
  });

  app.post('/api/tasks/:id/files/cleanup', async (req, reply) => {
    const id = taskID((req.params as { id: string }).id);
    const {snapshot} = (req.body ?? {}) as { snapshot?: string };
    if (typeof snapshot !== 'string' || !uuidPattern.test(snapshot)) return fail('无效清理快照');
    reply.header('Cache-Control', 'private, no-store');
    return withCleanupLock(id, async (tx, intents, busy) => {
      const row = (await tx.query<{ candidates: Candidate[]; position: number; result: Partial<CleanupResult> }>(
        'SELECT candidates,position,result FROM task_file_cleanups WHERE id=$1 AND task_id=$2 AND expires_at>clock_timestamp() FOR UPDATE', [snapshot, id],
      )).rows[0];
      if (!row) return fail('清理快照已过期或不存在，请重新预览', 404);
      const result = { ...emptyResult(), ...row.result };
      const remaining = row.candidates.length - row.position;
      if (!remaining || busy) return { ...result, remaining, busy: remaining ? remaining : 0 };
      const batch = row.candidates.slice(row.position, row.position + batchSize);
      for (const candidate of batch) {
        const outcome = await remove(id, candidate, intents, true);
        result[outcome]++;
        if (outcome === 'deleted') result.deleted_bytes += candidate.size;
      }
      await tx.query('UPDATE task_file_cleanups SET position=$2,result=$3::jsonb WHERE id=$1', [snapshot, row.position + batch.length, JSON.stringify(result)]);
      return { ...result, remaining: remaining - batch.length, busy: 0 };
    });
  });
}
