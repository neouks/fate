import assert from 'node:assert/strict';
import {test} from 'node:test';
import Fastify from 'fastify';
import {openDatabase} from '../../db/index.js';
import {requireJWT,signJWT} from '../auth.js';
import {registerCategoryRoutes} from './categories.js';

const dsn=process.env.TEST_MANAGEMENT_CONTRACTS_DSN;
test('任务分类管理契约', {skip:dsn?false:'requires isolated TEST_MANAGEMENT_CONTRACTS_DSN'},async t=>{
  assert.ok(dsn);assert.match(new URL(dsn).pathname,/^\/test_[a-z0-9_]+$/);
  process.env.SERIES_PG_DSN=dsn;
  const db=await openDatabase();t.after(()=>db.close());
  const app=Fastify();app.decorate('db',db);
  const secret='local-management-fixture-secret';
  app.addHook('preHandler',requireJWT(secret));
  registerCategoryRoutes(app);t.after(()=>app.close());
  const headers={'x-series-token':signJWT(secret)};
  const category=(name:string)=>app.inject({method:'POST',url:'/api/task-categories',headers,payload:{name}});
  const rename=(id:number,name:string)=>app.inject({method:'PATCH',url:'/api/task-categories/'+id,headers,payload:{name}});
  await t.test('未登录不能新建分类',async()=>{assert.equal((await app.inject({method:'POST',url:'/api/task-categories',payload:{name:'blocked'}})).statusCode,401);});
  await t.test('分类改名同步查重键，旧名称可复用，新名称拒绝重复',async()=>{
    const created=await category('Before');assert.equal(created.statusCode,201);
    assert.equal((await rename(created.json().id,'After')).statusCode,200);
    assert.equal((await category(' BEFORE ')).statusCode,201);
    assert.equal((await category(' AFTER ')).statusCode,409);
    const row=(await db.query('SELECT name,nkey FROM task_categories WHERE id=$1',[created.json().id])).rows[0];
    assert.deepEqual(row,{name:'After',nkey:'after'});
  });
  await t.test('并发新建与并发改名返回一个成功和一个 409',async()=>{
    assert.deepEqual((await Promise.all([category('Race'),category('race')])).map(r=>r.statusCode).sort(),[201,409]);
    const a=(await category('Left')).json(),b=(await category('Right')).json();
    assert.deepEqual((await Promise.all([rename(a.id,'Same'),rename(b.id,'Same')])).map(r=>r.statusCode).sort(),[200,409]);
  });
});
