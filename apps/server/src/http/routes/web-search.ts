import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWebAccessConfig, updateWebAccessConfig, resolvedConfig, webSearchSettings, WEB_ACCESS_SETTING, WEB_TOOLS } from '../../search/web-access-config.js';
import { WebAccessHost, webAccessRuntime } from '../../search/web-access-host.js';

export function registerWebSearchRoutes(app: FastifyInstance) {
  app.get('/api/settings/web-search', () => webSearchSettings(app.db));
  app.put('/api/settings/web-search', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const roles = (await app.db.platform().listAgents()).map(agent => agent.key);
    if (typeof body.web_search_enabled !== 'boolean' || body.agent_roles !== undefined &&
      (!Array.isArray(body.agent_roles) || body.agent_roles.some(role => typeof role !== 'string' || !roles.includes(role))))
      return reply.code(400).send({ error: '请提供有效的搜索开关和 Agent 列表' });
    try {
      await app.db.transaction(async db => {
        await db.query('SELECT pg_advisory_xact_lock(4200000034)');
        const config = updateWebAccessConfig(await readWebAccessConfig(db), body);
        await db.platform().setSetting(WEB_ACCESS_SETTING, JSON.stringify(config));
        await db.platform().setSetting('web_search_enabled', String(body.web_search_enabled));
        await db.platform().setSetting('pi_web_access_migration_notice', '');
        if (Array.isArray(body.agent_roles)) {
          const selected = [...new Set(body.agent_roles as string[])];
          await db.query('UPDATE agents SET web_search=(key=ANY($1::text[])) WHERE key=ANY($2::text[])', [selected, roles]);
          // Preserve explicit tool restrictions; insert only absent rows.
          for (const name of WEB_TOOLS) await db.query(`INSERT INTO tools(key,system,kind,description,schema,agents,enabled)
            VALUES($1,true,'builtin',$2,'{}',$3::jsonb,true) ON CONFLICT(key) DO NOTHING`, [name, 'pi-web-access '+name, JSON.stringify(selected)]);
        }
      });
      return webSearchSettings(app.db);
    } catch { return reply.code(400).send({ error: '搜索配置无效，请检查供应商、默认来源、搜索站点、密钥文本和地址格式' }); }
  });
  app.post('/api/settings/web-search/test', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    let host: WebAccessHost | undefined, directory: string | undefined;
    try {
      if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 1000) throw new Error('请提供 1–1000 字符的搜索词');
      const config = await resolvedConfig(app.db, updateWebAccessConfig(await readWebAccessConfig(app.db), body));
      const source = body.source ?? config.default_source;
      if (source !== 'auto' && !config.sources.includes(source as never)) throw new Error('测试来源未启用');
      directory = await mkdtemp(join(tmpdir(), 'series-web-test-')); host = webAccessRuntime.create(directory);
      const started = performance.now();
      const result = await host.call(config, 'web_search', { query: body.query.trim(), provider: source, numResults: 3, workflow: 'none', includeContent: false }, [], AbortSignal.timeout(60_000));
      const payload = (result as typeof result & { structuredContent?: { queries?: Array<{ provider?: string; results?: Array<{title: string; url: string; snippet: string}> }> } }).structuredContent;
      const results = payload?.queries?.flatMap(query => (query.results ?? []).map(row => ({ ...row, engine: query.provider ?? source, source: query.provider ?? source, summary: row.snippet }))) ?? [];
      return { ok: !result.isError, results, count: results.length, latency_ms: Math.round(performance.now() - started),
        ...(result.isError ? { error: result.content.filter(part => part.type === 'text').map(part => part.text).join('\n').slice(0, 2000) } : {}) };
    } catch { return { ok: false, error: '测试失败，请检查搜索词、供应商配置、凭证与网络' }; }
    finally { await host?.dispose(); if (directory) await rm(directory, { recursive: true, force: true }); }
  });
}
