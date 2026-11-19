import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { Database, openDatabase } from "./index.js";
import { registerCompatRoutes } from "../http/routes/compat.js";
import { registerTaskRoutes } from "../http/routes/tasks.js";

const dsn = process.env.TEST_PROFILES_DSN;
test("read-only task profiles preserve socket, host and worker boundaries", { skip: !dsn }, async t => {
  assert.match(new URL(dsn!).pathname, /^\/test_[a-z0-9_]+$/);
  process.env.SERIES_PG_DSN = dsn;
  const pool = await openDatabase();
  const client = await pool.pool.connect();
  const db = new Database(pool.pool, client);
  const app = Fastify();
  app.decorate("db", db);
  registerTaskRoutes(app); // No engine or model provider is registered.
  registerCompatRoutes(app);
  t.after(async () => { await app.close(); await client.query("ROLLBACK"); client.release(); await pool.close(); });
  await client.query("BEGIN");
  async function id(sql: string, args: unknown[]) {
    return String((await db.query(sql + " RETURNING id", args)).rows[0]!.id);
  }
  async function task() {
    const exp = await db.createExploration("fixture", "inventory");
    return { exp, id: await id("INSERT INTO tasks(exploration_id,description,goal) VALUES($1,'fixture','inventory')", [exp]) };
  }
  const current = await task(), other = await task();
  const host = "192.0.2.10";
  const ip = await id(`INSERT INTO assets(type,ip,open_ports) VALUES('ip',$1,
    ARRAY['{"port":443,"service":"https"}','{"port":80}','{"port":"bad"}']::jsonb[])`, [host]);
  async function service(domain: string, ip: string | null, status: number, extra: object = {}) {
    return id(`INSERT INTO assets(type,domain,ip,port,service_type,url,status_code,technologies,extra)
      VALUES('service',$1,$2,443,'http','https://'||$1,$3,ARRAY[$1::text],$4)`, [domain,ip,status,extra]);
  }
  const stamp = "2026-01-10T10:00:00Z";
  const first = await service("a.example",host,403);
  const second = await service("b.example",host,429,{ waf:{ detected:false,observed_at:stamp },
    source_ip_block:{ detected:true,source_ip:"198.51.100.9",observed_at:stamp } });
  const unknown = await service("unresolved.example",null,200);
  const ipv6 = await service("[2001:0db8::1]",null,200);
  const foreign = await service("private.example","192.0.2.20",200);
  await db.query("INSERT INTO task_asset_links(task_id,asset_id) SELECT $1,unnest($2::bigint[])", [current.id,[ip,first,second,unknown,ipv6]]);
  await db.query("INSERT INTO task_asset_links(task_id,asset_id) VALUES($1,$2)", [other.id,foreign]);
  async function check(exp: number, asset: string) {
    const intent = await id("INSERT INTO exploration_nodes(exploration_id,kind,state,payload) VALUES($1,'intent','paused',$2)", [exp,{summary:"核查记录"}]);
    await db.query("INSERT INTO exploration_anchors(node_id,asset_id) VALUES($1,$2)", [intent,asset]);
    return intent;
  }
  const intent = await check(current.exp,first);
  const earlier = await id("INSERT INTO activity(exploration_id,node_id,worker,kind) VALUES($1,$2,'worker','text')", [current.exp,intent]);
  const activity = await id("INSERT INTO activity(exploration_id,node_id,worker,kind) VALUES($1,$2,'worker','text')", [current.exp,intent]);

  const url = `/api/tasks/${current.id}/profiles`;
  async function read(query: string) {
    const response = await app.inject(url + query);
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  }
  const before = await read("?limit=2");
  async function message(exp:number,worker:string,kind:string,body:string,meta:object,node:string|null=null) {
    return id("INSERT INTO activity(exploration_id,node_id,worker,kind,summary,detail,metadata) VALUES($1,$2,$3,$4,$5,$5,$6)",
      [exp,node,worker,kind,body,meta]);
  }
  const user = await message(current.exp,"main","user","中间件 **InforSuiteAS V10.0.5.3.9**，数据库为 Kingbase",{});
  const pending = await read("?limit=2&revision="+before.revision);
  assert.deepEqual(pending.components.map((c:{asset_id:string|null})=>c.asset_id),[null,null]);
  const fact = await id("INSERT INTO exploration_nodes(exploration_id,kind,state,payload) VALUES($1,'fact','confirmed',$2)",
    [current.exp,{summary:"后端为 Kingbase 数据库、InforSuiteAS 中间件",observation_type:"observed"}]);
  await db.query("INSERT INTO exploration_anchors(node_id,asset_id) VALUES($1,$2)",[fact,first]);
  await message(current.exp,"planner","text","框架为 NovelSuite",{turn_id:"plan-test",final_answer:true});
  await message(current.exp,"planner","result","完成",{turn_id:"plan-test",event_type:"lifecycle",status:"completed"});
  const worker = await message(current.exp,"worker","result","组件为 ExampleWorker",{event_type:"outcome",status:"done"},intent);
  await message(current.exp,"planner","text","数据库为 PartialDB",{turn_id:"incomplete",final_answer:true});
  await message(other.exp,"main","user","数据库为 OtherTaskDB",{});
  await client.query("SET TRANSACTION READ ONLY");
  const page = await read("?limit=2");
  assert.equal(page.total,3);
  assert.deepEqual(await read("?limit=2&revision="+page.revision),{unchanged:true,revision:page.revision});
  assert.notEqual(pending.revision,page.revision);
  assert.deepEqual(page.components.map((c:{name:string})=>c.name).sort(),["ExampleWorker","InforSuiteAS","Kingbase","NovelSuite"]);
  for(const name of ["InforSuiteAS","Kingbase"]) {
    const c=page.components.find((c:{name:string})=>c.name===name);
    assert.equal(c.asset_id,first);
    assert.equal(c.version,name==="InforSuiteAS"?"V10.0.5.3.9":"");
    assert.deepEqual(c.sources.map((s:{id:string})=>s.id).sort(),[user,fact].sort());
  }
  assert.deepEqual(page.items.map((p: {port:number}) => p.port),[80,443]);
  const profile = page.items[1];
  assert.equal(profile.ip,host);
  const byHost = (name: string) => profile.observations.find((o: {domain:string}) => o.domain === name);
  assert.deepEqual(byHost("a.example").technologies,["a.example"]);
  assert.equal(byHost("a.example").status_code,403);
  assert.equal(byHost("b.example").status_code,429);
  assert.equal(byHost("a.example").waf,null);
  assert.equal(byHost("a.example").source_ip_block,null);
  assert.equal(byHost("b.example").waf.detected,false);
  assert.equal(byHost("b.example").source_ip_block.source_ip,"198.51.100.9");
  const history = `/api/exploration/activity/history?task=${current.id}&session=intent:${intent}`;
  const original = await app.inject(history + "&limit=1&around=" + earlier);
  assert.equal(original.statusCode, 200, original.body);
  assert.equal(String(original.json().items[0].seq), earlier);
  assert.equal(original.json().has_newer, true);
  assert.equal(String((await app.inject(history + "&limit=1&after=" + earlier)).json().items[0].seq),activity);
  assert.deepEqual((await app.inject(history + "&after=" + worker)).json().items, []);
  assert.equal((await read("?limit=2&page=2")).items[0].ip,"2001:db8::1");
  assert.deepEqual((await read("?page=7")).items,[]);
  assert.equal((await app.inject(url+"?page=1.5")).statusCode,400);
  assert.equal((await app.inject("/api/tasks/2147483640/profiles")).statusCode,404);
});
