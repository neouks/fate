import type { Database } from '../db/index.js';
import { profileFetch } from '../pi/providerFromProfile.js';
import { readPreferences } from './sources.js';
import { WEB_SEARCH_ROLES } from './policy.js';

export interface SearchResult { title: string; url: string; summary: string; snippet: string; date: string | null }
export interface SearchInput { query: string; count?: number }

function officialBase(base: string): boolean {
  try { const url = new URL(base); return url.origin === 'https://api.deepseek.com' && !url.username && !url.password; }
  catch { return false; }
}

export async function searchCredentials(db: Database, enteredKey = '') {
  const key = enteredKey.trim() || await db.platform().getSetting('deepseek_search_api_key');
  if (key) return { key, proxy: '', source: '专用 DeepSeek API Key' };
  const active = await db.platform().activeProfile();
  if (active?.apiKey && officialBase(active.baseURL)) {
    return { key: active.apiKey, proxy: active.proxy, source: `当前官方模型配置 · ${active.name}` };
  }
  for (const candidate of await db.platform().listProfiles()) {
    if (!officialBase(candidate.baseURL)) continue;
    const profile = await db.platform().profileByID(candidate.id);
    if (profile?.apiKey && officialBase(profile.baseURL)) {
      return { key: profile.apiKey, proxy: profile.proxy, source: `官方模型配置 · ${profile.name}` };
    }
  }
  return null;
}

export async function webSearchSettings(db: Database) {
  const prefs = await readPreferences(db);
  const credentials = await searchCredentials(db);
  const ready = prefs.default_source === 'auto' ? prefs.sources.some(s => s !== 'deepseek' || !!credentials) : prefs.default_source !== 'deepseek' || !!credentials;
  const agents = await Promise.all(WEB_SEARCH_ROLES.map(async role => ({role, agent: await db.platform().getAgentByKey(role)})));
  const binding = (await db.query('SELECT enabled,agents FROM tools WHERE key=$1', ['web_search'])).rows[0];
  const selected = agents.filter(({agent}) => agent?.webSearch === true);
  const enabled = await db.platform().getBool('web_search_enabled', false);
  return {
    web_search_enabled: enabled,
    web_search_backend: prefs.default_source, ...prefs,
    deepseek_key_set: !!await db.platform().getSetting('deepseek_search_api_key'),
    ready, credential_source: credentials?.source ?? '',
    agent_roles: selected.map(({role}) => role),
    effective_agent_roles: enabled ? selected.filter(({role, agent}) => ready && agent?.enabled !== false && binding?.enabled !== false && (!binding || Array.isArray(binding.agents) && binding.agents.includes(role))).map(({role}) => role) : [],
  };
}

export function validateSearch(input: SearchInput): Required<SearchInput> {
  if (typeof input.query !== 'string' || !input.query.trim() || [...input.query.trim()].length > 128) {
    throw new Error('搜索词须为 1–128 个字符');
  }
  const count = input.count ?? 5;
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error('结果数量须为 1–50 的整数');
  return { query: input.query.trim(), count };
}

export async function deepseekSearch(db: Database, input: SearchInput, options: { apiKey?: string; signal?: AbortSignal } = {}) {
  const request = validateSearch(input);
  const credentials = await searchCredentials(db, options.apiKey);
  if (!credentials) throw new Error('请填写 DeepSeek API Key，或添加使用 api.deepseek.com 的官方模型配置');
  const timeout = AbortSignal.timeout(30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const started = performance.now();
  try {
    options.signal?.throwIfAborted();
    const response = await profileFetch(credentials.proxy)('https://api.deepseek.com/v1/tools/search', {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${credentials.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, need_content: false }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const reasons: Record<number, string> = { 401: 'API Key 无效', 402: '余额不足', 403: '密钥无搜索权限', 429: '请求过于频繁，请稍后重试' };
      throw new Error(`DeepSeek 搜索失败（HTTP ${response.status}）${reasons[response.status] ?? '，请稍后重试'}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('DeepSeek 搜索返回空响应');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 2 * 1024 * 1024) throw new Error('DeepSeek 搜索响应超过大小限制');
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { results?: unknown };
    if (!Array.isArray(data.results)) throw new Error('DeepSeek 搜索响应缺少结果列表');
    const results: SearchResult[] = data.results.slice(0, request.count).map((item: unknown) => {
      if (!item || typeof item !== 'object') throw new Error('DeepSeek 搜索结果格式无效');
      const row = item as Record<string, unknown>;
      if (typeof row.url !== 'string' || typeof row.title !== 'string' || !/^https?:\/\//i.test(row.url)) throw new Error('DeepSeek 搜索结果格式无效');
      return { title: row.title.slice(0, 1000), url: row.url.slice(0, 8192),
        summary: typeof row.summary === 'string' ? row.summary.slice(0, 6000) : '',
        snippet: typeof row.snippet === 'string' ? row.snippet.slice(0, 2000) : '',
        date: typeof row.date === 'string' ? row.date : null };
    });
    return { backend: 'deepseek' as const, query: request.query, results, count: results.length, latency_ms: Math.round(performance.now() - started) };
  } catch (error) {
    if (options.signal?.aborted) throw new Error('搜索已取消');
    if (timeout.aborted) throw new Error('DeepSeek 搜索超时，请稍后重试');
    const message = error instanceof Error ? error.message : '';
    // Provider errors and proxy failures must never disclose the key or proxy credentials.
    if (message.startsWith('DeepSeek 搜索') && !message.includes(credentials.key)) throw error;
    throw new Error('DeepSeek 搜索请求失败，请检查网络和模型代理配置');
  }
}
