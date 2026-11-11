import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase } from "../../db/index.js";
import { buildApp } from "../app.js";
import { signJWT } from "../auth.js";

const databaseURL = process.env.TEST_TASK_FINDINGS_DSN;
const path = "/api/task-templates";

test("task templates persist independently and enforce authentication and validation", {
  skip: !databaseURL && "requires isolated PostgreSQL",
}, async (t) => {
  assert.match(new URL(databaseURL!).pathname, /^\/test_[a-z0-9_]+$/);
  process.env.SERIES_PG_DSN = databaseURL;
  const db = await openDatabase();
  const dataDir = await mkdtemp(join(tmpdir(), "fate-task-templates-"));
  const jwtKey = "local-task-templates-fixture";
  const app = buildApp({ db, dataDir, skillsRoot: dataDir, engine: {} as never, startedAt: Date.now(), jwtKey, version: "test" });
  t.after(async () => {
    await app.close();
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const headers = { Authorization: `Bearer ${signJWT(jwtKey)}` };
  const text = { description: "核对发布说明和变更清单。", goal: "每项变更均有记录。" };
  for (const method of ["GET", "POST", "PATCH", "DELETE"] as const) {
    const url = method === "PATCH" || method === "DELETE" ? `${path}/1` : path;
    assert.equal((await app.inject({ method, url })).statusCode, 401);
  }

  const legacy = (await db.query(`INSERT INTO task_templates(name, nkey, description, goal)
    VALUES('历史文档模板', '历史文档模板', $1, $2) RETURNING id`, [text.description, text.goal])).rows[0];
  const list = async () => {
    const response = await app.inject({ method: "GET", url: path, headers });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().templates;
  };
  assert.equal((await list())[0].id, Number(legacy.id));

  const create = (payload: object) => app.inject({ method: "POST", url: path, headers, payload });
  for (const payload of [
    {},
    { name: "x", description: " ", goal: text.goal },
    { name: "x", description: 7, goal: text.goal },
    { name: "x", ...text, goal: null },
    { name: "x", ...text, description: "测试\0" },
    { name: "x", ...text, extra: "不可保存的字段" },
    { name: "名".repeat(121), ...text },
    { name: "x", ...text, description: "例".repeat(16_001) },
    { name: "x", ...text, goal: "例".repeat(16_001) },
  ]) assert.equal((await create(payload)).statusCode, 400);
  assert.equal((await create({ name: "大请求", ...text, goal: "x".repeat(512 * 1024) })).statusCode, 413);

  const boundary = await create({ name: "字".repeat(120), description: "文".repeat(16_000), goal: "🙂".repeat(16_000) });
  assert.equal(boundary.statusCode, 201, boundary.body);
  const [first, duplicate] = await Promise.all([
    create({ name: "  Release　 Notes ", ...text }),
    create({ name: "RELEASE  NOTES", ...text }),
  ]);
  assert.deepEqual([first.statusCode, duplicate.statusCode].sort(), [201, 409]);
  const template = (first.statusCode === 201 ? first : duplicate).json();
  assert.equal(template.name.toLowerCase(), "release notes");
  assert.equal((await list())[0].id, template.id);
  assert.ok(!Object.hasOwn(template, "nkey"));

  const url = `${path}/${template.id}`;
  const patch = (payload: object, target = url) => app.inject({ method: "PATCH", url: target, headers, payload });
  assert.equal((await patch({})).statusCode, 400);
  assert.equal((await patch({ name: " 历史文档模板 " })).statusCode, 409);
  assert.equal((await patch({ name: "失效" }, `${path}/1000000`)).statusCode, 404);
  assert.equal((await patch({ name: "失效" }, `${path}/-1`)).statusCode, 400);
  const nextDescription = "补充用户影响。";
  const nextGoal = "变更项都可定位到负责人。";
  for (const response of await Promise.all([patch({ description: nextDescription }), patch({ goal: nextGoal })])) {
    assert.equal(response.statusCode, 200, response.body);
  }
  const edited = (await list()).find((row: { id: number }) => row.id === template.id);
  assert.equal(edited.description, nextDescription);
  assert.equal(edited.goal, nextGoal);
  assert.equal(edited.created_at, template.created_at);
  assert.ok(edited.updated_at >= template.updated_at);

  const remove = () => app.inject({ method: "DELETE", url, headers });
  assert.deepEqual((await remove()).json(), { deleted: template.id });
  assert.equal((await remove()).statusCode, 404);
  assert.ok(!(await list()).some((row: { id: number }) => row.id === template.id));
  assert.equal((await db.query("SELECT count(*) AS count FROM tasks")).rows[0].count, "0");
});
