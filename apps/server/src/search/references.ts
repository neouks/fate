import type { Database } from '../db/index.js';
import { deepseekSearch, validateSearch, type SearchInput, type SearchResult } from './deepseek.js';
import { articleSource, canonicalLink, publicWebSearch, type Engine } from './public-web.js';
import { COMMUNITY, isSource, type Preferences, type Selection, type Source } from './sources.js';

export type ReferenceInput = SearchInput & { source?: Selection };
type Reference = SearchResult & { engine: Source; source: string };
type Options = { signal?: AbortSignal; apiKey?: string };

export async function referenceSearch(db: Database, input: ReferenceInput, prefs: Preferences, options: Options = {}) {
  const { query, count } = validateSearch(input);
  const selected = input.source ?? prefs.default_source;
  if (selected !== 'auto' && (!isSource(selected) || !prefs.sources.includes(selected)))
    throw new Error('搜索来源未启用');
  const start = performance.now();
  const deadline = AbortSignal.timeout(30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const results = new Map<string, Reference>();
  const failures: {source: Source; reason: string}[] = [];
  const order: Source[] = ['bing', 'baidu', 'deepseek', 'github', 'cnblogs', 'csdn', 'wechat'];
  const candidates = selected === 'auto' ? order.filter(s => prefs.sources.includes(s)).slice(0,2) : [selected];
  let success = false;
  for (const source of candidates) {
    const site = Object.hasOwn(COMMUNITY, source) ? COMMUNITY[source as keyof typeof COMMUNITY] : undefined;
    const engine = site ? (prefs.sources.includes('baidu') ? 'baidu' : 'bing') : source;
    try {
      signal.throwIfAborted();
      // Reserve time for the second provider in automatic mode.
      const attempt = candidates.length > 1 ? AbortSignal.any([signal, AbortSignal.timeout(14_000)]) : signal;
      const rows = engine === 'deepseek'
        ? (await deepseekSearch(db, {query, count}, {...options, signal: attempt})).results
        : await publicWebSearch(engine as Engine, site ? 'site:' + site + ' ' + query : query, count, attempt);
      for (const row of rows) {
        const url = canonicalLink(row.url);
        if (!url || !row.title) continue;
        const actual = articleSource(url);
        if (site && actual !== source) continue;
        if (!results.has(url)) results.set(url, {...row, url, source: actual ?? new URL(url).hostname, engine});
        if (results.size >= count) break;
      }
      success = true;
      if (results.size >= count) break;
    } catch (error) {
      if (options.signal?.aborted) throw new Error('搜索已取消');
      const reason = deadline.aborted || (error instanceof Error && ['TimeoutError','AbortError'].includes(error.name))
        ? '搜索超时' : error instanceof SyntaxError ? '搜索响应格式无效' : error instanceof Error ? error.message : '搜索失败';
      failures.push({source, reason});
    }
  }
  if (!success) throw new Error(failures.map(f => f.source + '：' + f.reason).join('；'));
  return { backend: selected, query, results: [...results.values()], count: results.size,
    status: failures.length ? 'partial' : results.size ? 'ok' : 'empty', failures, latency_ms: Math.round(performance.now() - start) };
}
