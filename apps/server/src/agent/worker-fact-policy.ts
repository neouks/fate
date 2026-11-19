import {createHash} from 'node:crypto';
import type {Database} from '../db/index.js';

export const WORKER_FACT_GUIDANCE = '默认一个意图将相关观察总结成一条 fact，在完成、受阻或预算收尾时用 record_fact 一次写回。summary 用一句话概括本意图的综合结论，detail 汇总相关观察、验证方法、细节和限制，evidence 保留支撑结论的真实关键原文。只有结论彼此独立、无法归并时才拆分，并在同一次调用中用 facts 数组提交。不要按请求、接口、参数或中间步骤逐条写 fact。只保存新增结论，已保存内容不重复提交；部分成功只重试失败项。无新增事实可以直接总结。收尾时汇总已有观察即可，不为补全结论启动新操作。历史提示中的逐结果立即写 fact 要求以本规则为准。';

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
