import type { Database } from '../db/index.js';
import { searchCredentials } from './deepseek.js';

export const PROVIDERS = {
  deepseek: { label: 'DeepSeek', key: 'deepseekApiKey' },
  exa: { label: 'Exa', key: 'exaApiKey' },
  brave: { label: 'Brave', key: 'braveApiKey' },
  tavily: { label: 'Tavily', key: 'tavilyApiKey' },
  bocha: { label: '博查', key: 'bochaApiKey' },
  jina: { label: 'Jina', key: 'jinaApiKey' },
  searxng: { label: 'SearXNG', key: '' },
  duckduckgo: { label: 'DuckDuckGo', key: '' },
} as const;
export type Source = keyof typeof PROVIDERS;
export const SOURCES = Object.keys(PROVIDERS) as Source[];
export type Selection = Source | 'auto';
export type Preferences = { sources: Source[]; default_source: Selection };
export type WebAccessConfig = Preferences & { keys: Partial<Record<Source, string>>; searxng_url: string; proxy: string; proxy_configured?: boolean; domain_filter?: string[] };
export const WEB_ACCESS_SETTING = 'pi_web_access_config_v1';
export const WEB_TOOLS = ['web_search', 'fetch_content', 'get_search_content'] as const;
export const isSource = (value: unknown): value is Source => typeof value === 'string' && Object.hasOwn(PROVIDERS, value);
export function preferences(sources: unknown, selected: unknown): Preferences {
  if (!Array.isArray(sources) || !sources.length || !sources.every(isSource)) throw new Error('请选择至少一个支持的搜索供应商');
  if (selected !== 'auto' && (!isSource(selected) || !sources.includes(selected))) throw new Error('默认供应商必须已启用');
  return { sources: [...new Set(sources)], default_source: selected };
}
export async function readWebAccessConfig(db: Database): Promise<WebAccessConfig> {
  const saved = await db.platform().getSetting(WEB_ACCESS_SETTING);
  if (saved) return JSON.parse(saved) as WebAccessConfig;
  return { sources: ['deepseek', 'exa'], default_source: 'deepseek', keys: {}, searxng_url: '', proxy: '' };
}
export async function readPreferences(db: Database): Promise<Preferences> {
  const { sources, default_source } = await readWebAccessConfig(db); return { sources, default_source };
}
function credential(value: unknown) {
  if (typeof value !== 'string' || value.length > 4096 || /\s/.test(value.trim()) || /^[!$]/.test(value.trim())) throw new Error('API Key 必须是有效的密钥文本');
  return value.trim();
}
export function updateWebAccessConfig(current: WebAccessConfig, body: Record<string, unknown>): WebAccessConfig {
  const next = { ...current, ...preferences(body.sources ?? current.sources, body.default_source ?? current.default_source), keys: { ...current.keys } };
  if (body.domain_filter !== undefined) {
    if (!Array.isArray(body.domain_filter) || body.domain_filter.length > 20) throw new Error('搜索站点最多 20 个');
    next.domain_filter = [...new Set(body.domain_filter.map(value => {
      if (typeof value !== 'string') throw new Error('搜索站点必须是域名');
      const text = value.trim().toLowerCase(), excluded = text.startsWith('-');
      const domain = excluded ? text.slice(1) : text;
      if (!domain || /[\s/:?#@*\\]/u.test(domain)) throw new Error('搜索站点只填写域名');
      const hostname = new URL('https://' + domain).hostname;
      if (hostname.length > 253 || !hostname.includes('.') || !hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('搜索站点域名无效');
      return (excluded ? '-' : '') + hostname;
    }))];
  }
  if (body.api_keys !== undefined) {
    if (!body.api_keys || typeof body.api_keys !== 'object' || Array.isArray(body.api_keys)) throw new Error('api_keys 格式错误');
    for (const [key, value] of Object.entries(body.api_keys)) {
      if (!isSource(key) || !PROVIDERS[key].key) throw new Error('不支持的密钥来源');
      const text = credential(value); if (text) next.keys[key] = text;
    }
  }
  if (body.clear_keys !== undefined) {
    if (!Array.isArray(body.clear_keys) || !body.clear_keys.every(isSource)) throw new Error('clear_keys 格式错误');
    for (const source of body.clear_keys as Source[]) next.keys[source] = '';
  }
  if (body.searxng_url !== undefined) {
    if (typeof body.searxng_url !== 'string' || body.searxng_url.length > 2048) throw new Error('SearXNG 地址无效');
    const value = body.searxng_url.trim();
    if (value) { const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('SearXNG 需要不含凭证的 HTTP(S) 地址'); }
    next.searxng_url = value;
  }
  if (body.proxy !== undefined && body.proxy !== '') {
    if (typeof body.proxy !== 'string' || body.proxy.length > 2048) throw new Error('代理地址无效');
    const proxy = new URL(body.proxy);
    if (!['http:', 'https:', 'socks5:', 'socks5h:', 'socks4:', 'socks4a:'].includes(proxy.protocol)) throw new Error('不支持的代理协议');
    next.proxy = body.proxy;
    next.proxy_configured = true;
  }
  if (body.clear_proxy !== undefined && typeof body.clear_proxy !== 'boolean') throw new Error('clear_proxy 格式错误');
  if (body.clear_proxy === true) { next.proxy = ''; next.proxy_configured = true; }
  return next;
}
export async function resolvedConfig(db: Database, input?: WebAccessConfig) {
  const config = input ?? await readWebAccessConfig(db);
  const legacy = config.keys.deepseek === undefined ? await searchCredentials(db) : null;
  const keys = { ...config.keys, ...(legacy ? { deepseek: legacy.key } : {}) };
  return { ...config, keys, proxy: config.proxy_configured ? config.proxy : config.proxy || legacy?.proxy || '' };
}
export function extensionConfig(config: WebAccessConfig): Record<string, unknown> {
  return {
    ...(config.default_source === 'auto' ? { searchRouting: { providers: config.sources, fallbackOn: ['unsupported', 'transient', 'quota', 'network', 'invalid-response', 'empty'] } } : { provider: config.default_source }),
    ...Object.fromEntries(SOURCES.filter(source => PROVIDERS[source].key && config.keys[source]).map(source => [PROVIDERS[source].key, config.keys[source]])),
    ...(config.searxng_url ? { searxngBaseUrl: config.searxng_url } : {}),
    ...(config.proxy ? { proxy: config.proxy, lockProxy: true } : {}), webSearch: { allowedProviders: config.sources },
    workflow: 'none', toolActivation: 'none', toolExposure: 'deferred', maxInlineContentChars: 12000,
    tools: { sourceCheck: { enabled: false } },
    fetch: { defaultMode: 'readable', allowedModes: ['readable', 'raw'] },
    githubClone: { enabled: false }, githubPrIssue: { enabled: false },
    allowBrowserCookies: false,
    fetchRouting: { allowRemoteHostedProviders: false },
    commands: Object.fromEntries(['websearch', 'curator', 'search', 'google-account'].map(name => [name, { enabled: false }])),
  };
}
export async function webSearchAllowed(db: Database, role: string) {
  if (!await db.platform().getBool('web_search_enabled', false)) return false;
  const agent = await db.platform().getAgentByKey(role); return agent?.webSearch === true && agent.enabled !== false;
}
export async function webSearchSettings(db: Database) {
  const config = await readWebAccessConfig(db), effective = await resolvedConfig(db, config);
  const readySources = config.sources.filter(source => ['exa', 'duckduckgo'].includes(source) || (source === 'searxng' ? !!config.searxng_url : !!effective.keys[source]));
  const ready = config.default_source === 'auto' ? !!readySources.length : readySources.includes(config.default_source);
  const enabled = await db.platform().getBool('web_search_enabled', false);
  const agents = (await db.platform().listAgents()).filter(agent => agent.webSearch);
  const binding = (await db.query('SELECT enabled,agents FROM tools WHERE key=$1', ['web_search'])).rows[0];
  return { implementation: 'pi-web-access', version: '0.48.0', web_search_enabled: enabled,
    sources: config.sources, default_source: config.default_source, web_search_backend: config.default_source,
    providers: SOURCES.map(id => ({ id, label: PROVIDERS[id].label, needs_key: !!PROVIDERS[id].key && id !== 'exa', supports_key: !!PROVIDERS[id].key })),
    keys_set: Object.fromEntries(SOURCES.map(source => [source, !!effective.keys[source]])),
    searxng_url: config.searxng_url, domain_filter: config.domain_filter ?? [], proxy_set: !!effective.proxy, ready,
    agent_roles: agents.map(agent => agent.key), effective_agent_roles: enabled && ready ? agents.filter(agent => agent.enabled !== false && binding?.enabled !== false && (!binding || Array.isArray(binding.agents) && binding.agents.includes(agent.key))).map(agent => agent.key) : [],
    migration_notice: await db.platform().getSetting('pi_web_access_migration_notice'),
  };
}
