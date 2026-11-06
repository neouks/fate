import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { openDatabase } from "../../db/index.js";
import { registerCompatRoutes } from "./compat.js";

const dsn = process.env.TEST_TASK_FINDINGS_DSN;
const endpoint = "/api/exploration/findings";

test("task finding list, export and detail enforce the same direct task boundary", {
  skip: dsn ? false : "set TEST_TASK_FINDINGS_DSN to an isolated PostgreSQL database",
}, async (t) => {
  assert.ok(dsn);
  assert.match(new URL(dsn).pathname, /^\/test_[a-z0-9_]+$/);
  const oldDSN = process.env.SERIES_PG_DSN;
  process.env.SERIES_PG_DSN = dsn;
  t.after(() => {
    if (oldDSN === undefined) delete process.env.SERIES_PG_DSN;
    else process.env.SERIES_PG_DSN = oldDSN;
  });
  const db = await openDatabase();
  t.after(() => db.close());
  const app = Fastify();
  app.decorate("db", db);
  registerCompatRoutes(app);
  t.after(() => app.close());

  const makeTask = async (name: string) => (await db.query<{ id: string; exploration_id: string }>(
    `WITH exploration AS (INSERT INTO explorations(goal) VALUES ('fixture') RETURNING id)
     INSERT INTO tasks(description,goal,exploration_id) SELECT $1,'fixture',id FROM exploration
     RETURNING id,exploration_id`, [name],
  )).rows[0]!;
  const current = await makeTask("current");
  const source = await makeTask("source");
  const transitive = await makeTask("transitive");
  const unrelated = await makeTask("unrelated");
  const removed = await makeTask("removed");
  await db.query("UPDATE tasks SET deleted_at=now() WHERE id=$1", [removed.id]);
  await db.query(
    "INSERT INTO task_relations(task_id,source_task_id) VALUES ($1,$2),($2,$3),($1,$4)",
    [current.id, source.id, transitive.id, removed.id],
  );
  const makeFinding = async (task: string, severity = "high") => (await db.query<{ id: string }>(
    "INSERT INTO findings(task_id,name,vulnclass,severity,status) VALUES ($1,'scoped fixture','Example',$2,'confirmed') RETURNING id",
    [task, severity],
  )).rows[0]!.id;
  const own = await makeFinding(current.id);
  await makeFinding(current.id, "low");
  const inherited = await makeFinding(source.id);
  const indirect = await makeFinding(transitive.id);
  const foreign = await makeFinding(unrelated.id);
  const deleted = await makeFinding(removed.id);
  const legacy = (await db.query<{ id: string }>(
    `INSERT INTO exploration_nodes(exploration_id,kind,state,payload)
     VALUES ($1,'finding','confirmed','{"name":"scoped legacy","severity":"high","status":"confirmed"}') RETURNING id`,
    [source.exploration_id],
  )).rows[0]!.id;
  const context = `context_task=${current.id}`;
  const filters = `${context}&q=scoped&severity=high&status=confirmed`;
  const list = async (query: string) => {
    const response = await app.inject(`${endpoint}?${query}`);
    assert.equal(response.statusCode, 200, response.body);
    return response.json<{ total: number; items: Array<{ id: string; finding_id?: string; inherited?: boolean }> }>();
  };
  const exported = async (query: string) => {
    const response = await app.inject(`${endpoint}/export?format=csv&${query}`);
    assert.equal(response.statusCode, 200, response.body);
    return response.body.trim().split(/\r?\n/).slice(1).map((row) => row.split(",")[0]);
  };

  const all = await list(filters);
  assert.equal(all.total, 3);
  assert.deepEqual(new Set(all.items.map((item) => item.finding_id ?? `-${item.id}`)), new Set([own, inherited, `-${legacy}`]));
  assert.deepEqual((await list(`${filters}&ownership=current`)).items.map((item) => item.finding_id), [own]);
  assert.equal((await list(`${filters}&ownership=inherited&limit=1`)).total, 2);
  assert.equal((await list(`${context}&q=%25`)).total, 0);
  assert.equal((await list(`${filters}&vulnclass=Example`)).total, 2);
  assert.deepEqual(new Set(await exported(`${filters}&scope=filtered`)), new Set([own, inherited, `-${legacy}`]));
  const ids = [own, inherited, indirect, foreign, deleted].join(",");
  assert.deepEqual(await exported(`${filters}&ownership=inherited&scope=selected&ids=${ids}`), [inherited]);

  const detail = (id: string) => `${endpoint}/${id}?id_kind=record&${context}`;
  assert.equal((await app.inject(detail(inherited))).json().inherited, true);
  assert.equal((await app.inject(detail(foreign))).statusCode, 403);
  assert.equal((await app.inject(detail(deleted))).statusCode, 404);
  assert.equal((await app.inject(`${endpoint}?${context}&legacy_node=${legacy}`)).json().inherited, true);
  assert.equal((await app.inject(`${endpoint}?context_task=${unrelated.id}&legacy_node=${legacy}`)).statusCode, 404);
  assert.equal((await app.inject({ method: "PATCH", url: detail(inherited), payload: { name: "denied" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "DELETE", url: detail(inherited) })).statusCode, 403);
  assert.equal((await app.inject({ method: "PATCH", url: detail(own), payload: { vulnclass: "Updated" } })).json().vulnclass, "Updated");
  assert.equal((await app.inject(`${endpoint}/export?format=csv&scope=all&context_task=bad`)).statusCode, 400);
  assert.equal((await app.inject(`${endpoint}?context_task=${removed.id}`)).statusCode, 404);

  await t.test("completed Worker count is task-scoped and independent of pagination", async () => {
    await db.query(`INSERT INTO exploration_nodes(exploration_id,kind,state)
      VALUES ($1,'intent','done'),($1,'intent','done'),($1,'intent','stopped'),($2,'intent','done')`,
      [current.exploration_id, source.exploration_id]);
    const url = `/api/exploration/intents?task=${current.id}&limit=1`;
    const page = async (before?:string) => {
      const response = await app.inject(before ? `${url}&before=${before}` : url);
      assert.equal(response.statusCode, 200, response.body);
      return response.json<{completed_count:number;has_more:boolean;items:Array<{id:string;state:string}>}>();
    };
    const latest = await page();
    assert.equal(latest.items[0]?.state,"stopped");
    assert.equal(latest.completed_count,2);
    const older = await page(latest.items[0]!.id);
    assert.equal(older.completed_count,2);
    assert.equal(older.items[0]?.state,"done");
    const last = await page(older.items[0]!.id);
    assert.equal(last.completed_count,2);
    assert.equal(last.items[0]?.state,"done");
    assert.equal(last.has_more,false);
  });
});
