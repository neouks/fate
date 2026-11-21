import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openDatabase} from './index.js';
import {migrateWebAccess} from './web-access-migration.js';
const dsn=process.env.TEST_WEB_ACCESS_DSN;
test('replacement deletes old MCP bindings/cache, preserves grants and does not resurrect on restart',{skip:!dsn&&'isolated PostgreSQL required'},async()=>{
 assert.match(new URL(dsn!).pathname,/^\/test_/);process.env.SERIES_PG_DSN=dsn;let db=await openDatabase();
 try{
  assert.equal((await db.platform().listMCP()).some(s=>s.name==='web_search'),false);
  await db.query("DELETE FROM settings WHERE key IN ('pi_web_access_migrated_v1','pi_web_access_config_v1')");
  await db.platform().setSetting('public_reference_sources',JSON.stringify({sources:['baidu'],default_source:'baidu'}));
  const old=Number((await db.query(`INSERT INTO mcp_servers(name,transport,command,args) VALUES('web_search','stdio','npx','["-y","@zhafron/mcp-web-search"]') RETURNING id`)).rows[0]!.id);
  const agent=Number((await db.query("SELECT id FROM agents WHERE key='worker'")).rows[0]!.id);
  await db.query("INSERT INTO agent_visibility(agent_id,resource_kind,resource_id,enabled) VALUES($1,'mcp',$2,true)",[agent,old]);
  await db.query("INSERT INTO mcp_tools_cache(server_id,tool_name,description,schema) VALUES($1,'search','legacy','{}')",[old]);
  await db.query("DELETE FROM tools WHERE key IN ('fetch_content','get_search_content')");
  await db.query(`INSERT INTO tools(key,system,kind,description,schema,agents,enabled) VALUES('web_read',true,'builtin','old','{}','["worker"]',false) ON CONFLICT(key) DO UPDATE SET enabled=false,agents='["worker"]'`);
  await migrateWebAccess(db);
  assert.equal((await db.query('SELECT id FROM mcp_servers WHERE id=$1',[old])).rowCount,0);
  assert.equal((await db.query('SELECT id FROM mcp_tools_cache WHERE server_id=$1',[old])).rowCount,0);
  assert.equal((await db.query("SELECT * FROM agent_visibility WHERE resource_kind='mcp' AND resource_id=$1",[old])).rowCount,0);
  assert.equal((await db.query("SELECT key FROM tools WHERE key='web_read'")).rowCount,0);
  const readers=(await db.query("SELECT enabled,agents FROM tools WHERE key IN ('fetch_content','get_search_content')")).rows;assert.equal(readers.length,2);assert(readers.every(r=>r.enabled===false));
  assert.equal(await db.platform().getSetting('web_search_enabled'),'false');
  await db.close();db=await openDatabase();assert.equal((await db.platform().listMCP()).some(s=>s.name==='web_search'),false);
  assert.equal((await db.query("SELECT key FROM tools WHERE key='web_read'")).rowCount,0);
 }finally{await db.close();}
});
