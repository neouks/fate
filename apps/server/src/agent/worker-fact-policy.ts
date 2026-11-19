import {createHash} from 'node:crypto';
import type {Database} from '../db/index.js';

export const WORKER_FACT_GUIDANCE = '默认一个意图将相关观察总结成一条 fact，在完成、受阻或预算收尾时用 record_fact 一次写回。summary 用一句话概括本意图的综合结论，detail 汇总相关观察、验证方法、细节和限制，evidence 保留支撑结论的真实关键原文。只有结论彼此独立、无法归并时才拆分，并在同一次调用中用 facts 数组提交。不要按请求、接口、参数或中间步骤逐条写 fact。只保存新增结论，已保存内容不重复提交；部分成功只重试失败项。无新增事实可以直接总结。收尾时汇总已有观察即可，不为补全结论启动新操作。历史提示中的逐结果立即写 fact 要求以本规则为准。';

export const WORKER_COMPLETION_GUIDANCE = '已有证据满足当前意图和用户明确的验收要求时，汇总写回并结束。再次访问目标前，先明确尚未解决且影响当前结论的证据缺口；剩余预算、可选字段为空、补截图或让报告更完整，本身不是重复验证的理由。用户明确要求复核、原证据失败或相互矛盾时，才针对该缺口继续验证。未要求的可选信息保留为空或注明未测，不扩展验收条件。';

// Exact shipped fragments only: preserve custom requirements and original evidence.
// Read-time cleanup also applies if an operator selects an old prompt after migration.
const RETIRED_FACT_INSTRUCTIONS = [
  ['**边发现边写回**（写进图才算数，脑子/文字里的不算；每得一个结果立刻写，别攒到最后被步数耗尽丢掉）。三种写回，别串图：', '**按结论汇总写回**。三种写回，别串图：'],
  ['同一结论的相关观察合并保存；独立结论分别写回，不规定一意图通常只能写一条事实。', '同一意图的相关观察汇总保存；彼此独立且无法归并的结论可批量写回。'],
  ['边发现边写回，不必等到结束：', '按意图汇总相关观察后写回：'],
] as const;
export function normalizeWorkerInstructions(text: string): string {
  for (const [before, after] of RETIRED_FACT_INSTRUCTIONS) text = text.replaceAll(before, after);
  return text;
}

export async function migrateWorkerInstructionCleanup(db: Database) {
  await db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(4200000018)');
    const key = 'worker_instruction_cleanup_v2';
    if (await tx.platform().getSetting(key) === 'done') return;
    const row = (await tx.query(`SELECT a.id,a.wrapup_prompt,a.task_timeout_wrapup_prompt,p.template_text FROM agents a
      LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key='worker' FOR UPDATE OF a`)).rows[0];
    if (row) {
      const before = String(row.template_text ?? ''), after = normalizeWorkerInstructions(before);
      if (after !== before) {
        const saved = (await tx.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by)
          SELECT $1,COALESCE(max(version),0)+1,$2,'清理旧逐结果写回指令；保留自定义内容和历史版本','migration'
          FROM agent_prompts WHERE agent_id=$1 RETURNING id`, [row.id, after])).rows[0]!;
        await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1', [row.id, saved.id]);
      }
      for (const field of ['wrapup_prompt', 'task_timeout_wrapup_prompt'] as const) {
        const text = String(row[field] ?? ''), cleaned = normalizeWorkerInstructions(text);
        if (text !== cleaned) await tx.query(`UPDATE agents SET ${field}=$2 WHERE id=$1`, [row.id, cleaned]);
      }
    }
    await tx.platform().setSetting(key, 'done');
  });
}

const MIGRATION_KEY = 'worker_fact_summary_v1';
const PREVIOUS_PROMPT_HASH = '5181806b41bcf83e001f2b51efe61555d44c607b6cd921311dca22c8eccfa633';

/** Upgrade the shipped default once, preserving custom templates and prompt history. */
export async function migrateWorkerFactPrompt(db: Database, template: string) {
  await db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(4200000018)');
    if (await tx.platform().getSetting(MIGRATION_KEY) === 'done') return;
    const row = (await tx.query(`SELECT a.id,p.template_text FROM agents a
      LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key='worker' FOR UPDATE OF a`)).rows[0];
    if (row && createHash('sha256').update(String(row.template_text)).digest('hex') === PREVIOUS_PROMPT_HASH) {
      const saved = (await tx.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by)
        SELECT $1,COALESCE(max(version),0)+1,$2,'Worker 按意图汇总相关观察后一次写回事实；保留历史版本','migration'
        FROM agent_prompts WHERE agent_id=$1 RETURNING id`, [row.id, template])).rows[0]!;
      await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1', [row.id, saved.id]);
    }
    await tx.platform().setSetting(MIGRATION_KEY, 'done');
  });
}
