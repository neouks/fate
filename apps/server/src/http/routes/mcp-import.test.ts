import assert from 'node:assert/strict';
import {test} from 'node:test';
import Fastify from 'fastify';
import {openDatabase} from '../../db/index.js';
import {requireJWT,signJWT} from '../auth.js';
import {registerMcpMgmtRoutes} from './mcp-mgmt.js';

const dsn=process.env.TEST_MANAGEMENT_CONTRACTS_DSN;
test('MCP 批量导入契约', {skip:dsn?false:'requires isolated TEST_MANAGEMENT_CONTRACTS_DSN'},async t=>{
  assert.ok(dsn);assert.match(new URL(dsn).pathname,/^\/test_[a-z0-9_]+$/);
  process.env.SERIES_PG_DSN=dsn;
  const db=await openDatabase();t.after(()=>db.close());
  const app=Fastify();app.decorate('db',db);
  const secret='local-management-fixture-secret';
  app.addHook('preHandler',requireJWT(secret));
  registerMcpMgmtRoutes(app);t.after(()=>app.close());
  const headers={'x-series-token':signJWT(secret)};
  const importServers=(servers:unknown)=>app.inject({method:'POST',url:'/api/mcp/import',headers,payload:{servers}});
  const server=(name:string)=>({name,transport:'stdio',command:'/definitely/not/executed',args:[],env:{},enabled:false});

  await t.test('未登录不能导入 MCP',async()=>{assert.equal((await app.inject({method:'POST',url:'/api/mcp/import',payload:{servers:[]}})).statusCode,401);});
  await t.test('批量导入保存 stdio/http/sse 配置，无需启动命令或连接服务器',async()=>{
    const r=await importServers([server('fixture_stdio'),{name:'fixture_http',transport:'http',url:'http://127.0.0.1:1/mcp',headers:{Authorization:'synthetic'},enabled:false},{name:'fixture_sse',transport:'sse',url:'http://127.0.0.1:1/sse',enabled:false}]);
    assert.equal(r.statusCode,200,r.body);assert.equal(r.json().results.length,3);
    assert.ok(r.json().results.every((x:{action:string})=>x.action==='created'));
    assert.deepEqual((await db.query("SELECT env FROM mcp_servers WHERE name='fixture_http'")).rows[0]?.env,{Authorization:'synthetic'});
  });
  await t.test('同名导入保持 ID、绑定和 TLS 设置，清理过期工具缓存',async()=>{
    const original=(await db.query("SELECT id FROM mcp_servers WHERE name='fixture_http'")).rows[0]!.id;
    await db.query('UPDATE mcp_servers SET insecure=true WHERE id=$1',[original]);
    const agent=(await db.query("SELECT id FROM agents WHERE key='worker'")).rows[0]!.id;
    await db.query("INSERT INTO agent_visibility(agent_id,resource_kind,resource_id,enabled) VALUES($1,'mcp',$2,false)",[agent,original]);
    await db.query("INSERT INTO mcp_tools_cache(server_id,tool_name,schema) VALUES($1,'stale','{}')",[original]);
    const r=await importServers([{name:'fixture_http',transport:'http',url:'http://127.0.0.1:2/mcp',enabled:false}]);
    assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json().results,[{id:Number(original),name:'fixture_http',action:'updated'}]);
    assert.equal((await db.query('SELECT insecure FROM mcp_servers WHERE id=$1',[original])).rows[0]?.insecure,true);
    assert.equal((await db.query("SELECT enabled FROM agent_visibility WHERE agent_id=$1 AND resource_kind='mcp' AND resource_id=$2",[agent,original])).rows[0]?.enabled,false);
    assert.equal((await db.query('SELECT 1 FROM mcp_tools_cache WHERE server_id=$1',[original])).rowCount,0);
  });
  await t.test('非法批次不产生部分保存，重复名称与空批次明确拒绝',async()=>{
    for(const list of [[],[server('invalid_batch'),{name:'missing_command',transport:'stdio'}],[server('same'),server('same')],Array.from({length:101},(_,i)=>server('batch_'+i))]){
      const r=await importServers(list);assert.equal(r.statusCode,400,r.body);
    }
    assert.equal((await db.query("SELECT 1 FROM mcp_servers WHERE name='invalid_batch'")).rowCount,0);
  });
  await t.test('重叠批次并发导入不会重复创建或因反向顺序死锁',async()=>{
    const rs=await Promise.all([importServers([server('parallel_a'),server('parallel_b')]),importServers([server('parallel_b'),server('parallel_a')])]);
    for(const r of rs)assert.equal(r.statusCode,200,r.body);
    assert.equal((await db.query("SELECT 1 FROM mcp_servers WHERE name IN ('parallel_a','parallel_b')")).rowCount,2);
  });
  await t.test('中途数据库失败回滚整个导入批次',async()=>{
    await db.query("ALTER TABLE mcp_servers ADD CONSTRAINT synthetic_import_failure CHECK(name<>'zz_rejected')");
    try{
      const r=await importServers([server('aa_rollback'),server('zz_rejected')]);assert.equal(r.statusCode,500);
      assert.equal((await db.query("SELECT 1 FROM mcp_servers WHERE name='aa_rollback'")).rowCount,0);
    }finally{await db.query('ALTER TABLE mcp_servers DROP CONSTRAINT synthetic_import_failure');}
  });
});
