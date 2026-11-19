import type {TokenTotal} from './types';

export const TOKEN_USAGE_NOTE = '总量 = 非缓存输入 + 缓存读取 + 缓存写入 + 输出；缓存不重复计入。';
const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** API input_tokens already includes cache. Never infer exclusive input from
 * legacy/unknown semantics, and never add cache to that total a second time. */
export function tokenBreakdown(usage?: TokenTotal | null) {
  const input = count(usage?.input_tokens), output = count(usage?.output_tokens);
  const cacheRead = count(usage?.cache_read_tokens), cacheWrite = count(usage?.cache_write_tokens);
  const knownInput = usage?.input_semantics === 'inclusive_cache' && usage.input_complete !== false;
  const derived = input !== null && cacheRead !== null && cacheWrite !== null ? count(input - cacheRead - cacheWrite) : null;
  return {input, output, cacheRead, cacheWrite,
    uncached: knownInput ? count(usage?.uncached_input_tokens) ?? derived : null,
    total: input !== null && output !== null ? input + output : null,
    incomplete: !!usage && (usage.usage_complete === false || !knownInput), knownInput};
}

export function tokenMetrics(usage?: TokenTotal | null) {
  const tokens = tokenBreakdown(usage);
  return [
    {label: '非缓存输入', value: tokens.uncached},
    {label: '缓存读取', value: tokens.cacheRead},
    {label: '缓存写入', value: tokens.cacheWrite},
    {label: '输出', value: tokens.output},
    {label: tokens.incomplete ? '总量（已记录）' : '总量', value: tokens.total},
  ];
}

export function tokenUsageDetails(usage?: TokenTotal | null) {
  return tokenMetrics(usage).map(({label,value}) => `${label} ${value === null ? '未知' : value.toLocaleString('zh-CN')}`).join(' · ')
    + (usage && !tokenBreakdown(usage).knownInput ? '；历史输入口径未核定，非缓存输入未知。' : `；${TOKEN_USAGE_NOTE}`);
}

/** Disjoint chart segments. Unknown historical input stays in its own segment,
 * never mislabeled as uncached input or stacked again with reported cache. */
export function tokenChartParts(usage: TokenTotal) {
  const tokens = tokenBreakdown(usage), known = tokens.uncached !== null;
  return {input: tokens.uncached ?? 0, output: tokens.output ?? 0,
    cacheRead: known ? tokens.cacheRead ?? 0 : 0, cacheWrite: known ? tokens.cacheWrite ?? 0 : 0,
    unknownInput: known ? 0 : tokens.input ?? 0};
}
