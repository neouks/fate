import { REPORTER_SAVE_GUIDANCE } from '../evidence/report-sections.js';

/** Exact shipped text from ARTEX agent/tools.go:setConstraints. No fuzzy matching:
 * edited descriptions remain user configuration. */
export const ARTEX_CONSTRAINT_DESCRIPTION =
  '给【本任务】新增操作约束,用来框定探索边界:type=allow(允许做的操作)或 deny(禁止做的操作)。\n'+
  '约束=对『可以/不可以做哪些操作』的规定(如『仅测当前端口,不扫其他端口』『禁止对生产库做写操作』『只允许被动侦察』),不是目标、也不是攻击步骤。\n'+
  '★优先批量:多条放进 constraints 数组一次提交,返回 ids 与之等长同序(失败项 id=0,详情见 errors)。单条则省略 constraints 直接给顶层 text/type。\n'+
  '只登记任务目标/描述里【明确写出】的约束,不要臆造;拿不准类型时用 deny(更保守)。';
export const ARTEX_INTENT_DESCRIPTION = "生成【探索方向】写入 frontier，并连入探索链路。意图是开放的探索方向，不是固定类型——用 summary 一句话自由描述要探索/验证/利用什么。\n主 Agent 成功下发后结束本轮，Worker 自动回传总结，不轮询等待。Planner 对未审批候选本轮跳过；主 Agent 可明确下发待审批资产方向，但封禁和撤回仍拒绝。未知候选先批量 check_target_access。★优先批量：一轮筛出的多个新方向放进 intents 数组一次提交（最多 4 条，比逐条调用省往返）。返回 ids 数组，与 intents 等长同序（失败项 id=0，详情见 errors；已存在的活跃同方向见 duplicates）。单条则省略 intents 直接给顶层 summary。";
const previousConstraintDescription = '保存用户明确的操作要求，text/source_quote 必须为任务原文或本轮用户消息中的完整段落，保留例外和原有语气。不能把目标 URL 改写成仅限该地址；allow 不默认排他。';

export const PREVIOUS_TRAFFIC_SEARCH_DESCRIPTION="查询记录代理已抓取的目标流量（必须指定 host；支持裸主机、主机:端口或完整 URL，可再按 URL 子串或正文关键词过滤）。指定端口时只返回该服务的流量，避免同一 IP 的不同端口串包。body_contains 会在已抓取的请求/响应头与正文中做全文搜索，支持任意子串和中文（至少 3 个字符）。仅返回极轻量索引(id/method/url/status/resp_len)，不含响应内容；结果非空后必须用 traffic_get 逐条核实请求/响应，再把确实支持当前漏洞的 ID 交给 bind_finding_traffic。默认只返回 3 条、每页最多 10 条；结果多时用 page 翻页。";

export function recognizedHistoricalDescription(name:string,stored:unknown):unknown {
  if(name==='traffic_search'&&stored===PREVIOUS_TRAFFIC_SEARCH_DESCRIPTION)return undefined;
  if(name==='add_intent'&&stored===ARTEX_INTENT_DESCRIPTION)return undefined;
  return name==='set_constraints'&&[ARTEX_CONSTRAINT_DESCRIPTION,previousConstraintDescription].includes(stored as string)?undefined:stored;
}

/** These are built-in capability hints, not edits to the user's prompt or text. */
export function roleToolDescription(name:string,resolved:{description:string;source:string},role:string):string {
  if (resolved.source !== 'builtin') return resolved.description;
  if (name==='report_finding' && role==='pentest') return resolved.description.replaceAll('report_finding','report_conversation_finding');
  if (name === 'update_finding_report') return resolved.description + (role === 'reporter'
    ? ' ' + REPORTER_SAVE_GUIDANCE : ' 提交 report_sections 或兼容的非空 report。');
  let description = resolved.description;
  if (role !== 'planner' && name === 'context_search')
    description = description.replace(' Planner 可用 source=planner_session 检索本任务历史规划原文；历史不能代替实时图查询。','');
  if (role !== 'planner' && name === 'context_get')
    description = description.replace(' Planner 可读本任务 session: 条目，field=/content 续读历史原文。','');
  return description;
}

/** Shared by the tool catalog and role-specific declarations. */
export function describeToolContract(name: string, description: string): string {
  if (name === 'asset_search') return description + ' DSL 可用 tested==true 或 tested==false 筛选任务覆盖状态，与 untested 共享角色权限及覆盖度开关。';
  if (name === 'prove_goal') return description + ' 每次只证明一项目标；证据校验成功后直接标记 met，明确的资产覆盖度 100% 另由宿主核对实时覆盖记录。以 met/all_goals_met 回执为准。';
  if (name === 'add_intent') return description + ' 统一传 1–4 项 intents，单条也放入数组，每项各填非空 summary。parent_ids 仅限本任务；直接来源任务用 contract.basis 的 node_id 和实际内容版本。';
  if (name === 'dispatch_intents') return description + ' 提交非空 intent_ids；仅用户明确要求批量下发时传 all_open: true。';
  if (name === 'record_fact') return description.replace('缺项仍保存但不计覆盖','缺少资产或 scope 时仍保存但不计覆盖')
    + ' Worker 每条事实必填非空 evidence；批量逐项核对结果，整批失败返回工具错误。';
  if (name === 'insert_assets') return description + ' 整批失败返回工具错误，部分成功只重试失败项。';
  if (name === 'register_user_target') return description + ' evidence 引用完整原句或独立目标地址行。精确域名用 subdomain；root_domain 仅用于原文明确的通配根域。';
  if (name === 'context_get') return description + ' 任一项失败则调用标为失败，成功项仍保留；长正文需选择 field，按 read_options 选择读取。';
  if (name === 'context_search') return description + ' source=operations/needs 不支持图谱筛选 q/types/state/asset_id。';
  return description;
}

export function roleToolParameters(name:string,parameters:Record<string,unknown>,role:string):Record<string,unknown> {
  if(role==='planner'||!['context_search','context_get'].includes(name))return parameters;
  const result=structuredClone(parameters) as any;
  if(name==='context_search'&&result.properties?.source){
    delete result.properties.roles;
    delete result.properties.include_content;
    const source=result.properties.source;
    if(Array.isArray(source.enum))source.enum=source.enum.filter((value:string)=>value!=='planner_session');
    if(typeof source.description==='string')source.description=source.description.replace('；planner_session 召回规划历史','');
  }
  if(name==='context_get'){
    const ref=result.properties?.items?.items?.properties?.ref;
    if(typeof ref?.pattern==='string')ref.pattern=ref.pattern.replace('session:[a-zA-Z0-9_-]+|','');
  }
  return result;
}
