import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {fauxAssistantMessage, fauxProvider, fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {openDatabase} from '../db/index.js';
import {aggregateUsage} from '../db/usage-ledger.js';
import {WORKER_TOKEN_LIMIT, TOKEN_LIMIT_REACHED, TOKEN_USAGE_UNCERTAIN} from '../db/worker-token-budget.js';
import {failureReason} from '../engine/worker-outcome.js';
import {registerConfigRoutes} from '../http/routes/config.js';
import {recordFactTool} from '../tools/graph.js';
import {reportFindingTool} from '../tools/findings.js';
import {insertAssetsTool} from '../tools/assets.js';
import {runContext} from '../tools/context.js';
import {AgentRunner} from './runner.js';
import {meterProvider, configureUsageOutbox, closeUsageOutbox, type MeterContext} from './usage-meter.js';

const dsn = process.env.TEST_WORKER_BUDGET_DSN;
test('Worker budget gates physical calls across resume and lets admitted writes finish', {skip: !dsn && 'isolated PostgreSQL required'}, async t => {
  assert.match(new URL(dsn!).pathname, /^\/test_worker_budget_[a-z0-9_]+$/);
  process.env.SERIES_PG_DSN = dsn;
  const db = await openDatabase();
  const dir = await mkdtemp(path.join(tmpdir(), 'worker-budget-'));
  configureUsageOutbox(db, dir);
  const app = Fastify();
  app.decorate('db', db);
  app.decorate('dataDir', dir);
  registerConfigRoutes(app);
  t.after(async () => {
    await app.close();
    await closeUsageOutbox(db);
    await db.close();
    await rm(dir, {recursive: true, force: true});
  });
  const setLimit = (limit: unknown) => app.inject({method: 'PUT', url: '/api/settings', payload: {[WORKER_TOKEN_LIMIT]: limit}});
  assert.equal((await app.inject('/api/settings')).json()[WORKER_TOKEN_LIMIT], 10_000_000);
  assert.equal((await setLimit(-1)).statusCode, 400);
  assert.equal((await setLimit(1)).json()[WORKER_TOKEN_LIMIT], 1);

  const exp = await db.createExploration('budget fixture', 'local');
  const taskID = Number((await db.query("INSERT INTO tasks(exploration_id,description,goal) VALUES($1,'fixture','local') RETURNING id", [exp])).rows[0]!.id);
  const profile = (await db.query("INSERT INTO llm_profiles(name,format,model) VALUES('fixture','openai','local') RETURNING id")).rows[0]!;
  const runtime = await ModelRuntime.create({authPath: path.join(dir,'auth'), modelsPath: path.join(dir,'models'), refreshOnCreate: false});
  const faux = fauxProvider({provider: 'worker-budget-fixture'});
  const workerName = 'work#fixture';
  const intentID = Number((await db.query("INSERT INTO exploration_nodes(exploration_id,kind,state,owner) VALUES($1,'intent','running',$2) RETURNING id",[exp,workerName])).rows[0]!.id);
  const ctx = runContext(db,taskID,exp,'worker',{intentID,workerName});
  const scope: MeterContext = {role:'worker',taskID,intentID,turnID:'turn-a',purpose:'conversation'};
  const provider = meterProvider(db, faux.provider, {id:Number(profile.id),name:'fixture',model:'local'}, () => scope);
  await runtime.registerNativeProvider(provider);
  const model = faux.getModel();
  const call = () => runtime.completeSimple(model, {messages:[{role:'user',content:'local fixture',timestamp:0}]});
  const tools = [recordFactTool(ctx),reportFindingTool(ctx),insertAssetsTool(ctx)];
  const runner = await AgentRunner.create({cwd:dir,agentDir:dir,inMemory:true,modelRuntime:runtime,model,
    systemPrompt:'Local database fixture.',customTools:tools,toolAllowlist:tools.map(tool=>tool.name)});
  faux.setResponses([fauxAssistantMessage([
    fauxToolCall('record_fact',{summary:'Fixture fact',evidence:'Local test row'}),
    fauxToolCall('report_finding',{name:'Fixture finding',summary:'Fixture summary',vulnclass:'fixture',severity:'low',evidence:'Local test row'}),
    fauxToolCall('insert_assets',{assets:[{type:'root_domain',domain:'fixture.example'}]}),
  ]),fauxAssistantMessage('unexpected')]);
  try {
    await assert.rejects(runner.prompt('Save the local records'), new RegExp(TOKEN_LIMIT_REACHED));
    assert.equal((await db.query("SELECT 1 FROM exploration_nodes WHERE exploration_id=$1 AND kind='fact' AND payload->>'summary'='Fixture fact'",[exp])).rowCount,1);
    assert.equal((await db.query("SELECT 1 FROM findings WHERE task_id=$1 AND name='Fixture finding'",[taskID])).rowCount,1);
    assert.equal((await db.query("SELECT 1 FROM assets WHERE $1=ANY(task_ids) AND domain='fixture.example'",[taskID])).rowCount,1);
  } finally { await runner.dispose(); }
  assert.equal(faux.state.callCount, 1);
  const [usage] = await aggregateUsage(db,{taskID,intentID});
  const used = usage!.input_tokens + usage!.output_tokens;
  assert.ok(used > 1);
  assert.equal((await setLimit(used)).statusCode, 200);
  scope.turnID = 'resumed-turn';
  scope.purpose = 'compaction';
  const denied = await call();
  assert.equal(failureReason(denied.errorMessage!), 'token_limit');
  assert.equal(faux.state.callCount, 1);
  assert.equal((await aggregateUsage(db,{taskID,intentID}))[0]!.calls, 1);

  assert.equal((await setLimit(1)).statusCode, 200);
  scope.intentID = intentID + 1;
  const replies = await Promise.all([call(),call()]);
  assert.equal(replies.filter(r => r.stopReason === 'stop').length, 1);
  // A simultaneous request either sees its peer in flight or the finalized charge.
  assert.match(replies.find(r => r.stopReason === 'error')!.errorMessage!, new RegExp(TOKEN_USAGE_UNCERTAIN+'|'+TOKEN_LIMIT_REACHED));
  scope.intentID = intentID;
  scope.role = 'planner';
  faux.setResponses([fauxAssistantMessage('planner'),fauxAssistantMessage('unlimited')]);
  assert.equal((await call()).stopReason, 'stop');
  scope.role = 'worker';
  assert.equal((await setLimit(0)).statusCode, 200);
  assert.equal((await call()).stopReason, 'stop');
});
