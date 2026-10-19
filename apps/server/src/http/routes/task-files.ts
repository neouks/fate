import type { FastifyInstance } from 'fastify';
import { constants } from 'node:fs';
import { lstat, realpath, readdir, open } from 'node:fs/promises';
import path from 'node:path';
import { resolveGraphNode } from '../../db/graph_view.js';

const fail = (message: string, statusCode = 400): never => { throw Object.assign(new Error(message), { statusCode }); };
export function fileParts(value: string): string[] {
  if (!value || value.includes('\\') || value.includes('\0') || path.isAbsolute(value)) return fail('无效文件引用');
  const parts = value.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) return fail('无效文件路径');
  return parts;
}
/** Reject symbolic links at every component, including task/intent directories. */
export async function safeFilePath(root: string, relative: string) {
  try {
  const base = await realpath(root);
  let current = base;
  for (const part of fileParts(relative)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) return fail('不允许访问符号链接', 403);
  }
  const resolved = await realpath(current);
  if (!resolved.startsWith(base + path.sep)) return fail('文件超出任务目录', 403);
  return resolved;
  } catch (error) {
    const code=(error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return fail('文件不存在', 404);
    if (code === 'EACCES' || code === 'ELOOP') return fail('文件不可读取', 403);
    throw error;
  }
}
function safeFileError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return fail('文件不存在', 404);
  if (code === 'EACCES' || code === 'ELOOP') return fail('文件不可读取', 403);
  throw error;
}
export function registerTaskFileRoutes(app: FastifyInstance) {
  async function task(id: number) {
    if (!Number.isSafeInteger(id) || id < 1) return fail('无效任务');
    const row = await app.db.tasks().getTask(id);
    if (!row) return fail('任务不存在或已归档', 404);
    return row;
  }
  async function resolve(id: number, ref: string) {
    const owner = await task(id);
    if (ref.startsWith('attachment:')) {
      const uuid = ref.slice(11);
      if (!/^[a-f\d-]{36}$/i.test(uuid)) return fail('无效附件引用');
      const row = (await app.db.query('SELECT name,path FROM chat_artifacts WHERE id=$1 AND task_id=$2', [uuid, id])).rows[0];
      if (!row) return fail('附件不属于当前任务', 404);
      const relative = String(row.path);
      if (!relative.startsWith(`artifacts/${uuid}/`)) return fail('无效附件路径', 403);
      return { absolute: await safeFilePath(app.dataDir, relative), origin: 'attachment', name: String(row.name), intent_id: undefined as string | undefined };
    }
    if (!ref.startsWith('work:')) return fail('无效文件引用');
    const parts = fileParts(ref.slice(5));
    if (!/^i[1-9]\d*$/.test(parts[0]!)) return fail('无效意图目录');
    const intent = Number(parts[0]!.slice(1));
    const node = await resolveGraphNode(app.db, id, owner.exploration_id, intent).catch(() => fail('意图文件未获授权', 403));
    if (node.inherited || node.node.kind !== 'intent') return fail('来源任务文件不可遍历', 403);
    return { absolute: await safeFilePath(app.dataDir, `tasks/${id}/${parts.join('/')}`), origin: 'work', name: parts.at(-1)!, intent_id: String(intent) };
  }
  async function entry(id: number, ref: string) {
    const file = await resolve(id, ref), stat = await lstat(file.absolute);
    if (!stat.isFile() && !stat.isDirectory()) return fail('不支持此文件类型', 403);
    return { ref, name: file.name, kind: stat.isDirectory() ? 'directory' : 'file', size: stat.size, modified_at: stat.mtime.toISOString(), version: `${stat.ino}:${stat.size}:${stat.mtimeMs}`, origin: file.origin, intent_id: file.intent_id };
  }
  app.get('/api/tasks/:id/files', async req => {
    const id = Number((req.params as { id: string }).id), q = req.query as Record<string, string>;
    await task(id);
    const refs: string[] = [];
    if (q.ref) {
      const dir = await resolve(id, q.ref);
      if (!(await lstat(dir.absolute)).isDirectory()) return fail('不是目录');
      for (const name of await readdir(dir.absolute)) refs.push(`${q.ref}/${name}`);
    } else {
      const attachments = await app.db.query('SELECT id FROM chat_artifacts WHERE task_id=$1', [id]);
      refs.push(...attachments.rows.map(r => `attachment:${r.id}`));
      let directories: string[] = [];
      try { directories = await readdir(await safeFilePath(app.dataDir, `tasks/${id}`)); } catch (e) { if ((e as {statusCode?:number}).statusCode !== 404) throw e; }
      refs.push(...directories.filter(d => /^i[1-9]\d*$/.test(d)).map(d => `work:${d}`));
    }
    refs.sort();
    const items = [];
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 100));
    for (const ref of refs) {
      if (q.cursor && ref <= q.cursor) continue;
      try { items.push(await entry(id, ref)); } catch (e) { if (![403, 404].includes((e as {statusCode:number}).statusCode) && (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (items.length > limit) break;
    }
    return { items: items.slice(0, limit), next_cursor: items.length > limit ? items[limit - 1]!.ref : null };
  });
  app.get('/api/tasks/:id/files/content', async (req, reply) => {
    const id = Number((req.params as { id: string }).id), q = req.query as Record<string, string>;
    const file = await resolve(id, q.ref ?? ''), handle = await open(file.absolute, constants.O_RDONLY | constants.O_NOFOLLOW).catch(safeFileError);
    let streamed=false;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return fail('不是普通文件');
      const latest = await lstat((await resolve(id, q.ref!)).absolute);
      if (latest.ino !== stat.ino || latest.dev !== stat.dev) return fail('文件已变化，请刷新', 409);
      const version = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      if (q.version && q.version !== version) return fail('文件已变化，请从头读取', 409);
      if (q.download === '1') {
        reply.type('application/octet-stream').header('X-Content-Type-Options', 'nosniff').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
        streamed=true; return reply.send(handle.createReadStream({ autoClose: true }));
      }
      const offset = Number(q.offset ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size) return fail('无效读取位置');
      const buffer = Buffer.alloc(Math.min(65536, stat.size - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      let end = bytesRead;
      // Keep complete UTF-8 characters between pages. Binary files are download-only.
      const binary = buffer.subarray(0, bytesRead).includes(0);
      if (!binary && offset + end < stat.size) {
        let start = end - 1;
        while (start >= 0 && (buffer[start]! & 0xc0) === 0x80) start--;
        if (start >= 0) { const byte = buffer[start]!; const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1; if (start + width > end) end = start; }
      }
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return fail('文件正在变化，请刷新', 409);
      return { ref: q.ref, version, offset, next_offset: offset + end, total: stat.size, has_more: offset + end < stat.size, binary, content: binary ? '' : buffer.subarray(0, end).toString('utf8') };
    } catch (error) { return safeFileError(error); } finally { if (!streamed) await handle.close(); }
  });
}
