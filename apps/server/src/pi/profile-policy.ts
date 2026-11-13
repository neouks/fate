/** Shared save/preview/request policy. No credentials or model calls. */
export interface ProfilePolicyInput {
  model: string; format?: string; thinkingType?: string; reasoningEffort?: string;
  contextWindowK: number; maxTokens: number; maxTokensField?: string;
  ratePerSecond?: number; ratePerMinute?: number; sessionHeaderKey?: string; proxy?: string;
}
export const isDeepSeekHybrid = (model: string) => /^deepseek-(?:flash|v4(?:\.1)?-(?:flash|pro))$/i.test(model.trim());
const efforts = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export function profilePolicy(p: ProfilePolicyInput) {
  const deepseek = isDeepSeekHybrid(p.model);
  const legacy = efforts.includes(p.thinkingType ?? '') && !!p.thinkingType && !['off'].includes(p.thinkingType);
  const mode = p.thinkingType === 'disabled' || p.thinkingType === 'off' || p.reasoningEffort === 'off'
    ? 'disabled' : p.thinkingType === 'enabled' || legacy || !!p.reasoningEffort ? 'enabled' : 'default';
  const requested = p.reasoningEffort || (legacy ? p.thinkingType : '') || (deepseek ? 'high' : 'medium');
  const effort = deepseek ? ['max','ultra'].includes(requested!) ? 'max' : ['low','minimal'].includes(requested!) ? 'low' : 'high' : requested!;
  const level = mode === 'disabled' || mode === 'default' && !deepseek ? 'off'
    : ['max','ultra'].includes(effort) ? 'xhigh' : effort;
  return {version:'profile-v2', deepseek, mode, effort, level:level as 'off'|'minimal'|'low'|'medium'|'high'|'xhigh',
    contextWindow:p.contextWindowK > 0 ? p.contextWindowK * 1000 : 128_000,
    outputLimit:p.maxTokens > 0 ? p.maxTokens : p.format === 'anthropic' && !deepseek ? 8192 : null,
    application:'next_session', rateScope:'profile', legacyThinking:legacy};
}
export function validateProfilePolicy(p: ProfilePolicyInput) {
  const bad = (message:string):never => {throw Object.assign(new Error(message), {statusCode:400,code:'INVALID_MODEL_CONFIGURATION'});};
  if (!['openai','anthropic','openai-responses'].includes(p.format || 'openai')) bad('不支持的模型协议');
  if (!['','enabled','disabled',...efforts].includes(p.thinkingType ?? '')) bad('无效的思考开关');
  if (!efforts.includes(p.reasoningEffort ?? '')) bad('无效的思考强度');
  if (!isDeepSeekHybrid(p.model) && ['max','ultra'].includes(p.reasoningEffort ?? '')) bad('此通用模型适配不支持 max/ultra，请使用 xhigh 或供应商支持的档位');
  for (const [key,value,max] of [['上下文窗口',p.contextWindowK,1000],['输出上限',p.maxTokens,isDeepSeekHybrid(p.model)?131072:1_000_000],['每秒请求数',p.ratePerSecond??0,1_000_000],['每分钟请求数',p.ratePerMinute??0,1_000_000]] as const) {
    if (!Number.isFinite(value) || value < 0 || value > max || (key !== '每秒请求数' && key !== '每分钟请求数' && !Number.isInteger(value))) bad(`${key} 必须在 0–${max} 范围内`);
  }
  if (p.contextWindowK > 0 && p.maxTokens > p.contextWindowK*1000) bad('输出上限不能超过上下文窗口');
  if (p.maxTokensField && (p.format !== 'openai' || !['max_tokens','max_completion_tokens'].includes(p.maxTokensField))) bad('输出字段覆盖仅支持 OpenAI 的 max_tokens/max_completion_tokens');
  const header=p.sessionHeaderKey?.trim();
  if(header && (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header) || /^(authorization|proxy-authorization|x-api-key|api-key|host|content-type|content-length|connection|transfer-encoding|cookie)$/i.test(header))) bad('会话请求头无效或与认证/传输请求头冲突');
  if(p.proxy) {try{const u=new URL(p.proxy);if(!['http:','https:'].includes(u.protocol))bad('代理只支持 HTTP/HTTPS 地址');}catch{bad('代理只支持有效 HTTP/HTTPS 地址');}}
}

/** Apply provider fields after pi builds its native request. Request-level off
 * (e.g. compaction) wins over profile defaults; disabling wins over effort. */
export function applyDeepSeekThinking(payload:Record<string,unknown>, p:ProfilePolicyInput, options:Record<string,unknown>, api:string) {
  const policy=profilePolicy(p);
  if(!policy.deepseek)return payload;
  const requested=options.reasoning ?? options.reasoningEffort ?? (options.thinkingEnabled ? policy.level : undefined);
  const off=policy.mode==='disabled'||!requested||requested==='off';
  const effort=requested==='xhigh' && policy.effort==='max' ? 'max' : ['max','ultra'].includes(String(requested))?'max':['minimal','low'].includes(String(requested))?'low':'high';
  const out={...payload};delete out.thinking;delete out.reasoning_effort;delete out.output_config;delete out.reasoning;
  // An unconfigured profile uses the provider default. A request-level off is
  // still explicit so summaries never inherit server-default thinking.
  if(policy.mode==='default'&&!off)return out;
  if(api==='openai-responses')out.reasoning={effort:off?'none':effort};
  else {out.thinking={type:off?'disabled':'enabled'};if(!off){if(api==='anthropic-messages')out.output_config={effort};else out.reasoning_effort=effort;}}
  return out;
}

export function validateRetryRule(value:unknown) {
  if(value==null)return;
  if(typeof value!=='object'||Array.isArray(value))throw Object.assign(new Error('重试策略必须为对象'),{statusCode:400});
  const rule=value as Record<string,unknown>;
  for(const [key,min,max] of [['attempts',-1,20],['interval_ms',0,3600000]] as const){
    const n=Number(rule[key]??0);
    if(!Number.isSafeInteger(n)||n<min||n>max)throw Object.assign(new Error(`${key} 必须是 ${min}–${max} 的整数`),{statusCode:400});
  }
}

/** Compare retired settings by their fields, independent of JSON key order. */
export function rejectRetiredRetry(value:unknown, previous:unknown, name:string) {
  if(value==null)return;
  validateRetryRule(value);
  const next=value as Record<string,unknown>,old=(previous??{}) as Record<string,unknown>;
  if(['attempts','interval_ms'].some(k=>Number(next[k]??0)!==Number(old[k]??0)) &&
     ['attempts','interval_ms'].some(k=>Number(next[k]??0)!==0))
    throw Object.assign(new Error(`${name} 已停用，历史值只读保留，请移除此配置`),{statusCode:400});
}
