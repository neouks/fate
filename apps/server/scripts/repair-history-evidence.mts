// Usage: node --import tsx scripts/repair-history-evidence.mts PLAN.json [--apply BACKUP.json]
// PLAN: {task_id:number, items:[{node_id:number,version:number,activity_ids:number[]}]}
// Default: read-only validation. --apply backs up locked rows before atomic repair.
import {readFile, writeFile} from 'node:fs/promises';
import pg from 'pg';
import {postgresDSN} from '../src/config/index.js';
import {prepareEvidenceRepair, applyEvidenceRepair, type EvidenceRepairItem} from '../src/evidence/repair-history-placeholder.js';

const [planFile, mode, backupFile] = process.argv.slice(2);
if (!planFile || (mode !== undefined && (mode !== '--apply' || !backupFile))) throw new Error('需要 PLAN.json [--apply BACKUP.json]');
const plan = JSON.parse(await readFile(planFile, 'utf8')) as {task_id: number; items: EvidenceRepairItem[]};
if (!Array.isArray(plan.items) || !plan.items.length || new Set(plan.items.map(i => i.node_id)).size !== plan.items.length) throw new Error('修复条目为空或重复');
const db = new pg.Client({connectionString: postgresDSN().dsn});
await db.connect();
try {
  await db.query('BEGIN');
  const prepared = [];
  for (const item of plan.items) prepared.push(await prepareEvidenceRepair(db, plan.task_id, item));
  if (mode === '--apply') {
    // wx prevents overwriting the only rollback copy. Never print evidence bodies.
    await writeFile(backupFile!, JSON.stringify({plan, saved_at: new Date().toISOString(), nodes: prepared.map(p => p.node)}, null, 2), {flag: 'wx', mode: 0o600});
    for (const item of plan.items) await applyEvidenceRepair(db, plan.task_id, item);
    await db.query('COMMIT');
  } else await db.query('ROLLBACK');
  console.log(JSON.stringify({applied: mode === '--apply', task_id: plan.task_id, nodes: plan.items.map(i => i.node_id), source_counts: plan.items.map(i => i.activity_ids.length)}));
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally {await db.end();}
