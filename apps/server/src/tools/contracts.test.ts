import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fauxAssistantMessage, fauxProvider, fauxToolCall, validateToolArguments} from '@earendil-works/pi-ai';
import {ModelRuntime, type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {compactToolSchema} from '../agent/tool-loading.js';
import type {Database} from '../db/index.js';
import {priorPlannerDispatch} from '../db/planner-dispatch.js';
import {AgentRunner, type RunnerActivity} from '../pi/runner.js';
import {buildModelSource} from '../pi/providerFromProfile.js';
import {insertAssetsTool} from './assets.js';
import {runContext} from './context.js';
import {contextSearchTool} from './context-read.js';
import {conversationDomainTools} from './conversations.js';
import {registerUserTargetTool} from './goals.js';
import {recordFactTool} from './graph.js';
import {addIntentTool, dispatchIntentsTool} from './intents.js';
import {domainTool} from './define.js';

function validate(tool: ToolDefinition, args: Record<string, unknown>) {
  return validateToolArguments(tool, {
    type: 'toolCall', id: 'probe', name: tool.name, arguments: tool.prepareArguments ? tool.prepareArguments(args) : args,
  });
}

async function invoke(tool: ToolDefinition, args: Record<string, unknown>, checkSchema = true) {
  const result = await tool.execute('probe', checkSchema ? validate(tool, args) : args, undefined, undefined, {} as never);
  const content = result.content[0];
  assert.equal(content?.type, 'text');
  return {error: result.isError === true, body: JSON.parse((content as {text: string}).text)};
}

const noDB = {} as Database;

test('add_intent declares a required intents array and normalizes historical single calls', () => {
  for (const tool of [addIntentTool(runContext(noDB, 1, 1, 'planner')), compactToolSchema(addIntentTool(runContext(noDB, 1, 1, 'planner')))]) {
    for (const args of [{}, {intents:[]}, {summary:' '}, {summary:false}, {summary:'A',intents:[{summary:'B'}]},
      {intents:[{summary:'B'}],asset_ids:[1]}, {intents:[{summray:'B'}]}]) {
      assert.throws(() => validate(tool, args));
    }
    assert.throws(() => validate(tool, {intents:[{summary:'A'},{summary:' '}]}), /intents\[1\]\.summary/);
    assert.deepEqual((tool.parameters as {required?: string[]}).required, ['intents']);
    assert.throws(() => validateToolArguments(tool, {type:'toolCall',id:'empty',name:'add_intent',arguments:{}}), /intents/);
    assert.deepEqual(validate(tool, {summary:'核对入口'}), {intents:[{summary:'核对入口'}]});
    const inherited = {intents:[{summary:'复核已有证据',contract:{basis:[{node_id:42,version:0}]}}]};
    assert.deepEqual(validate(tool, inherited), inherited);
  }
});

test('add_intent receipt replays an old flat call and rejects changed arguments', async () => {
  const flat = {summary:'核对入口'};
  const result = [{intent_id:17,created:true,summary:flat.summary}];
  const db = {query:async (sql:string) => ({rows:sql.startsWith('SELECT delivery_id') ? [{
    delivery_id:'delivery',arguments_hash:createHash('sha256').update(JSON.stringify(flat)).digest('hex'),result_text:JSON.stringify(result),
  }] : []})} as unknown as Database;
  const ctx = runContext(db,1,1,'planner',{toolCallID:'call',plannerDelivery:{sessionID:'session',deliveryID:'delivery'}});
  assert.deepEqual((await priorPlannerDispatch(db,ctx,{intents:[flat]},flat))?.prior,result);
  await assert.rejects(priorPlannerDispatch(db,ctx,{intents:[{summary:'其他方向'}]},{summary:'其他方向'}),/参数或交付身份已变化/);
});

test('add_intent rejects misplaced evidence before the entire batch reaches storage', async () => {
  let transactions = 0;
  const db = {transaction: async () => {transactions++; throw new Error('unexpected storage access');}} as unknown as Database;
  const tool = addIntentTool(runContext(db, 1, 1, 'planner'));
  const args = {intents:[{summary:'核对本地清单'},{summary:'核对本地记录',basis:[{node_id:42,version:0}]}]};
  assert.throws(() => validate(tool,args), /intents\[1\]\.basis 只能放在 contract\.basis/);
  const result = await invoke(tool,args,false);
  assert.equal(result.error,true);
  assert.match(result.body.error,/intents\[1\]\.basis 只能放在 contract\.basis/);
  assert.equal(transactions,0);
});

test('OpenAI-compatible streaming rejects empty add_intent and accepts a corrected fragmented call', async () => {
  const dir = await mkdtemp(join(tmpdir(),'fate-intent-wire-'));
  const requests: {tools?: {function: {name:string;parameters:{required:string[]}}}[]}[] = [];
  const server = createServer(async (request,response) => {
    let body='';
    for await (const chunk of request) body+=chunk;
    requests.push(JSON.parse(body));
    const n=requests.length;
    response.writeHead(200,{'Content-Type':'text/event-stream'});
    const send = (delta:object, finish_reason:string|null=null) => response.write('data: '+JSON.stringify({
      id:'fixture',object:'chat.completion.chunk',created:1,model:'deepseek-flash',choices:[{index:0,delta,finish_reason}],
    })+'\n\n');
    if(n<=2){
      send({role:'assistant',tool_calls:[{index:0,id:'call_'+n,type:'function',function:{name:'add_intent',arguments:''}}]});
      if(n===2)for(const fragment of ['{"intents":[{"sum','mary":"核对入口"}]}'])
        send({tool_calls:[{index:0,function:{arguments:fragment}}]});
      send({},'tool_calls');
    }else send({role:'assistant',content:'已核对派单回执'},'stop');
    response.end('data: [DONE]\n\n');
  });
  try {
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();
    assert.ok(address&&typeof address!=='string');
    const model=await buildModelSource({id:1,name:'本地夹具',model:'deepseek-flash',baseURL:`http://127.0.0.1:${address.port}/v1`,
      apiKey:'fixture-key',contextWindowK:32,maxTokens:512,streaming:true});
    const tool=addIntentTool(runContext(noDB,1,1,'planner'));
    const saved: unknown[] = [];
    const activities: RunnerActivity[] = [];
    const runner=await AgentRunner.create({...model,cwd:dir,agentDir:dir,inMemory:true,systemPrompt:'本地流式派单回归。',
      toolAllowlist:[tool.name],customTools:[{...tool,execute:async (_id,args)=>{
        saved.push(args);
        return {content:[{type:'text',text:'已保存'}],details:undefined};
      }}],maxDurationMs:10_000,onActivity:activity=>{activities.push(activity);}});
    try {
      const result=await runner.prompt('检查空参数及分片修正');
      assert.equal(result.aborted,false);
      assert.equal(requests.length,3);
      assert.deepEqual(requests[0]?.tools?.find(tool=>tool.function.name==='add_intent')?.function.parameters.required,['intents']);
      assert.ok(activities.some(a=>a.kind==='tool_end'&&a.isError&&a.text?.includes('未收到意图参数')));
      assert.deepEqual(saved,[{intents:[{summary:'核对入口'}]}]);
    } finally {await runner.dispose();}
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});

test('dispatch_intents rejects empty, null and mixed scopes before reading the queue', async () => {
  const selected: number[] = [];
  let queueReads = 0;
  const db = {exploration:()=>({
    frontier:async () => { queueReads++; return [{id:11},{id:12}]; },
    getNode:async (id:number) => ({id,kind:'intent',state:'open',payload:{}}),
  })} as unknown as Database;
  const tool = dispatchIntentsTool(runContext(db, 1, 1, 'mainagent', {
    hooks:{dispatchIntent:async (_expID,id) => {selected.push(id);}},
  }));
  for (const args of [{}, {intent_ids:[]}, {intent_ids:null}, {intent_ids:[true]}, {all_open:'true'}, {all_open:true,intent_ids:null}]) {
    assert.throws(() => validate(tool,args));
    assert.equal((await invoke(tool,args,false)).error,true);
  }
  assert.equal(queueReads,0);
  assert.deepEqual(selected,[]);
  assert.equal((await invoke(tool,{intent_ids:[12,12]})).body.dispatched,1);
  assert.deepEqual(selected,[12]);
  assert.equal((await invoke(tool,{all_open:true})).body.dispatched,2);
  assert.equal(queueReads,1);
  assert.deepEqual(selected,[12,11,12]);
});

test('Goals only registers a target grounded in its current task input', async () => {
  const targetUrl = 'https://mall.example.test/pages/home';
  const targetBlock = '目标：\n' + targetUrl;
  const alternateBlock = '测试目标：\r\nhttps://alternate.example.test/entry';
  const deniedBlock = '参考目标：\nhttps://reference.example.test/entry';
  const task = {
    exploration_id:2,
    goal:'核对授权入口',
    description:[
      targetBlock, alternateBlock, deniedBlock,
      '仅测试 “https://app.example.test:8443/api”，禁止扫描其他端口。不要测试 deny.example.test。授权 *.owned.test。允许检查 192.0.2.0/28。',
    ].join('\n'),
  };
  const bootstrap = {...task,phase:'constraints',policy:'series-single-session-v1'};
  const writes: unknown[][] = [];
  const stub = {
    query:async (sql:string) => ({rows:sql.startsWith('SELECT * FROM tasks')?[task]:sql.startsWith('SELECT * FROM goals_bootstrap')?[bootstrap]:[]}),
    transaction:async (body:(db:Database)=>unknown) => body(stub as unknown as Database),
    taskScope:()=>({addAgentScope:async (...args:unknown[]) => {writes.push(args);}}),
  };
  const tool = registerUserTargetTool(runContext(stub as unknown as Database, 1, 2, 'goals', {goalsPhase:'combined'}));
  const quote = '仅测试 “https://app.example.test:8443/api”，禁止扫描其他端口。';
  for (const args of [
    {kind:'subdomain',value:'app.example.test',evidence:'伪造的用户授权 app.example.test'},
    {kind:'subdomain',value:'app.example.test',evidence:'仅测试 “https://app.example.test:8443/api”'},
    {kind:'subdomain',value:'example.test',evidence:quote},
    {kind:'root_domain',value:'app.example.test',evidence:quote},
    {kind:'root_domain',value:'example.test',evidence:quote},
    {kind:'subdomain',value:'deny.example.test',evidence:'不要测试 deny.example.test。'},
    {kind:'subdomain',value:'deny.example.test',evidence:'测试 deny.example.test。'},
    {kind:'cidr',value:'192.0.2.0/24',evidence:'允许检查 192.0.2.0/28。'},
    {kind:'subdomain',value:'mall.example.test',evidence:'授权目标：\n'+targetUrl},
    {kind:'subdomain',value:'mall.example.test',evidence:'测试目标：\n'+targetUrl},
    {kind:'subdomain',value:'mall.example.test',evidence:'目标：\nhttps://mall.example.test/'},
    {kind:'subdomain',value:'reference.example.test',evidence:deniedBlock},
    {kind:'subdomain',value:'example.test',evidence:targetBlock},
  ]) assert.equal((await invoke(tool,args)).error,true);
  assert.deepEqual(writes,[]);
  assert.equal((await invoke(tool,{kind:'subdomain',value:'app.example.test',evidence:quote})).body.source_verified,true);
  assert.equal((await invoke(tool,{kind:'root_domain',value:'owned.test',evidence:'授权 *.owned.test。'})).error,false);
  assert.equal((await invoke(tool,{kind:'cidr',value:'192.0.2.0/28',evidence:'允许检查 192.0.2.0/28。'})).error,false);
  for (const evidence of [targetUrl, targetBlock, targetBlock.replace('\n','\\n')]) {
    assert.equal((await invoke(tool,{kind:'subdomain',value:'mall.example.test',evidence})).body.source_verified,true);
  }
  const escapedAlternate = alternateBlock.replace('\r\n','\\r\\n');
  assert.equal((await invoke(tool,{kind:'subdomain',value:'alternate.example.test',evidence:escapedAlternate})).body.source_verified,true);
  assert.deepEqual(writes.map(write=>write.slice(1,5)),[
    ['subdomain','app.example.test',quote,'agent'],
    ['root_domain','owned.test','授权 *.owned.test。','agent'],
    ['cidr','192.0.2.0/28','允许检查 192.0.2.0/28。','agent'],
    ['subdomain','mall.example.test',targetUrl,'agent'],
    ['subdomain','mall.example.test',targetBlock,'agent'],
    ['subdomain','mall.example.test',targetBlock,'agent'],
    ['subdomain','alternate.example.test',alternateBlock,'agent'],
  ]);
});

test('write tools mark an all-failed batch as a tool error and retain item receipts', async () => {
  const noWrites = {transaction:async () => {throw new Error('模拟写入失败');}} as unknown as Database;
  const fact = recordFactTool(runContext(noWrites, 1, 1, 'worker'));
  assert.throws(() => validate(fact,{summary:'没有证据'}));
  assert.throws(() => validate(fact,{facts:[{summary:'没有证据'}]}));
  const facts = await invoke(fact,{facts:[{summary:'观察',evidence:'记录'}]});
  assert.equal(facts.error,true);
  assert.deepEqual(facts.body.fact_ids,[0]);

  const asset = compactToolSchema(insertAssetsTool(runContext(noWrites, 1, 1, 'worker')));
  assert.throws(() => validate(asset,{assets:[{type:'endpoint'}]}));
  assert.throws(() => validate(asset,{assets:[{type:'service',port:22,service_name:'ssh'}]}));
  const failed = await invoke(asset,{assets:[{type:'endpoint',url:'not-a-url',method:'GET'}]});
  assert.equal(failed.error,true);
  assert.equal(failed.body.inserted,0);
  assert.equal(failed.body.errors[0].index,0);
  const db = {
    transaction:async (body:(db:Database)=>unknown) => body(db as unknown as Database),
    tasks:()=>({getTask:async()=>({id:1})}),
    query:async()=>({rows:[]}),
    assets:()=>({registerAgentAsset:async()=>42}),
  };
  const partial = await invoke(insertAssetsTool(runContext(db as unknown as Database,1,1,'worker')), {
    assets:[{type:'endpoint',url:'not-a-url',method:'GET'},{type:'endpoint',url:'https://example.test/api',method:'GET',related:false}],
  });
  assert.equal(partial.error,false);
  assert.equal(partial.body.inserted,1);
  assert.deepEqual(partial.body.results,[{index:1,id:42,type:'endpoint'}]);
  assert.equal(partial.body.errors[0].index,0);
});

test('context_search rejects unsupported filters and retains valid pagination parameters', async () => {
  const tool = contextSearchTool(runContext(noDB, 1, 1, 'planner'));
  for (const source of ['operations','needs']) {
    const args = {source,state:'failed'};
    assert.throws(() => validate(tool,args));
    assert.match((await invoke(tool,args,false)).body.error,/不支持 state/);
  }
  assert.deepEqual(validate(tool,{source:'operations',cursor:'7',limit:4}),{source:'operations',cursor:'7',limit:4});
  assert.deepEqual(validate(tool,{source:'graph',state:'confirmed'}),{source:'graph',state:'confirmed'});
  assert.deepEqual(validate(tool,{source:'planner_session',roles:['assistant']}),{source:'planner_session',roles:['assistant']});
  assert.throws(() => validate(tool,{source:'planner_session',intent_id:1}));
  assert.throws(() => validate(contextSearchTool(runContext(noDB,1,1,'reporter')),{source:'operations'}));
});

test('Reporter requires concise sections and Auto still accepts legacy report content', async () => {
  const tool = (role:'reporter'|'auto') => conversationDomainTools(runContext(noDB,1,1,role),{} as never)
    .find(t=>t.name==='update_finding_report')!;
  const ids = {finding_id:1,evidence_version:2,report_revision:3};
  const sections = {description:'分析说明',impact:[],remediation:[]};
  assert.throws(() => validate(tool('reporter'),ids));
  assert.throws(() => validate(tool('reporter'),{...ids,report:'旧版报告'}));
  assert.throws(() => validate(tool('reporter'),{...ids,report_sections:sections}));
  assert.equal((await invoke(tool('reporter'),{...ids,report:'旧版报告'},false)).error,true);
  const concise = {...ids,report_sections:{...sections,discovery:{}}};
  assert.deepEqual(validate(tool('reporter'),concise),concise);
  assert.throws(() => validate(tool('auto'),{...ids,report:' '}));
  for (const args of [{...ids,report:'旧版报告'}, {...ids,report_sections:sections}])
    assert.deepEqual(validate(tool('auto'),args),args);
});

test('native PI stops repeated empty add_intent even after an intervening read', async () => {
  const dir = await mkdtemp(join(tmpdir(),'fate-intent-retries-'));
  const runtime = await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
  const faux = fauxProvider({provider:'intent-retries'});
  runtime.registerNativeProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('add_intent',{})]),
    fauxAssistantMessage([fauxToolCall('context_get',{})]),
    fauxAssistantMessage([fauxToolCall('add_intent',{})]),
    fauxAssistantMessage('第四次请求不应发生'),
  ]);
  const activities: RunnerActivity[] = [];
  const runner = await AgentRunner.create({
    cwd:dir, agentDir:dir, sessionDir:dir, modelRuntime:runtime, model:faux.getModel(),
    systemPrompt:'本地工具参数回归。', toolAllowlist:['add_intent','context_get'], customTools:[
      addIntentTool(runContext(noDB,1,1,'planner')),
      domainTool({name:'context_get',description:'本地查询',parameters:{type:'object',properties:{}},transactional:false,
        run:async()=>({facts:[]})},runContext(noDB,1,1,'planner')),
    ],
    maxTurns:0, maxDurationMs:10000, onActivity:activity=>{activities.push(activity);},
  });
  try {
    const result = await runner.prompt('验证重复参数失败');
    assert.equal(result.aborted,true);
    assert.equal(faux.state.callCount,3);
    assert.ok(activities.some(activity=>activity.kind==='tool_end'&&activity.toolName==='add_intent'&&activity.text?.includes('未收到意图参数')));
    assert.ok(activities.some(activity=>activity.kind==='host_status'&&activity.phase==='tool_retries_exhausted'));
  } finally {
    await runner.dispose();
    await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});

test('Worker closes repeated permission errors in one batch and can still write back', async () => {
  const dir = await mkdtemp(join(tmpdir(),'fate-worker-retries-'));
  try {
    const runtime = await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
    const faux = fauxProvider({provider:'worker-tool-retries'});
    runtime.registerNativeProvider(faux.provider);
    faux.setResponses([
      context=>{
        // The shared candidate inventory contains every tool. The effective
        // declaration/allowlist, not that inventory, controls this worker.
        assert.ok(!context.tools?.some(tool=>tool.name==='add_intent'));
        return fauxAssistantMessage([fauxToolCall('asset_search',{limit:5}),fauxToolCall('asset_search',{limit:10})]);
      },
      fauxAssistantMessage([fauxToolCall('asset_search',{limit:20}),fauxToolCall('record_fact',{})]),
      fauxAssistantMessage('已保存本地观察，执行受阻。'),
      fauxAssistantMessage('不应继续请求'),
    ]);
    const ctx = runContext(noDB,1,1,'worker');
    let attempts=0,writes=0;
    const activities: RunnerActivity[] = [];
    const runner = await AgentRunner.create({
      cwd:dir, agentDir:dir, inMemory:true, modelRuntime:runtime, model:faux.getModel(),
      platform:{role:'worker',taskID:1,policy:{version:'domain-v1',compaction:'native',mcpLoading:'direct'}},
      systemPrompt:'本地 Worker 工具回归。', toolAllowlist:['asset_search','record_fact'],
      customTools:[
        domainTool({name:'asset_search',description:'本地资产查询',parameters:{type:'object',properties:{limit:{type:'number'}}},transactional:false,
          run:async()=>{attempts++;throw new Error('当前角色无 list_untested_assets 读取或执行权限');}},ctx),
        domainTool({name:'record_fact',description:'保存本地事实',parameters:{type:'object',properties:{}},transactional:false,
          run:async()=>{writes++;return {saved:true};}},ctx),
      ],
      settlementTools:['record_fact','asset_search'], maxTurns:0, maxWrapupTurns:2,
      onActivity:activity=>{activities.push(activity);},
    });
    try {
      const result=await runner.prompt('检查连续工具失败和收尾');
      assert.equal(result.settlementReason,'tool_retries_exhausted');
      assert.equal(attempts,2);
      assert.equal(writes,1);
      assert.equal(faux.state.callCount,3);
      assert.equal(activities.filter(activity=>activity.kind==='host_status'&&activity.phase==='tool_retries_exhausted').length,1);
    } finally {await runner.dispose();}
  } finally {await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
