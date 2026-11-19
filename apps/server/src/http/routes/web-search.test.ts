import { publicTransport } from '../../search/public-web.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { Database } from '../../db/index.js';
import { registerConfigRoutes } from './config.js';
import { deepseekSearch, searchCredentials, validateSearch } from '../../search/deepseek.js';
import { webSearchTool } from '../../tools/web-search.js';
import { runContext } from '../../tools/context.js';
import { applyToolBindings } from '../../agent/tool-bindings.js';
import { workerTools, mainTools, plannerTools } from '../../tools/index.js';
import { toolLoadout } from '../../agent/tool-loading.js';

function fixture() {
  const settings = new Map<string, string>();
  const agent = { webSearch: true };
  const agents = new Map<string, {webSearch: boolean; enabled?: boolean}>([['worker', agent], ...['planner','mainagent','auto','pentest','reporter'].map(role => [role, {webSearch: false}] as const)]);
  let binding: {key: string; enabled: boolean; agents: string[]} | undefined;
  let profile: any = null;
  const profiles: any[] = [];
  const platform = { getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string) => { settings.set(key, value); },
    getBool: async (key: string, fallback: boolean) => settings.has(key) ? settings.get(key) === 'true' : fallback,
    activeProfile: async () => profile, listProfiles: async () => profiles, profileByID: async (id: number) => profiles.find(p => p.id === id) ?? null, getAgentByKey: async (role: string) => agents.get(role) ?? null };
  const db = { platform: () => platform, query: async (sql: string, args?: any[]) => {
    if (sql.startsWith('UPDATE agents SET web_search')) for(const [role, value] of agents) value.webSearch = args![0].includes(role);
    if (sql.startsWith('INSERT INTO tools')) binding = {key:'web_search', enabled:true, agents:JSON.parse(args![0])};
    return { rows: sql.includes('FROM tools') && binding ? [binding] : [] };
  }, transaction: async (fn: any) => fn(db) } as unknown as Database;
  return { db, settings, agent, profiles, setProfile: (value: any) => { profile = value; } };
}

test('settings, test route and Agent guards use the same official search transport', async () => {
  const f = fixture(), app = Fastify(), originalFetch = globalThis.fetch;
  app.decorate('db', f.db);
  registerConfigRoutes(app);
  const requests: Array<{ url: string; auth: string; body: any }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), auth: new Headers(init?.headers).get('Authorization')!, body: JSON.parse(String(init?.body)) });
    return Response.json({ results: [{ title: 'Official', url: 'https://api-docs.deepseek.com/', summary: '文档摘要', snippet: '摘要', date: null }] });
  };
  try {
    const put = (payload: object) => app.inject({ method: 'PUT', url: '/api/settings/web-search', payload });
    assert.equal((await put({ web_search_enabled: 'true' })).statusCode, 400);
    let response = await put({ web_search_enabled: true, api_key: 'sk-search-fixture' });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().ready, true);
    assert.doesNotMatch(response.body, /sk-search-fixture/);
    await put({ web_search_enabled: true, api_key: '' });
    assert.equal(f.settings.get('deepseek_search_api_key'), 'sk-search-fixture');
    assert.equal((await app.inject('/api/settings/web-search')).json().web_search_enabled, true);
    response = await app.inject({ method: 'POST', url: '/api/settings/web-search/test', payload: { query: '中文搜索' } });
    assert.equal(response.json().ok, true);
    assert.equal(response.json().count, 1);
    assert.equal(requests[0]!.url, 'https://api.deepseek.com/v1/tools/search');
    assert.equal(requests[0]!.auth, 'Bearer sk-search-fixture');
    assert.deepEqual(requests[0]!.body, { query: '中文搜索', count: 3, need_content: false });
    const ctx = runContext(f.db, 1, 1, 'worker'), tool = webSearchTool(ctx);
    assert.ok(workerTools(ctx).some(t => t.name === 'web_search'));
    assert.ok(mainTools(ctx).some(t => t.name === 'web_search'));
    assert.ok(plannerTools(ctx).some(t => t.name === 'web_search'));
    assert.equal((await applyToolBindings(f.db, 'worker', [tool])).length, 1);
    const success = await tool.execute('search-1', { query: '查询', count: 2 });
    assert.ok(!success.isError);
    assert.match(JSON.stringify(success), /文档摘要/);
    assert.equal(requests.length, 2);
    f.agent.webSearch = false;
    assert.equal((await applyToolBindings(f.db, 'worker', [tool])).length, 0);
    assert.equal((await tool.execute('search-2', { query: '查询' })).isError, true);
    f.agent.webSearch = true;
    await put({ web_search_enabled: false });
    assert.equal((await tool.execute('search-3', { query: '查询' })).isError, true);
    assert.equal(requests.length, 2);
    await put({ web_search_enabled: false, clear_key: true });
    assert.equal((await app.inject('/api/settings/web-search')).json().ready, false);
  } finally { globalThis.fetch = originalFetch; await app.close(); }
});

test('saving selected roles synchronizes Agent flags and bindings and exposes search immediately to PI', async () => {
  const f=fixture(), app=Fastify();app.decorate('db', f.db);registerConfigRoutes(app);
  try {
    const save=(payload:object)=>app.inject({method:'PUT',url:'/api/settings/web-search',payload});
    assert.equal((await save({web_search_enabled:true,agent_roles:['goals']})).statusCode,400);
    const saved=await save({web_search_enabled:true,api_key:'fixture-key',agent_roles:['worker','planner','mainagent']});
    assert.equal(saved.statusCode,200);
    assert.deepEqual(saved.json().effective_agent_roles,['worker','planner','mainagent']);
    for(const role of ['worker','planner','mainagent']) {
      const tool=webSearchTool(runContext(f.db,1,1,role as 'worker'));
      const bound=await applyToolBindings(f.db,role,[tool]);
      const options=toolLoadout(role,{customTools:bound,toolAllowlist:bound.map(t=>t.name)});
      assert.deepEqual(options.toolLoading.initialActive,[]);
      assert.deepEqual(options.toolLoading.deferred,['web_search']);
      assert.match(options.customTools[0]!.description,/需要最新信息/);
    }
    await save({web_search_enabled:true,agent_roles:['planner']});
    assert.equal((await applyToolBindings(f.db,'worker',[webSearchTool(runContext(f.db,1,1,'worker'))])).length,0);
    assert.deepEqual((await app.inject('/api/settings/web-search')).json().effective_agent_roles,['planner']);
    // Agent settings can re-enable a role later without a hidden missing binding.
    f.agent.webSearch = true;
    assert.equal((await applyToolBindings(f.db,'worker',[webSearchTool(runContext(f.db,1,1,'worker'))])).length,1);
    await save({web_search_enabled:false});
    assert.deepEqual((await app.inject('/api/settings/web-search')).json().effective_agent_roles,[]);
  } finally {await app.close();}
});

test('credential fallback uses official profiles and validates Unicode queries', async () => {
  const f = fixture();
  f.setProfile({ apiKey: 'secret', baseURL: 'https://other.example/v1', name: 'third-party' });
  assert.equal(await searchCredentials(f.db), null);
  f.profiles.push({ id: 1, apiKey: 'official-key', baseURL: 'https://api.deepseek.com/', name: 'Official' });
  assert.equal((await searchCredentials(f.db))?.key, 'official-key');
  assert.match((await searchCredentials(f.db))!.source, /Official/);

  f.setProfile({ apiKey: 'secret', baseURL: 'https://api.deepseek.com/anthropic', name: 'DeepSeek', proxy: '' });
  assert.equal((await searchCredentials(f.db))?.key, 'secret');
  assert.equal(validateSearch({ query: '😀'.repeat(128) }).query.length, 256);
  for (const query of ['', ' ', 'a'.repeat(129)]) assert.throws(() => validateSearch({ query }));
  for (const count of [0, 51, 1.5]) assert.throws(() => validateSearch({ query: 'test', count }));
});

test('empty results succeed while upstream failures, malformed data and cancellation are explicit', async () => {
  const f = fixture(), originalFetch = globalThis.fetch;
  f.settings.set('deepseek_search_api_key', 'sk-fixture');
  try {
    globalThis.fetch = async () => Response.json({ results: [] });
    assert.equal((await deepseekSearch(f.db, { query: 'test' })).count, 0);
    globalThis.fetch = async () => Response.json({ error: 'sk-fixture' }, { status: 401 });
    await assert.rejects(deepseekSearch(f.db, { query: 'test' }), /API Key 无效/);
    globalThis.fetch = async () => Response.json({ result: [] });
    await assert.rejects(deepseekSearch(f.db, { query: 'test' }), /缺少结果列表/);
    globalThis.fetch = async () => { throw new Error('proxy://user:password@host sk-fixture'); };
    await assert.rejects(deepseekSearch(f.db, { query: 'test' }), error => !String(error).includes('password') && !String(error).includes('sk-fixture'));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(deepseekSearch(f.db, { query: 'test' }, { signal: controller.signal }), /已取消/);
  } finally { globalThis.fetch = originalFetch; }
});

test('manual scoped references work while reporter search stays revoked', async t => {
  const f = fixture(), app = Fastify();
  app.decorate('db', f.db);
  registerConfigRoutes(app);
  t.after(() => app.close());
  const save = (body: object) => app.inject({method: 'PUT', url: '/api/settings/web-search', payload: {web_search_enabled: true, ...body}});
  assert.equal((await save({sources:['cnblogs'], default_source:'cnblogs'})).statusCode, 400);
  assert.equal((await save({agent_roles:['reporter']})).statusCode,400);
  const saved = await save({sources:['bing','cnblogs'], default_source:'cnblogs', agent_roles:[]});
  assert.equal(saved.json().ready, true);
  assert.deepEqual(saved.json().effective_agent_roles, []);
  await save({api_key:''});
  assert.equal((await app.inject('/api/settings/web-search')).json().default_source, 'cnblogs');
  const data = ['https://www.cnblogs.com/demo/p/3.html', 'https://www.cnblogs.com/demo/p/3.html?utm_source=test#top',
    'https://cnblogs.com.evil.example/u/p/5','https://www.cnblogs.com/login','javascript:bad'];
  let requests = 0;
  t.mock.method(publicTransport,'fetch',async (url:URL, init:RequestInit) => {
    requests++;
    assert.match(url.searchParams.get('q')!, /site:cnblogs\.com/);
    assert.equal(new Headers(init.headers).has('authorization'), false);
    return new Response('<rss><channel>'+data.map(link=>'<item><title>组件维护说明</title><link>'+link+'</link></item>').join('')+'</channel></rss>');
  });
  const args = {query:'Tomcat 9 维护'};
  const manual = await app.inject({method:'POST',url:'/api/settings/web-search/test',payload:args});
  assert.deepEqual(manual.json().results.map((r: {engine:string;source:string}) => [r.engine,r.source]), [['bing','cnblogs']]);
  assert.doesNotMatch(manual.body, /evil\.example|utm_source|javascript:bad/);
  // Simulate a legacy installation with both the old binding and the role flag.
  await f.db.query('INSERT INTO tools', [JSON.stringify(['reporter'])]);
  await f.db.query('UPDATE agents SET web_search', [['reporter']]);
  const tool = webSearchTool(runContext(f.db,0,0,'reporter',{conversationID:42}));
  assert.deepEqual(await applyToolBindings(f.db,'reporter',[tool]),[]);
  assert.ok((await tool.execute('already-loaded',args)).isError);
  assert.equal(requests, 1);
});

test('all three execution roles share multi-source search while reporter cannot load either tool',async t=>{
 const f=fixture();f.settings.set('web_search_enabled','true');
 f.settings.set('public_reference_sources',JSON.stringify({sources:['github'],default_source:'github'}));
 let requests=0;
 t.mock.method(publicTransport,'fetch',async()=>{requests++;return Response.json({items:[{full_name:'golang/go',html_url:'https://github.com/golang/go',description:'The Go programming language'}]});});
 for(const role of ['worker','planner','mainagent'] as const){
  (await f.db.platform().getAgentByKey(role))!.webSearch=true;
  const ctx=runContext(f.db,0,0,role);
  const tool=webSearchTool(ctx);
  const out=await tool.execute(role,{query:'repo:golang/go',source:'github',count:1});
  assert.ok(!out.isError,JSON.stringify(out));
  await tool.execute(role+'-again',{query:'repo:golang/go',source:'github',count:1});
 }
 assert.equal(requests,3);
});
