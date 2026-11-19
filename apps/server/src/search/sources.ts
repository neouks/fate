import type { Database } from '../db/index.js';

export const SOURCES = ['deepseek', 'baidu', 'bing', 'github', 'cnblogs', 'csdn', 'wechat'] as const;
export type Source = typeof SOURCES[number];
export type Selection = Source | 'auto';
export type Preferences = { sources: Source[]; default_source: Selection };
export const COMMUNITY = { cnblogs: 'cnblogs.com', csdn: 'blog.csdn.net', wechat: 'mp.weixin.qq.com' } as const;
const original: Preferences = { sources: [...SOURCES], default_source: 'deepseek' };

export function isSource(value: unknown): value is Source {
  return SOURCES.some(source => source === value);
}

export function preferences(sources: unknown, selected: unknown): Preferences {
  if (!Array.isArray(sources) || !sources.length || !sources.every(isSource))
    throw new Error('请选择至少一个有效来源');
  if (selected !== 'auto' && (!isSource(selected) || !sources.includes(selected)))
    throw new Error('默认来源须已启用');
  if (sources.some(s => s in COMMUNITY) && !sources.includes('baidu') && !sources.includes('bing'))
    throw new Error('社区文章检索需要启用 Bing 或百度');
  return { sources: [...new Set(sources)], default_source: selected };
}

export async function readPreferences(db: Database): Promise<Preferences> {
  const value = await db.platform().getSetting('public_reference_sources');
  if (!value) return original;
  const parsed = JSON.parse(value);
  return preferences(parsed.sources, parsed.default_source);
}
