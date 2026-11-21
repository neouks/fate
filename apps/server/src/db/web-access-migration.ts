import type { Database } from './index.js';
import { WEB_ACCESS_SETTING, type WebAccessConfig } from '../search/web-access-config.js';
import legacyDescriptions from '../search/legacy-descriptions.json' with { type: 'json' };

/** One-time replacement; later user-created MCP entries are not deleted on restart. */
export async function migrateWebAccess(db: Database) {
  await db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(4200000033)');
    if (await tx.platform().getSetting('pi_web_access_migrated_v1') === 'true') return;
    await tx.query(`INSERT INTO settings(key,value) SELECT 'pi_web_access_previous_mcp',jsonb_agg(to_jsonb(m))::text FROM mcp_servers m WHERE name='web_search' HAVING count(*)>0 ON CONFLICT(key) DO NOTHING`);
    await tx.query(`DELETE FROM agent_visibility WHERE resource_kind='mcp' AND resource_id IN (SELECT id FROM mcp_servers WHERE name='web_search')`);
    await tx.query("DELETE FROM mcp_servers WHERE name='web_search'");
    await tx.query(`INSERT INTO settings(key,value) SELECT 'pi_web_access_previous_tools',jsonb_agg(to_jsonb(t))::text FROM tools t WHERE kind='builtin' AND key IN ('web_search','web_read') HAVING count(*)>0 ON CONFLICT(key) DO NOTHING`);
    // Preserve the existing search authorization; new readers inherit web_read's
    // binding when present, so migration cannot widen an explicit restriction.
    for (const name of ['fetch_content', 'get_search_content']) await tx.query(`INSERT INTO tools(key,system,kind,description,schema,agents,enabled)
      SELECT $1,true,'builtin','pi-web-access 网页内容','{}',agents,enabled FROM tools WHERE kind='builtin' AND key IN ('web_read','web_search') ORDER BY (key='web_read') DESC LIMIT 1 ON CONFLICT(key) DO NOTHING`, [name]);
    await tx.query("DELETE FROM tools WHERE kind='builtin' AND key='web_read'");
    await tx.query("UPDATE tools SET description='pi-web-access 网络搜索' WHERE kind='builtin' AND key='web_search' AND description=ANY($1::text[])", [legacyDescriptions]);
    if (!await tx.platform().getSetting(WEB_ACCESS_SETTING)) {
      const legacy = await tx.platform().getSetting('public_reference_sources');
      let previous: {default_source?: string} = {};
      try { previous = legacy ? JSON.parse(legacy) : {}; } catch { /* Require reselection below. */ }
      const changed = !!legacy && previous.default_source !== 'deepseek';
      const config: WebAccessConfig = { sources: ['deepseek','exa'], default_source: 'deepseek', keys: {}, proxy: '', searxng_url: '' };
      await tx.platform().setSetting(WEB_ACCESS_SETTING, JSON.stringify(config));
      if (changed) {
        await tx.platform().setSetting('web_search_enabled', 'false');
        await tx.platform().setSetting('pi_web_access_migration_notice', '旧搜索来源已移除，请选择新的供应商并测试后启用；原有凭证和历史记录保留。');
      }
    }
    await tx.platform().setSetting('pi_web_access_migrated_v1', 'true');
  });
}
