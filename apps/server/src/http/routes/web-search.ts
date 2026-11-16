import type { FastifyInstance } from 'fastify';
import { deepseekSearch, webSearchSettings } from '../../search/deepseek.js';
import { WEB_SEARCH_ROLES } from '../../search/policy.js';

export function registerWebSearchRoutes(app: FastifyInstance) {
  app.get('/api/settings/web-search', () => webSearchSettings(app.db));
  app.put('/api/settings/web-search', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.web_search_enabled !== 'boolean' ||
        (body.api_key !== undefined && (typeof body.api_key !== 'string' || body.api_key.length > 4096 || /\s/.test(body.api_key.trim()))) ||
        (body.clear_key !== undefined && typeof body.clear_key !== 'boolean') ||
        (body.agent_roles !== undefined && (!Array.isArray(body.agent_roles) || body.agent_roles.some(role => !(WEB_SEARCH_ROLES as readonly unknown[]).includes(role))))) {
      return reply.code(400).send({ error: '请提供有效的搜索开关和 API Key' });
    }
    await app.db.transaction(async db => {
      await db.platform().setSetting('web_search_enabled', String(body.web_search_enabled));
      await db.platform().setSetting('web_search_backend', 'deepseek');
      if (Array.isArray(body.agent_roles)) {
        const roles = [...new Set(body.agent_roles as string[])];
        await db.query('UPDATE agents SET web_search=(key=ANY($1::text[])) WHERE key=ANY($2::text[])', [roles, [...WEB_SEARCH_ROLES]]);
        await db.query(`INSERT INTO tools(key,system,kind,description,schema,agents,enabled)
          VALUES('web_search',true,'builtin','DeepSeek 官方网络搜索','{}',$1::jsonb,true)
          ON CONFLICT(key) DO UPDATE SET agents=EXCLUDED.agents,enabled=true`, [JSON.stringify([...WEB_SEARCH_ROLES])]);
      }
      if (body.clear_key === true) await db.platform().setSetting('deepseek_search_api_key', '');
      else if (typeof body.api_key === 'string' && body.api_key.trim()) await db.platform().setSetting('deepseek_search_api_key', body.api_key.trim());
    });
    return webSearchSettings(app.db);
  });
  app.post('/api/settings/web-search/test', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      if (body.api_key !== undefined && (typeof body.api_key !== 'string' || body.api_key.length > 4096 || /\s/.test(body.api_key.trim()))) throw new Error('请提供有效的 DeepSeek API Key');
      const result = await deepseekSearch(app.db, { query: body.query === undefined ? 'DeepSeek 官方 API 文档' : body.query as string, count: 3 }, { apiKey: body.api_key as string | undefined });
      return { ok: true, ...result };
    } catch (error) { return { ok: false, backend: 'deepseek', error: (error as Error).message }; }
  });
}
