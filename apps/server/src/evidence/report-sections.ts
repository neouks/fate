export const REPORT_TEXT_LIMIT = 60;
export const REPORTER_SAVE_GUIDANCE = `用 update_finding_report 提交 report_sections、evidence_version 和 report_revision。description、discovery.vulnerability、discovery.asset 各最多 ${REPORT_TEXT_LIMIT} 字；缺乏依据的思路省略，两项均无依据时提交 discovery: {}。超长按回执只改对应字段，版本冲突先重读，成功回执才算保存。`;

export const DISCOVERY_LABELS = { vulnerability: '漏洞发现思路', asset: '资产发现思路' } as const;
type DiscoveryKey = keyof typeof DISCOVERY_LABELS;
const discoveryKeys = Object.keys(DISCOVERY_LABELS) as DiscoveryKey[];
export type ReportDiscovery = Partial<Record<DiscoveryKey, string>>;
export interface ReportSections {
  description: string;
  impact: string[];
  remediation: string[];
  discovery?: ReportDiscovery;
}

const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string');

export function reportSections(value: unknown, requireDiscovery = false): ReportSections {
  if (!isObject(value) || typeof value.description !== 'string' || !strings(value.impact) || !strings(value.remediation) ||
      Object.keys(value).some(key => !['description', 'impact', 'remediation', 'discovery'].includes(key))) {
    throw invalid('报告字段格式错误，需要 description、impact、remediation，可附 discovery');
  }
  const { description, impact, remediation, discovery } = value;
  if (discovery === undefined) {
    if (requireDiscovery) throw invalid('需要 report_sections.discovery；两项均无依据时传空对象 {}');
    return { description, impact, remediation };
  }
  if (!isObject(discovery) || Object.entries(discovery).some(([key, content]) =>
    !Object.hasOwn(DISCOVERY_LABELS, key) || typeof content !== 'string')) {
    throw invalid('discovery 只接受文本字段 vulnerability、asset');
  }
  const limits: string[] = [];
  function check(content: string, label: string) {
    const trimmed = content.trim();
    const length = Array.from(trimmed).length;
    if (length > REPORT_TEXT_LIMIT) limits.push(`${label}实际 ${length} 字，上限 ${REPORT_TEXT_LIMIT} 字`);
    return trimmed;
  }
  const summary = check(description, '漏洞描述');
  const conciseDiscovery: ReportDiscovery = {};
  for (const key of discoveryKeys) {
    const content = check((discovery[key] as string | undefined) ?? '', DISCOVERY_LABELS[key]);
    if (content) conciseDiscovery[key] = content;
  }
  if (limits.length) throw invalid(`请只精简超长字段后重新提交：${limits.join('；')}`);
  if (!summary) throw invalid('漏洞描述不能为空');
  return { description: summary, impact, remediation, discovery: conciseDiscovery };
}

// Describe the limit here and enforce it after trimming in reportSections so
// model errors include the actual Unicode character count.
export function reportSectionsSchema(reporter: boolean) {
  return {
    type: 'object',
    properties: {
      description: { type: 'string', pattern: '\\S', description: reporter ? `一句通俗结论，最多 ${REPORT_TEXT_LIMIT} 字` : '漏洞描述' },
      impact: { type: 'array', items: { type: 'string' }, description: '优先 1–2 条，每条一句，只写证据支持的影响' },
      remediation: { type: 'array', items: { type: 'string' }, description: '优先 1–2 条，每条一句，直接说明怎么修' },
      discovery: {
        type: 'object', additionalProperties: false,
        description: '缺少依据的思路省略，两项均无依据时提交 {}',
        properties: {
          vulnerability: { type: 'string', description: `确认漏洞的关键观察，最多 ${REPORT_TEXT_LIMIT} 字` },
          asset: { type: 'string', description: `定位相关资产的关键线索，最多 ${REPORT_TEXT_LIMIT} 字` },
        },
      },
    },
    required: ['description', 'impact', 'remediation', ...(reporter ? ['discovery'] : [])],
    additionalProperties: false,
  };
}
