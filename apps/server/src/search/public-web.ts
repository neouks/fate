import { EnvHttpProxyAgent, fetch as proxyFetch } from 'undici';
import { load } from 'cheerio';
import type { SearchResult } from './deepseek.js';
import { COMMUNITY, type Source } from './sources.js';

// Use the host's outbound HTTP proxy and NO_PROXY rules, including on Node versions
// which don't enable environment proxies for global fetch by default.
let environmentProxy: EnvHttpProxyAgent | undefined;
export const publicTransport = {
  async fetch(url: URL, options: RequestInit): Promise<Response> {
    if (!process.env.HTTPS_PROXY && !process.env.https_proxy && !process.env.HTTP_PROXY && !process.env.http_proxy)
      return fetch(url, options);
    environmentProxy ??= new EnvHttpProxyAgent();
    return await proxyFetch(url, {dispatcher: environmentProxy, signal: options.signal,
      redirect: 'manual', headers: Object.fromEntries(new Headers(options.headers).entries())}) as unknown as Response;
  },
};

export type Engine = 'bing' | 'github' | 'baidu';
const endpoints = {
  bing: 'https://www.bing.com/search',
  baidu: 'https://m.baidu.com/s',
  github: 'https://api.github.com/search/repositories',
};

function result(title: string, url: string, description = '', date: string | null = null): SearchResult {
  return { title: title.trim().slice(0,1000), url, summary: description.trim().slice(0,2000),
    snippet: description.trim().slice(0,500), date };
}

export function canonicalLink(raw: string): string | undefined {
  if (raw.length > 8192 || !URL.canParse(raw)) return;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
  url.hash = '';
  for (const key of Array.from(url.searchParams.keys())) {
    if (/^utm_/i.test(key)) url.searchParams.delete(key);
  }
  return url.href;
}

export function articleSource(link: string): Source | undefined {
  const {hostname, pathname} = new URL(link);
  if ((hostname === 'cnblogs.com' || hostname.endsWith('.cnblogs.com')) && /\/(?:p|articles)\/[^/]+/i.test(pathname)) return 'cnblogs';
  if (hostname === COMMUNITY.csdn && /\/article\/details\/\d+/.test(pathname)) return 'csdn';
  if (hostname === COMMUNITY.wechat) {
    const params = new URL(link).searchParams;
    if (/^\/s\/[^/]+$/.test(pathname) || (pathname === '/s' && params.has('__biz') && params.has('mid'))) return 'wechat';
  }
  if (hostname === 'github.com') return 'github';
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('搜索服务返回空响应');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error('搜索响应超过大小限制');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function publicWebSearch(engine: Engine, query: string, count: number, signal: AbortSignal): Promise<SearchResult[]> {
  const url = new URL(endpoints[engine]);
  if (engine === 'baidu') url.searchParams.set('rn', String(Math.min(count, 10)));
  if (engine === 'bing') url.searchParams.set('format', 'rss');
  if (engine === 'github') url.searchParams.set('per_page', String(count));
  url.searchParams.set(engine === 'baidu' ? 'word' : 'q', query);
  const init: RequestInit = {signal, redirect: 'manual', headers: {
    'User-Agent': 'PublicReferenceSearch/1.0',
    Accept: engine === 'github' ? 'application/vnd.github+json' : '*/*',
  }};
  let response = await publicTransport.fetch(url, init);
  for (let hop = 0; hop < 2 && [301,302,303,307,308].includes(response.status); hop++) {
    const location = response.headers.get('location');
    if (!location || !URL.canParse(location, url.href)) break;
    const next = new URL(location, url);
    const allowedHost = next.origin === url.origin || (engine === 'bing' && next.origin === 'https://cn.bing.com');
    if (!allowedHost || next.pathname !== url.pathname || next.username || next.password) break;
    await response.body?.cancel();
    response = await publicTransport.fetch(next, init);
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0'))
      throw new Error('来源限流，请稍后重试');
    throw new Error('来源暂不可用（HTTP ' + response.status + '）');
  }
  const body = await boundedText(response);
  if (engine === 'github') {
    const data = JSON.parse(body);
    if (!Array.isArray(data.items)) throw new Error('仓库搜索格式已变化');
    return data.items.filter((r: Record<string,unknown>) => typeof r?.full_name === 'string' && typeof r.html_url === 'string' && r.html_url.startsWith('https://github.com/'))
      .map((r: {full_name:string;html_url:string;description?:string}) => result(r.full_name, r.html_url, r.description ?? ''));
  }
  if (engine === 'bing') {
    const $ = load(body, {xml: true});
    if (!$('rss > channel').length) {
      if (/captcha|安全验证|验证码/i.test(body.slice(0, 20_000))) throw new Error('Bing 要求安全验证');
      throw new Error('Bing 暂不可用，响应不是搜索结果');
    }
    return $('channel > item').toArray().map(item => {
      const field = (name:string) => $(item).children(name).text();
      return result(field('title'), field('link'), field('description'), field('pubDate') || null);
    });
  }
  const $ = load(body);
  if (/安全验证|验证码|captcha/i.test($('title').text()) || $('#captcha').length)
    throw new Error('百度要求安全验证');
  const cards = $('.result[data-log]');
  const rows: SearchResult[] = [];
  for (const card of cards) {
    const anchor = $(card).find('h3').first();
    if (!anchor.length) continue;
    let link: unknown;
    try { link = JSON.parse($(card).attr('data-log') ?? '{}').mu; } catch { continue; }
    if (typeof link !== 'string') continue;
    rows.push(result(anchor.text(), link, $(card).find('.c-abstract, [class*="abstract"], [class*="summary"]').first().text()));
  }
  if (!rows.length && !/没有找到|未找到相关|抱歉，没有找到/.test($('body').text()))
    throw new Error('百度暂不可用，未识别到搜索结果页');
  return rows;
}
