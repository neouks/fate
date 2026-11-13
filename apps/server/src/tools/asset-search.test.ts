import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openDatabase} from '../db/index.js';
import {migrateAssetCoverageBinding} from '../db/asset-migration.js';
import {mergedAssetSearchTool} from './asset-search-compat.js';
import {listAssetsTool} from './assets.js';
import {runContext} from './context.js';

const dsn = process.env.TEST_ASSET_SEARCH_DSN;

test('Worker asset coverage filters share scope, pagination, and live permission', {
  skip: !dsn && 'set TEST_ASSET_SEARCH_DSN to an isolated PostgreSQL database',
}, async t => {
  assert.ok(dsn);
  assert.match(new URL(dsn).pathname, /^\/test_[a-z0-9_]+$/);
  const previous = process.env.SERIES_PG_DSN;
  process.env.SERIES_PG_DSN = dsn;
  t.after(() => {
    if (previous === undefined) delete process.env.SERIES_PG_DSN;
    else process.env.SERIES_PG_DSN = previous;
  });
  const db = await openDatabase();
  t.after(() => db.close());

  const task = async (label: string) => (await db.query<{id:string;exploration_id:string}>(`
    WITH e AS (INSERT INTO explorations(goal) VALUES ($1) RETURNING id)
    INSERT INTO tasks(description,goal,exploration_id) SELECT $1,$1,id FROM e RETURNING id,exploration_id`, [label])).rows[0]!;
  const own = await task('own'), source = await task('source'), unrelated = await task('unrelated');
  await db.query('INSERT INTO task_relations(task_id,source_task_id) VALUES ($1,$2)', [own.id,source.id]);
  await db.query(`INSERT INTO task_scope(task_id,kind,domain) VALUES ($1,'subdomain','scope.example.test'),
    ($2,'subdomain','scope.example.test')`, [own.id,source.id]);
  const add = async (taskID: string, slug: string, domain = 'scope.example.test', legacy = false) => {
    const asset = (await db.query<{id:string}>(
      "INSERT INTO assets(type,domain,url,method) VALUES ('endpoint',$1,$2,'GET') RETURNING id",
      [domain,`https://${domain}/${slug}`],
    )).rows[0]!;
    await db.query('INSERT INTO task_asset_links(task_id,asset_id,tested) VALUES ($1,$2,$3)', [taskID,asset.id,legacy]);
    return Number(asset.id);
  };
  const tested = await add(own.id,'verified');
  const legacy = await add(own.id,'legacy','scope.example.test',true);
  const inherited = await add(source.id,'inherited');
  const outside = await add(own.id,'outside','outside.example.test');
  await add(unrelated.id,'unrelated');
  await db.query(`WITH f AS (
    INSERT INTO exploration_nodes(exploration_id,kind,state,payload)
    VALUES ($1,'fact','confirmed','{"writeback":{"coverage_eligible":true},"scope":{"tested":"local fixture"},"observation_type":"observed","evidence":"fixture response"}')
    RETURNING id
  ) INSERT INTO exploration_anchors(node_id,asset_id) SELECT id,$2 FROM f`, [own.exploration_id,tested]);

  const ctx = runContext(db,Number(own.id),Number(own.exploration_id),'worker');
  const tool = mergedAssetSearchTool(ctx);
  const invoke = async (params: Record<string,unknown>, entry = tool) => {
    const result = await entry.execute('fixture',params,undefined,undefined,{} as never);
    return {error:result.isError===true,body:JSON.parse((result.content[0] as {text:string}).text)};
  };
  const option = {type:'endpoint',untested:true};
  const filter = {dsl:'type==endpoint AND tested==false'};
  const first = await invoke({...option,limit:1});
  assert.equal(first.error,false);
  assert.deepEqual(first,await invoke({...filter,limit:1}));
  assert.equal(first.body.total,2);
  assert.equal(first.body.next_offset,1);
  assert.equal(first.body.assets[0].id,legacy);
  assert.equal(first.body.assets[0].legacy_tested,true);
  const next = await invoke({...filter,limit:1,offset:1});
  assert.equal(next.body.assets[0].id,inherited);
  assert.equal(next.body.assets[0].read_only,true);
  const compound = await invoke({dsl:'type==endpoint AND (tested!=false OR url==https://outside.example.test/outside)'});
  assert.deepEqual(compound.body.assets.map((asset:{id:number})=>asset.id),[tested,outside]);
  assert.match((await invoke({dsl:'tested==maybe'})).body.error,/true 或 false/);

  await db.query('UPDATE tasks SET coverage_enabled=false WHERE id=$1',[own.id]);
  for (const params of [option,filter]) assert.match((await invoke(params)).body.error,/需要启用任务覆盖度/);
  await db.query('UPDATE tasks SET coverage_enabled=true WHERE id=$1',[own.id]);
  await db.query(`UPDATE tools SET agents='["planner","mainagent"]' WHERE key='list_untested_assets'`);
  await migrateAssetCoverageBinding(db);
  for (const params of [option,filter,{dsl:'tested==true OR type==endpoint'}])
    assert.match((await invoke(params)).body.error,/当前角色无 list_untested_assets/);
  assert.match((await invoke(filter,listAssetsTool(ctx))).body.error,/当前角色无 list_untested_assets/);
  assert.equal((await invoke({dsl:'type==endpoint'})).body.total,4);

  // An explicitly disabled historical default must not be migrated.
  await db.query("DELETE FROM settings WHERE key='asset_search_worker_coverage_v1'");
  await db.query("UPDATE tools SET enabled=false WHERE key='list_untested_assets'");
  await migrateAssetCoverageBinding(db);
  const disabled = (await db.query("SELECT enabled,agents FROM tools WHERE key='list_untested_assets'")).rows[0];
  assert.deepEqual(disabled,{enabled:false,agents:['planner','mainagent']});
});
