import {parseCanonicalIP, stripHostPort} from '../db/task_scope.js';
import {getDomain} from 'tldts';
import {assetHost} from '../db/asset-write.js';

export interface UserTargetInput {
  kind: 'root_domain' | 'subdomain' | 'ip' | 'cidr';
  value: string;
  evidence: string;
}

function targetHost(value: string): string {
  let host = value;
  if (/^https?:\/\//i.test(host)) {
    const url = new URL(host);
    if (url.username || url.password) throw new Error('目标 URL 不得包含凭据');
    host = url.hostname;
  } else {
    if (/[/?#%@\\]/u.test(host)) throw new Error('目标需要精确主机或完整 HTTP/HTTPS URL');
    host = stripHostPort(host);
  }
  host = host.replace(/^\[([^\]]+)\]$/, '$1');
  return assetHost(host);
}

function targetIdentity(kind: UserTargetInput['kind'], value: string): string {
  if (kind === 'cidr') {
    const match = /^([^/]+)\/(\d{1,3})$/.exec(value);
    const ip = match && parseCanonicalIP(match[1]!);
    const bits = Number(match?.[2]);
    if (!ip || bits > (ip.includes(':') ? 128 : 32)) throw new Error('value 需要完整有效的 CIDR');
    return ip + '/' + bits;
  }
  const host = targetHost(kind === 'root_domain' ? value.replace(/^\*\./, '') : value);
  if (kind === 'ip' ? !parseCanonicalIP(host) : !!parseCanonicalIP(host)) throw new Error('value 与 kind 不匹配');
  if (kind === 'root_domain' && getDomain(host, {allowPrivateDomains: true}) !== host)
    throw new Error('root_domain 必须是明确授权的根域，不能从子域推导');
  return host;
}

function matchTargetEvidence(input: string, sources: readonly string[]): string | undefined {
  const evidence = input.trim();
  const quote = evidence.replace(/[。！？]$/u, '').trim();
  if (quote && sources.some(source => source.split(/[\r\n。！？]+/u).some(clause => clause.trim() === quote))) {
    return evidence;
  }

  // A target label and its value may occupy two lines. Accept an escaped line
  // break from tool arguments only when both lines match an actual source block.
  const [heading, target, ...extra] = evidence.replace(/\r\n?|\\r\\n|\\n/gu, '\n').split('\n');
  if (!heading || !target || extra.length || !/^(?:目标|测试目标|授权目标|测试地址|target|test target)\s*[:：]$/iu.test(heading.trim())) {
    return;
  }
  for (const source of sources) {
    const lines = source.split(/(\r\n|\r|\n)/u);
    for (let index = 0; index + 2 < lines.length; index += 2) {
      if (lines[index]!.trim() === heading.trim() && lines[index + 2]!.trim() === target.trim()) {
        return lines.slice(index, index + 3).join('').trim();
      }
    }
  }
}

/** Match an intact user quote and the exact locator within it. This establishes
 * textual provenance, not a semantic judgment about every user constraint. */
export function groundUserTarget(input: UserTargetInput, sources: readonly string[]) {
  const evidence = matchTargetEvidence(input.evidence, sources);
  if (!evidence)
    throw new Error('evidence 须引用目标或描述中的完整原句或独立目标地址行，保留条件和例外；原文的目标标题与地址相邻时也可一起引用');
  if (!['root_domain', 'subdomain', 'ip', 'cidr'].includes(input.kind)) throw new Error('未知目标 kind');
  const value = targetIdentity(input.kind, input.value.trim());
  const exclusion = /禁止|不要|不得|不允许|不测试|仅供参考|仅作参考|示例|排除|(?:\bdo not\b|\bdon't\b|\bmust not\b|\bnot allowed\b|\bexcluded?\b|\bout of scope\b|\bfor reference\b)/iu;
  const mentionsTarget = (clause: string) => {
    const tokens = clause.match(/[^\s<>"'`“”‘’，。；：！？、（）「」【】(),;]+/gu) ?? [];
    return tokens.some(raw => {
      const token = raw.replace(/[.!?]+$/u, '');
      if (input.kind === 'root_domain' && (!token.startsWith('*.') || /[:/]/u.test(token))) return false;
      try { return targetIdentity(input.kind, token) === value; }
      catch { return false; }
    });
  };
  // Keep the full quote for conditions and exceptions, but allow unrelated
  // restrictions in another clause of the same quote.
  const clauses = evidence.split(/[，,；;]/u);
  const matching = clauses.filter(mentionsTarget);
  if (!matching.length) throw new Error('value 必须对应 evidence 中明确出现的精确主机、CIDR 或通配根域');
  if (matching.some(clause => exclusion.test(clause)) ||
      clauses.some((clause, index) => exclusion.test(clause) && mentionsTarget(clauses[index + 1] ?? '') &&
        !/测试|检查|允许|授权|\ballow\b|\btest\b/iu.test(clauses[index + 1]!)))
    throw new Error('evidence 中该目标处于否定或参考语句，不能登记');
  return {kind: input.kind, value, evidence};
}
