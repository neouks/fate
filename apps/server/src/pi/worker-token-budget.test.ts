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
import {WORKER_TOKEN_LIMIT, TOKEN_LIMIT_REACHED, TOKEN_USAGE_UNCERTAIN, readWorkerTokenBudget, workerRequestMaxTokens} from '../db/worker-token-budget.js';
import {failureReason,workerStopReceipt} from '../engine/worker-outcome.js';
import type {Database} from '../db/index.js';
import type {Node} from '../db/exploration.js';
import {registerConfigRoutes} from '../http/routes/config.js';
import {recordFactTool} from '../tools/graph.js';
import {reportFindingTool} from '../tools/findings.js';
import {insertAssetsTool} from '../tools/assets.js';
import {runContext} from '../tools/context.js';
import {AgentRunner} from './runner.js';
import {meterProvider, configureUsageOutbox, closeUsageOutbox, type MeterContext} from './usage-meter.js';

const dsn = process.env.TEST_WORKER_BUDGET_DSN;

test('Worker stop receipts preserve the provider error alongside an unresolved charge',async()=>{
  const node={id:12,payload:{}} as Node;
  let original='terminated: other side closed (UND_ERR_SOCKET)';
  const calls:unknown[][]=[];
  const db={query:async(sql:string,params:unknown[])=>{
    if(!sql.includes('llm_request_attempts'))return {rows:[]};
    calls.push(params);
    return {rows:original?[{error:original}]:[]};
  }} as unknown as Database;
  const hold=TOKEN_USAGE_UNCERTAIN+'：先前请求尚未结算或缺少完整用量';
  const receipt=await workerStopReceipt(db,11,node,'token_usage_unknown','turn-1','宿主上下文构建失败：'+hold);
  assert.equal(receipt.reason,'token_usage_unknown');
  assert.equal(receipt.summary,'模型请求原始错误：'+original+'\n'+hold);
  assert.deepEqual(calls.pop(),[11,12,true,'turn-1']);

  original='connect ECONNREFUSED via http://user:password@localhost:3000 (Bearer fixture-token)';
  const direct=await workerStopReceipt(db,11,node,'model_connection_error','turn-2','Connection error');
  assert.deepEqual(calls.pop(),[11,12,false,'turn-2']);
  assert.match(direct.summary,/connect ECONNREFUSED/);
  assert.doesNotMatch(direct.summary,/password|fixture-token/);
  original='';
  assert.equal((await workerStopReceipt(db,11,node,'token_usage_unknown','turn-3',hold)).summary,hold);
  const queries=calls.length;
  await workerStopReceipt(db,11,node,'task_paused','turn-4');
  await workerStopReceipt(db,11,node,'token_usage_unknown','turn-5',TOKEN_USAGE_UNCERTAIN+'：额度配置无效');
  assert.equal(calls.length,queries);
});

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
  const faux = fauxProvider({provider: 'worker-budget-fixture',models:[{id:'local',contextWindow:4096,maxTokens:256}]});
  const workerName = 'work#fixture';
  const intentID = Number((await db.query("INSERT INTO exploration_nodes(exploration_id,kind,state,owner) VALUES($1,'intent','running',$2) RETURNING id",[exp,workerName])).rows[0]!.id);
  const ctx = runContext(db,taskID,exp,'worker',{intentID,workerName});
  const scope: MeterContext = {role:'worker',taskID,intentID,turnID:'turn-a',purpose:'conversation'};
  const provider = meterProvider(db, faux.provider, {id:Number(profile.id),name:'fixture',model:'local'}, () => scope);
  await runtime.registerNativeProvider(provider);
  const model = faux.getModel();
  const call = () => runtime.completeSimple(model, {messages:[{role:'user',content:'local fixture',timestamp:0}]});
  assert.match((await call()).errorMessage!,new RegExp(TOKEN_LIMIT_REACHED));
  assert.equal(faux.state.callCount,0);
  await setLimit(model.contextWindow+model.maxTokens);
  const tools = [recordFactTool(ctx),reportFindingTool(ctx),insertAssetsTool(ctx)];
  const runner = await AgentRunner.create({cwd:dir,agentDir:dir,inMemory:true,modelRuntime:runtime,model,
    systemPrompt:'Local database fixture.',customTools:tools,toolAllowlist:tools.map(tool=>tool.name)});
  faux.setResponses([(_context,options,_state,physicalModel)=>{
    assert.equal(options?.maxTokens,256);
    assert.equal(physicalModel.maxTokens,256);
    return fauxAssistantMessage([
    fauxToolCall('record_fact',{summary:'Fixture fact',evidence:'Local test row'}),
    fauxToolCall('report_finding',{name:'Fixture finding',summary:'Fixture summary',vulnclass:'fixture',severity:'low',evidence:'Local test row'}),
    fauxToolCall('insert_assets',{assets:[{type:'root_domain',domain:'fixture.example'}]}),
  ]);},fauxAssistantMessage('unexpected')]);
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
  assert.equal((await readWorkerTokenBudget(db,scope))!.remaining,0);
  scope.turnID = 'resumed-turn';
  scope.purpose = 'compaction';
  const denied = await call();
  assert.equal(failureReason(denied.errorMessage!), 'token_limit');
  assert.equal(faux.state.callCount, 1);
  assert.equal((await aggregateUsage(db,{taskID,intentID}))[0]!.calls, 1);

  assert.equal((await setLimit(model.contextWindow+1)).statusCode, 200);
  scope.intentID = intentID + 1;
  faux.setResponses([fauxAssistantMessage('x')]);
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

  await t.test('reserved closing blocks new operations and durably writes facts/findings within the same total',async()=>{
    scope.role='worker';scope.intentID=intentID;scope.turnID='closing-turn';scope.purpose='conversation';
    await setLimit(100_000);
    // Keep genuine earlier receipts, then seed a previous run near the closing threshold.
    const before=(await aggregateUsage(db,{taskID,intentID}))[0]!;
    const ceiling=model.contextWindow+model.maxTokens;
    const threshold=100_000-4*ceiling;
    await db.query(`INSERT INTO llm_usage_ledger(request_id,task_id,intent_id,scope_key,role,model,status,quality,source,usage,created_at,finished_at)
      VALUES('closing-seed',$1,$2,'previous-run','worker','local','completed','complete','provider',$3,now(),now())`,
      [taskID,intentID,JSON.stringify({input:threshold-before.input_tokens-before.output_tokens-1,output:0,cacheRead:0,cacheWrite:0})]);
    const budget=()=>readWorkerTokenBudget(db,scope,ceiling);
    assert.equal((await budget())!.closing,false);
    let probes=0;
    const activity:string[]=[];
    const localProbe={name:'local_probe',label:'Local probe',description:'Fixture only.',parameters:{type:'object',properties:{}},
      execute:async()=>{probes++;return {content:[{type:'text' as const,text:'probe'}],details:{}};}};
    const makeRunner=()=>AgentRunner.create({cwd:dir,agentDir:dir,inMemory:true,modelRuntime:runtime,model,
      systemPrompt:'Local writeback fixture.',customTools:[...tools,localProbe],toolAllowlist:[...tools.map(t=>t.name),'local_probe'],
      stopOnFinalResponse:true,settlementTools:tools.map(t=>t.name),maxWrapupTurns:2,wrapup:()=>({prompt:'Save existing observations.'}),
      modelPolicy:{workerTokenBudget:budget,onResponse:async()=>{},retry:async()=>false},
      onActivity:a=>{if(a.kind==='host_status')activity.push(a.text);}});
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('local_probe',{})]),
      context=>{
        assert.match(JSON.stringify(context.messages),/收尾及压缩均计入同一总预算/);
        assert.ok(!context.tools?.some(t=>t.name==='local_probe'));
        return fauxAssistantMessage([
          fauxToolCall('record_fact',{summary:'Closing fact',evidence:'Existing local evidence'}),
          fauxToolCall('report_finding',{name:'Closing finding',summary:'Brief existing observation',vulnclass:'fixture',severity:'low',evidence:'Existing local evidence'}),
        ]);
      },fauxAssistantMessage('Saved existing fact and finding; remaining work deferred.'),
    ]);
    const closing=await makeRunner();
    try{
      const result=await closing.prompt('Use existing observations');
      assert.equal(result.stopReason,'budget');assert.equal(result.budgetReason,'token_limit');
      assert.match(result.lastAssistantText!,/Saved existing/);
      assert.match(JSON.stringify(closing.sessionEntries),/server_token_budget/);
    }finally{await closing.dispose();}
    assert.equal(probes,0);
    assert.equal(activity.length,1);
    assert.equal((await db.query("SELECT 1 FROM exploration_nodes WHERE exploration_id=$1 AND kind='fact' AND payload->>'summary'='Closing fact'",[exp])).rowCount,1);
    assert.equal((await db.query("SELECT 1 FROM findings WHERE task_id=$1 AND name='Closing finding'",[taskID])).rowCount,1);
    const used=(await budget())!;assert.ok(used.used>threshold);assert.ok(used.used<=used.limit);
    // A new runner starts in closing too; neither turn IDs nor compaction reset the counter.
    scope.turnID='closing-resumed';scope.purpose='compaction';
    faux.setResponses([fauxAssistantMessage('Local compact summary')]);
    assert.equal((await call()).stopReason,'stop');
    assert.ok((await budget())!.used>used.used);
    scope.purpose='conversation';
    faux.setResponses([context=>{
      assert.match(JSON.stringify(context.messages),/停止新操作/);
      assert.ok(!context.tools?.some(t=>t.name==='local_probe'));
      return fauxAssistantMessage('Already saved.');
    }]);
    const resumed=await makeRunner();
    try{assert.equal((await resumed.prompt('Resume')).budgetReason,'token_limit');}finally{await resumed.dispose();}
  });
});

test('request allowance reserves input and caps output inside the total',()=>{
  const budget={limit:10_000_000,used:9_865_000,remaining:135_000,reserve:1_000_000,closing:true};
  const model={contextWindow:128_000,maxTokens:16_000};
  assert.equal(workerRequestMaxTokens(budget,model),7000);
  assert.equal(workerRequestMaxTokens(budget,model,1000),1000);
  assert.throws(()=>workerRequestMaxTokens({...budget,remaining:128_000},model),new RegExp(TOKEN_LIMIT_REACHED));
});
