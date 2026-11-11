import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createEditToolDefinition, createWriteToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Database } from '../db/index.js';
import { FILE_CHANGE_BYTES, recordTurnFileChange, type FileChangeScope, type FileVersion } from '../db/turn-file-changes.js';

const missing: FileVersion = { hash: null, text: '', status: 'text' };
const uncertain: FileVersion = { hash: null, text: null, status: 'uncertain' };
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const isPrivatePart = (part: string) => /^(?:\.git|\.series(?:[.-].*)?|\.env(?:\..*)?|jwt\.key|session(?:[.-].*)?\.jsonl(?:\..*)?)$/i.test(part);
const nativeWrite = (file: string, content: string) => writeFile(file, content, 'utf8');

/** Use the same resolved path and per-file queue as pi's physical write. */
export function nativeWorkspaceFileTools(cwd: string, write = nativeWrite) {
  return [
    createWriteToolDefinition(cwd, { operations: { writeFile: write, mkdir: async dir => { await mkdir(dir, { recursive: true }); } } }),
    createEditToolDefinition(cwd, { operations: { writeFile: write, readFile, access: file => access(file, constants.R_OK | constants.W_OK) } }),
  ];
}

async function snapshot(dataRoot: string, relative: string): Promise<FileVersion | undefined> {
  let file = dataRoot;
  const parts = relative.split(path.sep);
  try {
    for (const [index, part] of parts.entries()) {
      file = path.join(file, part);
      const info = await lstat(file);
      if (info.isSymbolicLink()) return undefined;
      if (index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) return undefined;
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      const linked = await lstat(file);
      if (!stat.isFile() || stat.nlink !== 1 || linked.dev !== stat.dev || linked.ino !== stat.ino ||
          linked.isSymbolicLink() || await realpath(file) !== file) return undefined;
      const hash = createHash('sha256');
      const chunks: Buffer[] = [];
      let size = 0;
      if (stat.size > 0) {
        for await (const chunk of handle.createReadStream({ autoClose: false, end: stat.size - 1 })) {
          size += chunk.length;
          hash.update(chunk);
          if (stat.size <= FILE_CHANGE_BYTES) chunks.push(chunk);
        }
      }
      const current = await handle.stat();
      const currentLink = await lstat(file);
      if (currentLink.isSymbolicLink() || currentLink.dev !== stat.dev || currentLink.ino !== stat.ino ||
          await realpath(file) !== file) return undefined;
      if (current.size !== stat.size || size !== stat.size || current.mtimeMs !== stat.mtimeMs ||
          current.ctimeMs !== stat.ctimeMs || current.nlink !== 1) return uncertain;
      const digest = hash.digest('hex');
      if (size > FILE_CHANGE_BYTES) return { hash: digest, text: null, status: 'too_large' };
      const bytes = Buffer.concat(chunks, size);
      try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        if (!text.includes('\0')) return { hash: digest, text, status: 'text' };
      } catch { /* Invalid UTF-8 is binary for this viewer. */ }
      return { hash: digest, text: null, status: 'binary' };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isMissing(error)) return missing;
    if (['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    return uncertain;
  }
}

export function trackWorkspaceFileWrites(db: Database, options: {
  scope: FileChangeScope;
  taskID: number;
  intentID?: number;
  cwd: string;
  dataDir: string;
}) {
  const { scope, taskID, intentID, dataDir } = options;
  const workspace = scope.kind === 'conversation'
    ? path.resolve(dataDir, 'conversations', String(scope.id))
    : path.resolve(dataDir, 'tasks', String(taskID), ...(intentID ? [`i${intentID}`] : []));
  if (path.resolve(options.cwd) !== workspace) return undefined;

  return async (file: string, content: string) => {
    const relative = path.relative(workspace, file);
    const parts = relative.split(path.sep);
    if (!relative || path.isAbsolute(relative) || parts[0] === '..' || Buffer.byteLength(relative) > 1024 ||
        parts.some(part => /[\x00-\x1f\x7f\\]/.test(part) || isPrivatePart(part) ||
          process.platform === 'win32' && /:|[. ]$/.test(part))) return nativeWrite(file, content);
    const nested = scope.kind === 'task' && !intentID && /^i([1-9]\d*)$/.exec(parts[0] ?? '');
    const owner = intentID ?? (nested ? Number(nested[1]) : null);
    if (owner !== null && !Number.isSafeInteger(owner)) return nativeWrite(file, content);

    let wrote = false;
    let writeError: unknown;
    const write = async () => {
      try { await nativeWrite(file, content); wrote = true; }
      catch (error) { writeError = error; throw error; }
    };
    try {
      const dataRoot = await realpath(dataDir);
      const storedPath = path.relative(path.resolve(dataDir), path.resolve(file));
      await db.transaction(async tx => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`turn-file:${path.join(dataRoot, storedPath)}`]);
        if (nested && !(await tx.query(`SELECT 1 FROM tasks t JOIN exploration_nodes n ON n.exploration_id=t.exploration_id
          WHERE t.id=$1 AND n.id=$2 AND n.kind='intent' AND exploration_node_readable(t.exploration_id,n.id)`, [taskID, owner])).rowCount) {
          return write();
        }
        const before = await snapshot(dataRoot, storedPath);
        await write();
        if (!before) return;
        const after = await snapshot(dataRoot, storedPath);
        if (!after) return;
        const expectedHash = createHash('sha256').update(content, 'utf8').digest('hex');
        await recordTurnFileChange(tx, scope, parts.join('/'), owner, before, after.hash === expectedHash ? after : uncertain);
      });
    } catch (error) {
      if (writeError) throw writeError;
      // Recording is observability. Never retry a completed native write.
      console.warn('[turn-file-changes] unable to save a workspace write receipt',
        (error as NodeJS.ErrnoException).code ?? 'unknown');
      if (!wrote) return nativeWrite(file, content);
    }
  };
}
