import assert from 'node:assert/strict';
import {test} from 'node:test';
import Fastify from 'fastify';
import {openDatabase} from '../../db/index.js';
import {registerAgentManagementRoutes} from './agents-management.js';
import {registerAgentConfigRoutes} from './agents-config.js';
import {registerConversationRoutes} from './conversations.js';
import {ConversationService} from '../../engine/conversations.js';

const dsn=process.env.TEST_AGENT_MANAGEMENT_DSN;
test('Agent management HTTP and conversation lifecycle', {skip:dsn?false:'requires isolated TEST_AGENT_MANAGEMENT_DSN'},async t=>{
  assert.ok(dsn);assert.match(new URL(dsn).pathname,/^\/test_[a-z0-9_]+$/);
  process.env.SERIES_PG_DSN=dsn;
  const db=await openDatabase();t.after(()=>db.close());
  const app=Fastify();app.decorate('db',db);
  const service=new ConversationService(db,async()=>{throw new Error('No model calls allowed');},'/tmp/unused-agent-management',{} as never);
  app.decorate('engine',{conversations:service});
  registerAgentManagementRoutes(app);registerAgentConfigRoutes(app);registerConversationRoutes(app);
  t.after(()=>app.close());
  const create=(key:string)=>app.inject({method:'POST',url:'/api/agents',payload:{key,name:'合成助手',description:'仅验证管理接口'}});
  const remove=(key:string)=>app.inject({method:'DELETE',url:'/api/agents/'+key});
  const send=(id:number)=>db.transaction(tx=>service.enqueue(id,'synthetic only',[],'fixture-'+Math.random(),tx));

  await t.test('key validation and concurrent uniqueness return 400/409 instead of 500',async()=>{
    for(const key of ['1bad','bad-key','UPPER','x'.repeat(65),''])assert.equal((await create(key)).statusCode,400,key);
    const rs=await Promise.all([create('fixture_agent'),create('fixture_agent')]);
    assert.deepEqual(rs.map(r=>r.statusCode).sort(),[201,409]);
  });
  await t.test('metadata update, config reload and detail shape preserve persisted settings',async()=>{
    let r=await app.inject({method:'PATCH',url:'/api/agents/fixture_agent',payload:{name:'已更名',description:'新描述'}});assert.equal(r.statusCode,200,r.body);
    r=await app.inject({method:'PUT',url:'/api/agents/fixture_agent/config',payload:{max_turns:17,run_seconds:234,interactive_shell:false}});assert.equal(r.statusCode,200,r.body);
    r=await app.inject('/api/agents/fixture_agent');assert.equal(r.statusCode,200,r.body);
    assert.equal(r.json().agent.name,'已更名');assert.equal(r.json().agent.max_turns,17);assert.equal(r.json().agent.run_seconds,234);assert.equal(r.json().agent.interactive_shell,false);
    assert.ok(Array.isArray(r.json().llm_profiles));assert.deepEqual(r.json().visibility,{mcp:[],skill:[]});
    assert.equal((await app.inject({method:'PATCH',url:'/api/agents/missing',payload:{name:'x'}})).statusCode,404);
    assert.equal((await app.inject({method:'PATCH',url:'/api/agents/fixture_agent',payload:{name:''}})).statusCode,400);
  });
  await t.test('concurrent prompt saves preserve versions and history/variables routes work',async()=>{
    const responses=await Promise.all(['one','two'].map(template=>app.inject({method:'PUT',url:'/api/agents/fixture_agent/prompt',payload:{template}})));
    for(const r of responses)assert.equal(r.statusCode,200,r.body);
    assert.equal(new Set(responses.map(r=>r.json().version)).size,2);
    const history=(await app.inject('/api/agents/fixture_agent/prompts')).json().versions;
    assert.equal(history.length,2);assert.ok(history[0].template_text);assert.ok(history[0].ts);
    assert.deepEqual((await app.inject('/api/agents/fixture_agent')).json().versions,history);
    assert.deepEqual((await app.inject('/api/agents/fixture_agent/variables')).json(),{variables:[]});
  });
  await t.test('disabled or removed identities cannot silently queue work',async()=>{
    await create('disabled_fixture');const c=await service.create('disabled_fixture');
    await db.query("UPDATE agents SET enabled=false WHERE key='disabled_fixture'");
    await assert.rejects(send(Number(c.id)),{statusCode:409});
    assert.equal((await db.query('SELECT 1 FROM conversation_runs WHERE conversation_id=$1',[c.id])).rowCount,0);
    assert.equal((await app.inject('/api/conversations')).json().conversations.find((r:{id:number})=>r.id===Number(c.id)).read_only,true);
  });
  await t.test('queued/running work and unexpired session leases prevent deletion',async()=>{
    await create('busy_fixture');const c=await service.create('busy_fixture');await send(Number(c.id));
    assert.equal((await remove('busy_fixture')).statusCode,409);
    await db.query("UPDATE conversation_runs SET status='running' WHERE conversation_id=$1",[c.id]);
    assert.equal((await remove('busy_fixture')).statusCode,409);
    await db.query("UPDATE conversation_runs SET status='stopped' WHERE conversation_id=$1",[c.id]);
    // A claimed executor can outlive its run's terminal update.
    await db.query("INSERT INTO runtime_session_leases(key,token,expires_at) VALUES($1,'fixture',now()+interval '1 minute')",['conversation:'+c.id]);
    assert.equal((await remove('busy_fixture')).statusCode,409);
    await db.query('DELETE FROM runtime_session_leases WHERE key=$1',['conversation:'+c.id]);
    assert.equal((await remove('busy_fixture')).statusCode,200);
  });
  await t.test('delete clears configuration bindings, preserves read-only history and reserves historical key',async()=>{
    const a=await db.platform().getAgentByKey('fixture_agent');assert.ok(a);
    const c=await service.create(a.key);
    await db.query("INSERT INTO agent_skill_visibility(agent_id,skill_name,enabled) VALUES($1,'synthetic',true)",[a.id]);
    await db.query("INSERT INTO tools(key,agents) VALUES('synthetic_binding','[\"fixture_agent\",\"worker\"]')");
    const trigger=await app.inject({method:'POST',url:'/api/agents/fixture_agent/triggers',payload:{enabled:false,on_finding:true}});assert.equal(trigger.statusCode,201,trigger.body);
    const list=(await app.inject('/api/agents')).json().agents.find((r:{key:string})=>r.key===a.key);assert.equal(list.skill_count,1);assert.equal(list.tool_count,1);
    const r=await remove(a.key);assert.equal(r.statusCode,200,r.body);
    for(const table of ['agent_prompts','agent_prompt_vars','agent_visibility','agent_skill_visibility'])assert.equal((await db.query(`SELECT 1 FROM ${table} WHERE agent_id=$1`,[a.id])).rowCount,0);
    assert.equal((await db.query('SELECT 1 FROM agent_triggers WHERE agent_key=$1',[a.key])).rowCount,0);
    assert.deepEqual((await db.query("SELECT agents FROM tools WHERE key='synthetic_binding'")).rows[0]!.agents,['worker']);
    assert.equal((await db.query('SELECT 1 FROM conversations WHERE id=$1',[c.id])).rowCount,1);
    assert.equal((await app.inject('/api/conversations')).json().conversations.find((r:{id:number})=>r.id===Number(c.id)).read_only,true);
    await assert.rejects(send(Number(c.id)),{statusCode:410});
    assert.equal((await create(a.key)).statusCode,409);
    assert.equal((await remove(a.key)).statusCode,404);
  });
  await t.test('builtin protection and deleted trigger creation are explicit',async()=>{
    assert.equal((await remove('worker')).statusCode,409);
    assert.equal((await remove('reporter')).statusCode,409);
    assert.equal((await app.inject({method:'POST',url:'/api/agents/fixture_agent/triggers',payload:{enabled:true}})).statusCode,404);
  });
  await t.test('delete versus message admission never leaves work queued for a deleted Agent',async()=>{
    for(let i=0;i<6;i++){
      const key='race_fixture_'+i;await create(key);const c=await service.create(key);
      const results=await Promise.allSettled([remove(key),send(Number(c.id))]);
      const exists=!!await db.platform().getAgentByKey(key);
      const pending=(await db.query("SELECT 1 FROM conversation_runs WHERE conversation_id=$1 AND status IN ('queued','running')",[c.id])).rowCount;
      assert.ok(exists||!pending,JSON.stringify(results));
      if(exists){await db.query("UPDATE conversation_runs SET status='stopped' WHERE conversation_id=$1",[c.id]);assert.equal((await remove(key)).statusCode,200);}
    }
  });
});
