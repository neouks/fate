import {clampOutput} from '../tools/define.js';

export const CONTEXT_LAYOUT_VERSION = 'stable-prefix-v1';

/** Stable information first; current events last. Never drop a fact/version to gain cache hits. */
export function plannerRoundMessage(overview:Record<string,unknown>,todos:unknown,changes:unknown[],events:unknown[],triggers:string):string {
  const {worker_capabilities,goals,...situation}=overview;
  delete situation.todos;
  // Chronological order preserves the leading entries while a bounded window grows.
  // Frontier order is intentionally unchanged: it carries dispatch priority.
  for(const key of ['recent_facts','recent_done_intents','cold_digests']) {
    if(Array.isArray(situation[key]))situation[key]=[...situation[key]].sort((a,b)=>Number(a.id)-Number(b.id));
  }
  const json=(value:unknown)=>clampOutput(JSON.stringify(value??[]));
  return `【读取约定】\n态势是有界摘要，不是全量图谱。派单前 context_search 查询已有意图与结果；用 ref/version 和 context_get 按需续读，未展示不表示不存在。\n`+
    (worker_capabilities?`【Worker 能力】\n${json(worker_capabilities)}\n`:'')+
    `【任务目标索引】\n${json(goals)}\n`+
    `【跨轮共享待办（串行利用链，用 todo_write 更新）】\n${json(todos)}\n`+
    `【当前态势摘要，完整图按 context_search/context_get 查询】\n${json(situation)}\n`+
    `【本轮已交付通知】\n${json(events)}\n【本轮领域变化】\n${json(changes)}\n`+
    `${triggers.slice(0,6000)}\n开始本轮规划。`;
}

/** Drop only identical repeated values. Different versions/observations remain visible. */
export function compactPlannerChanges(changes: unknown[], overview: Record<string, unknown>, taskID: number): unknown[] {
  const entries = Object.entries(overview).flatMap(([section, items]) => Array.isArray(items)
    ? items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object').map(item => ({section,item})) : []);
  return changes.map(change => {
    if (!change || typeof change !== 'object') return change;
    const value = change as Record<string, unknown>;
    if (value.source_task_id !== taskID) return change;
    const found = entries.find(({item}) => `node:${item.id}` === value.ref);
    if (!found) return change;
    const copy = {...value};
    for (const key of ['summary','progress','result']) {
      if (key in copy && JSON.stringify(copy[key]) === JSON.stringify(found.item[key])) {
        delete copy[key]; copy.details_in = `${found.section}:${value.ref}`;
      }
    }
    return copy;
  });
}
