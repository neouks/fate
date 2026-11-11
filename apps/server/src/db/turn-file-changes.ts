import { formatPatch, structuredPatch } from 'diff';
import type { Database } from './index.js';

export const FILE_CHANGE_BYTES = 256 * 1024;
export const FILE_CHANGE_PREVIEW_LIMIT = 10;
export type FileChangeScope = { kind: 'task' | 'conversation'; id: number; turnID: string };
export type FileVersion = {
  hash: string | null;
  text: string | null;
  status: 'text' | 'binary' | 'too_large' | 'uncertain';
};
type ChangeStatus = FileVersion['status'] | 'unchanged';
type ChangeRow = {
  id: string;
  turn_id: string;
  path: string;
  kind: 'added' | 'modified';
  status: FileVersion['status'];
  additions: number | null;
  deletions: number | null;
};

export function isFinishedFileChangeTurn(turn: { finished_at: string | null; status: string }) {
  return !!turn.finished_at && ['completed', 'done', 'failed', 'blocked', 'paused', 'stopped', 'exhausted', 'interrupted'].includes(turn.status);
}

function compareFileVersions(path: string, before: FileVersion, after: FileVersion, continuous: boolean) {
  const unavailable = (status: ChangeStatus) => ({ status, additions: null, deletions: null, patch: null });
  if (!continuous || before.status === 'uncertain' || after.status === 'uncertain') return unavailable('uncertain');
  if (before.hash === after.hash) return unavailable('unchanged');
  if (before.status === 'too_large' || after.status === 'too_large') return unavailable('too_large');
  if (before.status === 'binary' || after.status === 'binary') return unavailable('binary');

  const diff = structuredPatch(before.hash === null ? '/dev/null' : `a/${path}`, `b/${path}`,
    before.text ?? '', after.text ?? '', undefined, undefined, { context: 3, timeout: 50, maxEditLength: 8000 });
  if (!diff) return unavailable('too_large');
  const patch = formatPatch(diff);
  if (Buffer.byteLength(patch) > FILE_CHANGE_BYTES) return unavailable('too_large');
  let additions = 0, deletions = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions++;
      else if (line.startsWith('-')) deletions++;
    }
  }
  return { status: 'text' as const, additions, deletions, patch };
}

const scopeColumn = (kind: FileChangeScope['kind']) => kind === 'task' ? 'task_id' : 'conversation_id';

/** The caller holds the workspace path lock across the actual native write. */
export async function recordTurnFileChange(
  tx: Database, scope: FileChangeScope, path: string, intentID: number | null,
  before: FileVersion, after: FileVersion,
) {
  if (before.status !== 'uncertain' && after.status !== 'uncertain' && before.hash === after.hash) return;
  const column = scopeColumn(scope.kind);
  const prior = (await tx.query<{
    base_hash: string | null; base_text: string | null; base_status: FileVersion['status'];
    last_hash: string | null; status: ChangeStatus;
  }>(`SELECT base_hash,base_text,base_status,last_hash,status
    FROM turn_file_changes WHERE ${column}=$1 AND turn_id=$2 AND path=$3`, [scope.id, scope.turnID, path])).rows[0];
  const base = prior ? { hash: prior.base_hash, text: prior.base_text, status: prior.base_status } : before;
  const continuous = !prior || (prior.status !== 'uncertain' && prior.last_hash === before.hash);
  const { status, additions, deletions, patch } = compareFileVersions(path, base, after, continuous);
  await tx.query(`INSERT INTO turn_file_changes(${column},turn_id,path,intent_id,
      base_hash,base_text,base_status,last_hash,status,additions,deletions,patch)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (${column},turn_id,path) WHERE ${column} IS NOT NULL
    DO UPDATE SET last_hash=excluded.last_hash,status=excluded.status,additions=excluded.additions,
      deletions=excluded.deletions,patch=excluded.patch`,
  [scope.id, scope.turnID, path, intentID, base.hash, base.text, base.status, after.hash, status, additions, deletions, patch]);
  await tx.query("SELECT bump_turn_read($1,$2,'file_changes',$3)", [scope.kind, scope.id, scope.turnID]);
}

function readableChanges(kind: FileChangeScope['kind']) {
  const owner = `f.${scopeColumn(kind)}=$1 AND f.status<>'unchanged'`;
  if (kind === 'conversation') return owner;
  return `${owner} AND (f.intent_id IS NULL OR EXISTS (
    SELECT 1 FROM tasks t WHERE t.id=f.task_id AND exploration_node_readable(t.exploration_id,f.intent_id)))`;
}

const previewColumns = `f.id::text,f.turn_id,f.path,
  CASE WHEN f.base_hash IS NULL AND f.base_status='text' THEN 'added' ELSE 'modified' END kind,
  f.status,f.additions,f.deletions`;
function card({ id, path, kind, status, additions, deletions }: ChangeRow) {
  return { id, path, kind, status, additions, deletions };
}

export async function readTurnFileChangePreviews(db: Database, kind: FileChangeScope['kind'], id: number, turns: string[]) {
  const result = new Map<string, { total: number; items: ReturnType<typeof card>[] }>();
  if (!turns.length) return result;
  const { rows } = await db.query<ChangeRow & { total: number }>(`SELECT * FROM (
    SELECT ${previewColumns},count(*) OVER (PARTITION BY f.turn_id)::int total,
      row_number() OVER (PARTITION BY f.turn_id ORDER BY f.id) rank
    FROM turn_file_changes f WHERE ${readableChanges(kind)} AND f.turn_id=ANY($2::text[])
  ) changes WHERE rank<=$3 ORDER BY turn_id,rank`, [id, turns, FILE_CHANGE_PREVIEW_LIMIT]);
  for (const row of rows) {
    const group = result.get(row.turn_id) ?? { total: row.total, items: [] };
    group.items.push(card(row));
    result.set(row.turn_id, group);
  }
  return result;
}

export async function readTurnFileChangePage(db: Database, scope: FileChangeScope, cursor: string) {
  const { rows } = await db.query<ChangeRow>(`SELECT ${previewColumns} FROM turn_file_changes f
    WHERE ${readableChanges(scope.kind)} AND f.turn_id=$2 AND f.id>$3::bigint ORDER BY f.id LIMIT 21`,
  [scope.id, scope.turnID, cursor]);
  const items = rows.slice(0, 20).map(card);
  return { items, next_cursor: rows.length > 20 ? items.at(-1)!.id : null };
}

export async function readTurnFileChange(db: Database, scope: FileChangeScope, changeID: string) {
  const row = (await db.query<ChangeRow & { patch: string | null }>(`SELECT ${previewColumns},f.patch FROM turn_file_changes f
    WHERE ${readableChanges(scope.kind)} AND f.turn_id=$2 AND f.id=$3::bigint`, [scope.id, scope.turnID, changeID])).rows[0];
  return row ? { ...card(row), patch: row.patch } : undefined;
}
