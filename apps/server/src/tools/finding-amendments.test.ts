import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../db/index.js';
import {runContext} from './context.js';
import {reportFindingTool} from './findings.js';
import {findingSimilarity,mergeFindingReproduction} from './finding-amendments.js';
import {recordExchange} from '../evidence/store.js';
import {TriggerScheduler,findingWriteChanged} from '../engine/triggers.js';
import {AgentRunner} from '../pi/runner.js';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';

test('similarity is only a review hint and reproduction supplements preserve old steps',()=>{
  assert.ok(findingSimilarity('未登录访问合成订单接口可以读取订单详细信息','未登录访问合成订单接口可以读取订单详细信息，补充资产')>.72);
  const step={id:'first',action:'读取合成记录',request:'request',response:'response',proves:'fixture',expected:''};
  const old={entry_point:'/fixture',prerequisites:[],provenance:'原证据',steps:[step]};
  assert.equal(mergeFindingReproduction(old,{...old,steps:[{...step,id:'different'}]})!.steps.length,1);
  assert.throws(()=>mergeFindingReproduction(old,{...old,steps:[{...step,response:'changed'}]}),/ID.*冲突/);
  assert.equal(old.steps[0]!.response,'response');
  assert.equal(findingWriteChanged(JSON.stringify({created:false,updated:true})),true);
  for(const receipt of [{duplicate:true},{replayed:true,updated:true},{created:false,updated:false}])assert.equal(findingWriteChanged(JSON.stringify(receipt)),false);
  assert.equal(findingWriteChanged('{"finding_id":1}'),true,'legacy successful writes retain their triggers');
});

const dsn=process.env.TEST_FINDING_AMENDMENTS_DSN;
test('finding supplement, deduplication, version races, recovery and native pi protocol', {skip:!dsn&&'isolated PostgreSQL required'},async t=>{
  assert.match(new URL(dsn!).pathname,/^\/test_[a-z0-9_]+$/);
  process.env.SERIES_PG_DSN=dsn;
  let db=await openDatabase();
  t.after(()=>db.close());
  const directory=await mkdtemp(join(tmpdir(),'fate-finding-amendment-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const exp=await db.createExploration('synthetic','synthetic');
  const task=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id) VALUES('synthetic','synthetic',$1) RETURNING id",[exp])).rows[0]!.id);
  const createWorker=async(label:string)=>{
    const intent=await db.exploration(exp).addNode('intent',{summary:label},0,'running','fixture',[]);
    await db.query('UPDATE exploration_nodes SET owner=$2 WHERE id=$1',[intent,label]);
    return {intent,label};
  };
  const worker=await createWorker('fixture-worker');
  const tool=()=>reportFindingTool(runContext(db,task,exp,'worker',{intentID:worker.intent,workerName:worker.label}));
  const invoke=async(args:Record<string,unknown>,call=randomUUID(),entry=tool())=>{
    const result=await entry.execute(call,args,undefined,undefined,{} as never);
    return {error:result.isError===true,...JSON.parse((result.content[0] as {text:string}).text)};
  };
  const asset=async(path:string)=>{
    const id=Number((await db.query("INSERT INTO assets(type,url,method) VALUES('endpoint',$1,'GET') RETURNING id",['https://fixture.test/'+path])).rows[0]!.id);
    await db.query('INSERT INTO task_asset_links(task_id,asset_id) VALUES($1,$2)',[task,id]);return id;
  };
  const a=await asset('a'),b=await asset('b'),c=await asset('c');
  const base={vulnclass:'合成权限缺陷',summary:'未登录访问合成订单接口可以读取订单详细信息',severity:'high',evidence:'本地固定证据：expected hidden; actual fixture order',scope:{tested:'本地合成访问验证'}};
  const saved=await invoke(base,'create');assert.equal(saved.error,false,JSON.stringify(saved));assert.equal(saved.created,true);
  const id=saved.finding_id,node=saved.finding_node_id;
  assert.equal(saved.writeback.coverage_eligible,false);
  const duplicate=await invoke({...base,asset_ids:[a]},'repeat-new-id');
  assert.equal(duplicate.duplicate,true);assert.equal(duplicate.finding_id,id);assert.equal(duplicate.changes_applied,false);
  const similar=await invoke({...base,summary:base.summary+'，补充资产',evidence:'改写后的第二段本地证据，与原报洞不同',asset_ids:[a]},'similar');
  assert.equal(similar.code,'FINDING_DUPLICATE_REVIEW');assert.equal(similar.candidates[0].finding_id,id);
  assert.equal((await db.query('SELECT count(*) n FROM findings WHERE task_id=$1',[task])).rows[0]!.n,'1');

  await db.query("UPDATE findings SET report='old report',report_evidence_version=evidence_version,status='confirmed' WHERE id=$1",[id]);
  const scheduler=new TriggerScheduler(db);await scheduler.tick();
  const traffic=await recordExchange(db,{taskID:task,intentID:worker.intent,url:'https://fixture.test/a',method:'GET',status:200,
    reqHead:'GET /a HTTP/1.1\r\nHost: fixture.test',respHead:'HTTP/1.1 200 OK\r\nContent-Type: text/plain',request:Buffer.alloc(0),response:Buffer.from('local fixture')});
  const amend={finding_id:id,evidence_version:saved.evidence_version,asset_ids:[a,a],evidence:'第二条本地证据',traffic_refs:[{traffic_id:traffic}],
    reproduction:{entry_point:'https://fixture.test/a',steps:[{id:'saved-step',action:'读取合成资料',request:'',response:'',proves:'仅合成证据',traffic_id:traffic}]}};
  const changed=await invoke(amend,'supplement');assert.equal(changed.error,false,JSON.stringify(changed));assert.equal(changed.updated,true);assert.equal(changed.finding_id,id);assert.deepEqual(changed.asset_ids,[a]);
  assert.equal(changed.evidence_version,saved.evidence_version+1,'one version per atomic supplement');
  assert.equal(changed.writeback.coverage_eligible,true);
  const row=async()=>(await db.query('SELECT * FROM findings WHERE id=$1',[id])).rows[0]!;
  const updated=await row();assert.equal(updated.status,'confirmed');assert.equal(updated.evidence,base.evidence+'\n\n第二条本地证据');
  assert.equal(updated.report,'old report');assert.notEqual(updated.report_evidence_version,updated.evidence_version);
  assert.match((updated.reproduction as any).steps[0].response,/HTTP\/1.1 200 OK/);
  assert.equal((await db.query('SELECT count(*) n FROM finding_report_versions WHERE finding_id=$1',[id])).rows[0]!.n,'1');
  assert.equal((await db.query('SELECT count(*) n FROM exploration_anchors WHERE node_id=$1',[node])).rows[0]!.n,'1');
  assert.equal((await db.query('SELECT payload FROM exploration_nodes WHERE id=$1',[node])).rows[0]!.payload.from_intent,worker.intent);
  const nochange=await invoke({...amend,evidence_version:changed.evidence_version},'noop');assert.equal(nochange.updated,false);assert.equal(nochange.evidence_version,changed.evidence_version);
  await scheduler.tick();await scheduler.tick();
  const eventKey=`finding:${node}:evidence:${changed.evidence_version}`;
  assert.equal((await db.query('SELECT count(*) n FROM agent_trigger_events WHERE event_key=$1',[eventKey])).rows[0]!.n,'0','supplementing evidence does not start a report by default');
  assert.equal((await db.query('SELECT count(*) n FROM finding_evidence_amendments WHERE finding_id=$1',[id])).rows[0]!.n,'1');

  await db.close();db=await openDatabase();
  const replay=await invoke(amend,'supplement');assert.equal(replay.replayed,true);assert.equal(replay.evidence_version,changed.evidence_version);
  assert.match((await invoke({...amend,asset_ids:[b]},'supplement')).error,/调用编号/);
  const race=await Promise.all([invoke({finding_id:id,evidence_version:changed.evidence_version,asset_ids:[b]},'race-1'),invoke({finding_id:id,evidence_version:changed.evidence_version,asset_ids:[c]},'race-2')]);
  assert.equal(race.filter(r=>r.updated===true).length,1);assert.equal(race.filter(r=>r.code==='FINDING_VERSION_CONFLICT').length,1);
  const version=Number((await row()).evidence_version);
  const invalid=await invoke({finding_id:id,evidence_version:version,asset_ids:[b,c],evidence:'must rollback',traffic_refs:[{traffic_id:randomUUID()}]},'invalid');
  assert.ok(invalid.error);assert.equal(Number((await row()).evidence_version),version);assert.ok(!String((await row()).evidence).includes('must rollback'));
  const ownerless=await invoke({finding_id:id,evidence_version:version,summary:'changed issue',asset_ids:[a]},'bad-summary');assert.match(ownerless.error,/summary/);
  const otherExp=await db.createExploration('other','other'),otherTask=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id) VALUES('other','other',$1) RETURNING id",[otherExp])).rows[0]!.id);
  const otherIntent=await db.exploration(otherExp).addNode('intent',{summary:'other'},0,'running','fixture',[]);
  await db.query("UPDATE exploration_nodes SET owner='other' WHERE id=$1",[otherIntent]);
  const other=reportFindingTool(runContext(db,otherTask,otherExp,'worker',{intentID:otherIntent,workerName:'other'}));
  assert.equal((await invoke({finding_id:id,evidence_version:version,asset_ids:[a]},'cross-task',other)).code,'FINDING_NOT_WRITABLE');
  assert.ok((await invoke({...base},'planner',reportFindingTool(runContext(db,task,exp,'planner')))).error);
  const distinctAsset=await asset('unrelated');
  const distinct=await invoke({...base,asset_ids:[distinctAsset]},'independent');assert.equal(distinct.created,true,'same title on disjoint resources is allowed');

  const another=await createWorker('second-worker');
  const anotherTool=reportFindingTool(runContext(db,task,exp,'worker',{intentID:another.intent,workerName:another.label}));
  const independentBase={...base,vulnclass:'并发合成类型',asset_ids:[a]};
  const simultaneous=await Promise.all([invoke(independentBase,'new-one'),invoke(independentBase,'new-two',anotherTool)]);
  assert.equal(simultaneous.filter(r=>r.created===true).length,1);
  assert.equal(simultaneous.filter(r=>r.duplicate===true).length,1);
  assert.equal(new Set(simultaneous.map(r=>r.finding_id)).size,1);
  const suspected={...independentBase,summary:base.summary+'，另一独立机理',evidence:'不同的本地合成证据'};
  const review=await invoke(suspected,'review-distinct',anotherTool);assert.equal(review.code,'FINDING_DUPLICATE_REVIEW');
  const newIssue=await invoke({...suspected,distinct_from:[simultaneous[0].finding_id],distinct_reason:'独立合成权限分支，与已有入口不同'},'confirm-distinct',anotherTool);
  assert.equal(newIssue.created,true);
  // No receipt means a historical call. Existing call-ID idempotency stays compatible.
  await db.query('DELETE FROM finding_write_receipts WHERE task_id=$1 AND call_id=$2',[task,'independent']);
  assert.equal((await invoke({...base,asset_ids:[distinctAsset]},'independent')).finding_id,distinct.finding_id);

  // Real native pi validates the alternative schemas; no model network requests.
  const faux=fauxProvider({provider:'finding-amendment'});
  const runtime=await ModelRuntime.create({authPath:join(directory,'auth.json'),modelsPath:join(directory,'models.json'),refreshOnCreate:false});
  runtime.registerNativeProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxToolCall('report_finding',{finding_id:id,evidence_version:version,asset_ids:[b,c]})]),fauxAssistantMessage('已补正原记录')]);
  const runner=await AgentRunner.create({cwd:directory,agentDir:directory,inMemory:true,modelRuntime:runtime,model:faux.getModel(),
    systemPrompt:'仅处理本地合成记录，补充已有漏洞资产。',customTools:[tool()],toolAllowlist:['report_finding'],maxTurns:3,maxDurationMs:10000});
  try{await runner.prompt('补充已有漏洞，不创建新漏洞');}finally{await runner.dispose();}
  assert.deepEqual((await row()).asset_ids,[a,b,c]);
  assert.equal((await db.query('SELECT count(*) n FROM findings WHERE task_id=$1',[task])).rows[0]!.n,'4');
});
