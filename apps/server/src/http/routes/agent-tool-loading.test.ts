import assert from 'node:assert/strict';
import {test} from 'node:test';
import Fastify from 'fastify';
import {openDatabase} from '../../db/index.js';
import {registerAgentConfigRoutes} from './agents-config.js';
import {registerAgentManagementRoutes} from './agents-management.js';
import {readToolLoadingOverrides} from '../../agent/tool-loading-preferences.js';

const dsn=process.env.TEST_AGENT_TOOL_LOADING_DSN;
test('per-agent loading API persists independently, rejects invalid configs and preserves binding guards', {skip:!dsn&&'isolated PostgreSQL required'}, async()=>{
  assert.match(new URL(dsn!).pathname,/^\/test_agent_tool_loading_[a-z0-9_]+$/);
  process.env.SERIES_PG_DSN=dsn;
  const db=await openDatabase(),app=Fastify();app.decorate('db',db);registerAgentConfigRoutes(app);registerAgentManagementRoutes(app);
  const get=(role='worker')=>app.inject(`/api/agents/${role}/tool-loading`);
  const put=(overrides:unknown,role='worker')=>app.inject({method:'PUT',url:`/api/agents/${role}/tool-loading`,payload:{overrides}});
  try{
    const initial=await get();assert.equal(initial.statusCode,200,initial.body);assert.deepEqual(initial.json().overrides,{});
    const saved=await put({asset_get:'resident',context_get:'deferred'});assert.equal(saved.statusCode,200,saved.body);
    assert(saved.json().resident.includes('asset_get'));assert(saved.json().deferred.includes('context_get'));
    assert.deepEqual(await readToolLoadingOverrides(db,'worker'),{asset_get:'resident',context_get:'deferred'});
    assert.deepEqual((await get('planner')).json().overrides,{});
    assert(!(await get('planner')).json().editable_tools.includes('bash'));
    for(const role of ['planner','mainagent','goals','auto','pentest','reporter']){
      const response=await put({context_get:'resident'},role);assert.equal(response.statusCode,200,response.body);
      assert.deepEqual((await get(role)).json().overrides,{context_get:'resident'});
    }
    for(const config of [null,[],{asset_get:'invalid'},{invented_tool:'resident'},{tool_search:'deferred'},{node_detail:'deferred'},{'mcp__x__read':'resident'},JSON.parse('{"__proto__":"resident"}')])
      assert.equal((await put(config)).statusCode,400,JSON.stringify(config));
    assert.equal((await put({bash:'resident'},'planner')).statusCode,400);
    assert.equal((await get('missing-agent')).statusCode,404);
    await db.query("UPDATE tools SET enabled=false WHERE key='asset_get'");
    const disabled=await get();assert(!disabled.json().resident.includes('asset_get'));assert(!disabled.json().deferred.includes('asset_get'));
    assert.equal(disabled.json().overrides.asset_get,'resident','disabled binding must not erase the saved preference');
    await db.query("UPDATE tools SET enabled=true,agents=agents-'worker' WHERE key='asset_get'");
    assert(!(await get()).json().resident.includes('asset_get'));
    await db.query("UPDATE tools SET enabled=false WHERE key='tool_search'");
    assert.equal((await put({context_get:'deferred'})).statusCode,400);
    const fallback=await get();assert.equal(fallback.statusCode,200);assert.equal(fallback.json().deferred.length,0);assert(fallback.json().fallback);
    const reset=await put({});assert.equal(reset.statusCode,200,reset.body);assert.deepEqual(reset.json().overrides,{});
    assert.deepEqual((await get('planner')).json().overrides,{context_get:'resident'},'reset is role-scoped');
    const created=await app.inject({method:'POST',url:'/api/agents',payload:{key:'loading_fixture',name:'Fixture'}});assert.equal(created.statusCode,201,created.body);
    assert.equal((await put({context_get:'resident'},'loading_fixture')).statusCode,200);
    assert.equal((await app.inject({method:'DELETE',url:'/api/agents/loading_fixture'})).statusCode,200);
    assert.deepEqual(await readToolLoadingOverrides(db,'loading_fixture'),{},'deletion clears only this agent loading preferences');
  }finally{await app.close();await db.close();}
});
