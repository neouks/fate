import { domainTool } from './define.js';
import type { ToolRunContext } from './context.js';
import { deepseekSearch, type SearchInput } from '../search/deepseek.js';
import { assertToolBinding } from '../agent/tool-registry.js';
import { WEB_SEARCH_ROLES, WEB_SEARCH_DESCRIPTION } from '../search/policy.js';

export async function webSearchAllowed(db: ToolRunContext['db'], role: string) {
  if (!(WEB_SEARCH_ROLES as readonly string[]).includes(role)) return false;
  if (!await db.platform().getBool('web_search_enabled', false)) return false;
  return (await db.platform().getAgentByKey(role))?.webSearch === true;
}

export function webSearchTool(ctx: ToolRunContext) {
  return domainTool<SearchInput>({
    name: 'web_search', readOnly: true, transactional: false,
    description: WEB_SEARCH_DESCRIPTION,
    parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 128 }, count: { type: 'integer', minimum: 1, maximum: 50, default: 5 } }, required: ['query'] },
    async run(args, current) {
      await assertToolBinding(current.db, current.role, 'web_search');
      if (!await webSearchAllowed(current.db, current.role)) throw new Error('网络搜索已关闭，请检查系统和 Agent 的网络搜索开关');
      return deepseekSearch(current.db, args, { signal: current.signal });
    },
  }, ctx);
}
