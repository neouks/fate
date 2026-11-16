import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ModelRuntime,type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AgentRunner,type RunnerActivity} from './runner.js';
import {openDatabase} from '../db/index.js';
import {WorkerOperationJournal,readOperations,OperationUncertainError} from '../db/operation-journal.js';
import {interruption,interruptionText} from '../db/operation-interruption.js';
import {runContext} from '../tools/context.js';
import {journalTools} from './operation-tools.js';

test('interruption diagnostics distinguish host cancellation, exceptions and receipt failure',()=>{
 const controller=new AbortController();controller.abort('pause');
 const detail=interruption(new Error('命令已取消'),'tool_execution',controller.signal);
 assert.equal(detail.reason,'pause');
 assert.match(interruptionText(1,detail,false),/任务暂停.*工具执行中/);
 assert.match(interruptionText(1,detail,true),/执行前被拦截，未执行/);
 assert.equal(interruption(new Error('disk full'),'receipt_persistence').reason,'receipt_error');
 assert.equal(interruption(new Error('exception'),'tool_execution').reason,'exception');
 const generic=new AbortController();generic.abort();
 assert.equal(interruption('cancelled','tool_execution',generic.signal).reason,'aborted');
});

const dsn=process.env.TEST_OPERATION_INTERRUPTION_DSN;
test('local synthetic operations retain interruption causes and block without replay', {skip:!dsn&&'requires isolated PostgreSQL'},async t=>{
 assert.match(new URL(dsn!).pathname,/^\/test_[a-z0-9_]+$/);process.env.SERIES_PG_DSN=dsn;
 const db=await openDatabase();t.after(()=>db.close());
 const task=(await db.query(`WITH e AS (INSERT INTO explorations(goal) VALUES ('synthetic interruption') RETURNING id)
  INSERT INTO tasks(description,goal,exploration_id) SELECT 'synthetic','synthetic',id FROM e RETURNING id,exploration_id`)).rows[0]!;
 const make=async()=>{
  const intent=(await db.query("INSERT INTO exploration_nodes(exploration_id,kind,state,owner) VALUES ($1,'intent','running','work#1') RETURNING id",[task.exploration_id])).rows[0]!;
  const control=new AbortController(),ctx=runContext(db,Number(task.id),Number(task.exploration_id),'worker',{intentID:Number(intent.id),workerName:'work#1',signal:control.signal});
  const journal=new WorkerOperationJournal(ctx);await journal.start();return {ctx,journal,control};
 };
 const tool=(execute:ToolDefinition['execute'])=>({name:'bash',label:'local synthetic',description:'no network',parameters:{type:'object',properties:{}},execute} as ToolDefinition);
 const call=(wrapped:ToolDefinition,id:string)=>wrapped.execute(id,{},undefined,undefined,{} as never);
 await t.test('pause retains original error and rejects a resumed command before execution',async()=>{
  const {ctx,journal,control}=await make();let executions=0;
  const wrapped=journalTools(journal,ctx,new Set(['bash']))(tool(async()=>{executions++;control.abort('pause');throw new Error('命令已取消');}));
  await assert.rejects(call(wrapped,'original'),/任务暂停.*工具执行中/);
  const op=(await readOperations(ctx)).items[0]!;
  assert.equal(op.status,'uncertain');assert.equal(op.interruption?.reason,'pause');
  assert.equal(op.interruption?.message,'命令已取消');
  const second=new WorkerOperationJournal(ctx);await second.start();
  const blocked=journalTools(second,ctx,new Set(['bash']))(tool(async()=>{executions++;return {content:[],details:undefined};}));
  await assert.rejects(call(blocked,'new'),e=>e instanceof OperationUncertainError&&/本次工具调用在执行前被拦截，未执行/.test(e.message)&&/任务暂停/.test(e.message));
  assert.equal(executions,1);assert.equal((await readOperations(ctx)).items.length,1);
  assert.equal((await db.query('SELECT count(*) FROM worker_operation_resolutions')).rows[0]!.count,'0');
 });
 await t.test('receipt persistence failure differs from an execution exception',async()=>{
  const {ctx,journal}=await make();let executions=0;
  journal.finish=async()=>{throw new Error('synthetic receipt failure');};
  const wrapped=journalTools(journal,ctx,new Set(['bash']))(tool(async()=>{executions++;return {content:[{type:'text',text:'local result'}],details:undefined};}));
  await assert.rejects(call(wrapped,'receipt'),/工具已返回，保存结果时失败/);
  const op=(await readOperations(ctx)).items[0]!;
  assert.equal(op.interruption?.reason,'receipt_error');assert.equal(op.interruption?.phase,'receipt_persistence');assert.equal(executions,1);
 });
 await t.test('native tool result exposes the detailed cause as an error without retry',async()=>{
  const {ctx,journal,control}=await make();let executions=0;
  const dir=await mkdtemp(join(tmpdir(),'fate-interruption-native-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
  const faux=fauxProvider({provider:'interruption-local'});runtime.registerNativeProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxToolCall('synthetic_effect',{})]),fauxAssistantMessage('Saved error; do not replay.')]);
  const synthetic={...tool(async()=>{executions++;control.abort('pause');throw new Error('original cancellation');}),name:'synthetic_effect'};
  const activities:RunnerActivity[]=[];
  const runner=await AgentRunner.create({cwd:dir,agentDir:dir,modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Local synthetic test',
    customTools:[synthetic],toolAllowlist:[synthetic.name],wrapExecutionTool:journalTools(journal,ctx,new Set([synthetic.name])),onActivity:a=>{activities.push(a);}});
  try{await runner.prompt('Execute fixture once.');}finally{await runner.dispose();}
  const results=activities.filter((a):a is Extract<RunnerActivity,{kind:'tool_end'}>=>a.kind==='tool_end');
  assert.equal(results.length,1);assert.equal(results[0]!.isError,true);assert.match(results[0]!.text!,/任务暂停.*工具执行中/);
  assert.match(results[0]!.text!,/original cancellation/);assert.equal(executions,1);
 });
 await t.test('historical reason is linked by operation reference and read without rewriting history',async()=>{
  const {ctx,journal}=await make();const receipt=await journal.begin('bash','historical',{});await journal.uncertain(receipt.id);
  const before=(await db.query('SELECT * FROM worker_operations WHERE id=$1',[receipt.id])).rows;
  const insert=async(ref:string,reason:string)=>(await db.query(`INSERT INTO activity(exploration_id,node_id,kind,worker,summary,metadata)
    VALUES($1,$2,'result','work#1','historical',$3::jsonb) RETURNING id`,[ctx.expID,ctx.intentID,JSON.stringify({execution_stop:{reason,summary:'任务已暂停',recorded_at:new Date().toISOString(),operations:[{ref}]}})])).rows[0]!.id;
  await insert('operation:999999','service_shutdown');
  const activityID=await insert('operation:'+receipt.id,'task_paused');
  const read=await readOperations(ctx,{id:receipt.id});
  assert.equal(read.items[0]!.interruption?.reason,'task_paused');assert.equal(read.items[0]!.interruption?.source,'activity');
  assert.equal(read.items[0]!.interruption?.activity_ref,'activity:'+activityID);assert.equal(read.items[0]!.result,null);
  assert.deepEqual((await db.query('SELECT * FROM worker_operations WHERE id=$1',[receipt.id])).rows,before);
  const other=await make();assert.deepEqual((await readOperations(other.ctx,{id:receipt.id})).items,[]);
 });
 await t.test('missing historical evidence stays unknown and diagnostic persistence errors retain the original failure',async()=>{
  const {ctx,journal}=await make();const receipt=await journal.begin('bash','missing',{});await journal.uncertain(receipt.id);
  assert.equal((await readOperations(ctx,{id:receipt.id})).items[0]!.interruption?.reason,'unknown');
  const fresh=await make();fresh.journal.uncertain=async()=>{throw new Error('diagnostics unavailable');};
  const wrapped=journalTools(fresh.journal,fresh.ctx,new Set(['bash']))(tool(async()=>{throw new Error('original exception');}));
  await assert.rejects(call(wrapped,'failure'),/original exception[\s\S]*中断说明保存失败：diagnostics unavailable/);
 });
});
