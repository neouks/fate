export const REPORTER_SAVE_GUIDANCE = `用 update_finding_report 提交 report_sections、evidence_version 和 report_revision。description、discovery.vulnerability、discovery.asset 用精简、直接的自然语言描述；缺乏依据的思路省略，两项均无依据时提交 discovery: {}。优先复用 get_finding 中已有的证据及流量绑定；足以支持结论时不重复检索。仅修改报告文字时省略 reproduction，由平台保留已有步骤并读取已存流量组装报文，不要重复提交请求和响应。需要新增或调整步骤时保留原步骤 ID；引用已核对的真实 traffic_id，request/response 可传空字符串，由平台填入原始报文。只在依据不足时用已有流量检索与 context_get 按需核对，URL 命中不等于已证实漏洞。复现过程连续叙述；最终报告的 HTTP 请求和响应保留完整起始行、全部 Header、空行及完整 Body，不以 curl 或 JSON 片段代替报文。证据缺失、截断或非文本时如实说明并保留来源，不补造、不探测。版本冲突先重读，成功回执才算保存。`;

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
  const summary = description.trim();
  const conciseDiscovery: ReportDiscovery = {};
  for (const key of discoveryKeys) {
    const content = ((discovery[key] as string | undefined) ?? '').trim();
    if (content) conciseDiscovery[key] = content;
  }
  if (!summary) throw invalid('漏洞描述不能为空');
  return { description: summary, impact, remediation, discovery: conciseDiscovery };
}

// Concision is a writing guideline; never truncate saved evidence or prose.
export function reportSectionsSchema(reporter: boolean) {
  return {
    type: 'object',
    properties: {
      description: { type: 'string', pattern: '\\S', description: reporter ? '精简、直接的自然语言，说明问题和实际影响' : '漏洞描述' },
      impact: { type: 'array', items: { type: 'string' }, description: '优先 1–2 条，每条一句，只写证据支持的影响' },
      remediation: { type: 'array', items: { type: 'string' }, description: '优先 1–2 条，每条一句，直接说明怎么修' },
      discovery: {
        type: 'object', additionalProperties: false,
        description: '缺少依据的思路省略，两项均无依据时提交 {}',
        properties: {
          vulnerability: { type: 'string', description: '用精简、直接的自然语言说明确认漏洞的关键观察' },
          asset: { type: 'string', description: '用精简、直接的自然语言说明定位资产的关键线索' },
        },
      },
    },
    required: ['description', 'impact', 'remediation', ...(reporter ? ['discovery'] : [])],
    additionalProperties: false,
  };
}
