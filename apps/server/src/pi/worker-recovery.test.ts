import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {buildModelSource} from './providerFromProfile.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {openDatabase} from '../db/index.js';
import {aggregateUsage} from '../db/usage-ledger.js';
import {readWorkerTokenBudget,TOKEN_USAGE_UNCERTAIN,TOKEN_LIMIT_REACHED,WORKER_TOKEN_LIMIT} from '../db/worker-token-budget.js';
import {failureReason,workerStopIsError} from '../engine/worker-outcome.js';
import {AgentRunner} from './runner.js';
import {meterProvider,configureUsageOutbox,closeUsageOutbox} from './usage-meter.js';

test('network failures are errors while explicit controls and domain blockers are not',()=>{
  for(const error of ['terminated: Body Timeout Error (UND_ERR_BODY_TIMEOUT)','Request timed out.: Connect Timeout Error (UND_ERR_CONNECT_TIMEOUT)','Connection error.: read EADDRNOTAVAIL']){
    assert.equal(failureReason(error),'model_connection_error');
    assert.equal(workerStopIsError(failureReason(error)),true);
  }
  for(const reason of ['completed','partial','blocked','task_paused','user_cancelled','planner_terminated','token_limit'] as const)assert.equal(workerStopIsError(reason),false);
  assert.equal(workerStopIsError('token_usage_unknown'),true);
  assert.equal(workerStopIsError('tool_retries_exhausted'),true);
});

const dsn=process.env.TEST_WORKER_RECOVERY_DSN;
test('transient HTTP reads get a bounded recovery opportunity; writes and validation keep their guard',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'tool-recovery-'));
  try{
    for(const scenario of [
      {method:'GET',failures:2,error:'{"error_code":"ECONNRESET"}',stopped:false},
      {method:'GET',failures:3,error:'{"error_code":"ECONNRESET"}',stopped:true},
      {method:'POST',failures:2,error:'{"error_code":"ECONNRESET"}',stopped:true},
      {method:'GET',failures:2,error:'Validation failed: url missing',stopped:true},
    ]){
      const runtime=await ModelRuntime.create({authPath:path.join(dir,'auth'),modelsPath:path.join(dir,'models'),refreshOnCreate:false});
      const faux=fauxProvider({provider:'tool-recovery-fixture'});runtime.registerNativeProvider(faux.provider);
      const call=()=>fauxAssistantMessage([fauxToolCall('http_request',{method:scenario.method})]);
      faux.setResponses([...Array.from({length:scenario.failures},call),...(scenario.stopped?[]:[call()]),fauxAssistantMessage('Saved existing observations.')]);
      let attempts=0;
      const runner=await AgentRunner.create({cwd:dir,agentDir:dir,inMemory:true,modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Local fixture.',
        platform:{role:'worker',taskID:1,policy:{version:'domain-v1',compaction:'native',mcpLoading:'direct'}},
        toolAllowlist:['http_request'],customTools:[{name:'http_request',label:'Local',description:'Fixture',parameters:{type:'object',properties:{method:{type:'string'}}},
          execute:async()=>{attempts++;return {content:[{type:'text',text:attempts<=scenario.failures?scenario.error:'ok'}],details:{},isError:attempts<=scenario.failures};}}],
        settlementTools:['http_request'],stopOnFinalResponse:true,maxWrapupTurns:2,maxTurns:10});
      try{
        const result=await runner.prompt('Use local fixture');
        assert.equal(result.settlementReason,scenario.stopped?'tool_retries_exhausted':undefined,JSON.stringify(scenario));
        assert.equal(attempts,scenario.failures+(scenario.stopped?0:1));
      }finally{await runner.dispose();}
    }
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('failed model calls reserve their ceiling and retry without replaying successful tools',{skip:!dsn&&'isolated PostgreSQL required'},async t=>{
  assert.match(new URL(dsn!).pathname,/^\/test_worker_recovery_[a-z0-9_]+$/);
  process.env.SERIES_PG_DSN=dsn;
  const db=await openDatabase(),dir=await mkdtemp(path.join(tmpdir(),'worker-recovery-'));
  configureUsageOutbox(db,dir);
  t.after(async()=>{await closeUsageOutbox(db);await db.close();await rm(dir,{recursive:true,force:true});});
  const exp=await db.createExploration('local recovery fixture','local');
  const taskID=Number((await db.query("INSERT INTO tasks(exploration_id,description,goal) VALUES($1,'fixture','local') RETURNING id",[exp])).rows[0]!.id);
  const intentID=Number((await db.query("INSERT INTO exploration_nodes(exploration_id,kind) VALUES($1,'intent') RETURNING id",[exp])).rows[0]!.id);
  const profileID=Number((await db.query("INSERT INTO llm_profiles(name,format,model) VALUES('recovery fixture','openai','local') RETURNING id")).rows[0]!.id);
  const scope={taskID,intentID,role:'worker',purpose:'conversation',turnID:'recovery-turn'};
  let calls=0,retries=0,requests=0,transportAssertion:unknown;
  let ceiling=0;
  const server=createServer(async(request,response)=>{
    try{
      for await(const _chunk of request){/* drain fixture request */}
      requests++;
      const row=(await db.query("SELECT usage FROM llm_usage_ledger WHERE task_id=$1 AND status='running'",[taskID])).rows[0]!;
      assert.equal(row.usage._budget_ceiling,ceiling,'reserve must exist before transport starts');
      response.writeHead(200,{'Content-Type':'text/event-stream'});
      const send=(delta:object,finish_reason:string|null=null)=>response.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'local',choices:[{index:0,delta,finish_reason}]})+'\n\n');
      if(requests===2){
        // Drop a real response stream after headers, before any usage receipt.
        response.write('data: '+JSON.stringify({id:'fixture',choices:[{index:0,delta:{role:'assistant',content:'partial'},finish_reason:null}]})+'\n\n',()=>response.destroy());
        return;
      }
      if(requests===1)send({role:'assistant',tool_calls:[{index:0,id:'probe',type:'function',function:{name:'local_probe',arguments:'{}'}}]},'tool_calls');
      else send({role:'assistant',content:'Recovered using existing tool result.'},'stop');
      response.write('data: '+JSON.stringify({id:'fixture',choices:[],usage:{prompt_tokens:100,completion_tokens:10,prompt_tokens_details:{cached_tokens:0}}})+'\n\n');
      response.end('data: [DONE]\n\n');
    }catch(error){transportAssertion=error;response.destroy();}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const source=await buildModelSource({id:profileID,name:'fixture',model:'local',baseURL:`http://127.0.0.1:${address.port}/v1`,apiKey:'fixture',contextWindowK:4,maxTokens:256,streaming:true});
  const {model,modelRuntime:runtime}=source;ceiling=model.contextWindow+model.maxTokens;
  await runtime.registerNativeProvider(meterProvider(db,runtime.getProvider(model.provider)!,{id:profileID,name:'fixture',model:'local'},()=>scope));
  const budget=()=>readWorkerTokenBudget(db,scope,ceiling);
  const runner=await AgentRunner.create({cwd:dir,agentDir:dir,inMemory:true,modelRuntime:runtime,model,systemPrompt:'Local fixture.',
    toolAllowlist:['local_probe'],customTools:[{name:'local_probe',label:'Local',description:'Fixture only',parameters:{type:'object',properties:{}},
      execute:async()=>{calls++;return {content:[{type:'text',text:'saved result'}],details:{}};}}],
    settlementTools:['local_probe'],stopOnFinalResponse:true,maxTurns:10,maxDurationMs:10_000,
    modelPolicy:{workerTokenBudget:budget,onResponse:async()=>{},retry:async()=>++retries===1},
  });
  try{assert.match((await runner.prompt('Run fixture')).lastAssistantText!,/Recovered/);}finally{await runner.dispose();}
  assert.ifError(transportAssertion);assert.equal(calls,1);assert.equal(requests,3);
  const measured=(await aggregateUsage(db,{taskID,intentID}))[0]!;
  assert.equal(measured.unknown_usage_calls,1);assert.equal(measured.usage_complete,false);
  const occupied=(await budget())!;
  assert.equal(occupied.unverifiedReserve,ceiling);
  assert.equal(occupied.used,measured.input_tokens+measured.output_tokens+ceiling);
  const failed=(await db.query("SELECT request_id,audit_id,usage FROM llm_usage_ledger WHERE task_id=$1 AND status='failed'",[taskID])).rows[0]!;
  assert.equal(failed.usage._quality,'unknown');assert.equal(failed.usage.totalTokens,0);
  scope.turnID='resumed';scope.purpose='compaction';
  assert.equal((await budget())!.used,occupied.used,'resume/compaction cannot discard reservation');
  await db.platform().setSetting(WORKER_TOKEN_LIMIT,String(occupied.used));
  const denied=await runtime.completeSimple(model,{messages:[{role:'user',content:'must not reach transport',timestamp:0}]});
  assert.match(denied.errorMessage!,new RegExp(TOKEN_LIMIT_REACHED));
  assert.equal(requests,3,'unknown charges cannot bypass the total budget');
  await db.platform().setSetting(WORKER_TOKEN_LIMIT,'10000000');

  // A partially known receipt only reserves the missing delta, not a second full charge.
  await db.query("UPDATE llm_request_attempts SET usage=usage||'{\"_quality\":\"partial\",\"input\":100,\"output\":10,\"inputTotal\":100,\"_input_total_known\":true}'::jsonb WHERE id=$1",[failed.audit_id]);
  assert.equal((await budget())!.used,occupied.used);
  assert.equal((await budget())!.unverifiedReserve,ceiling-110);
  await db.query("UPDATE llm_request_attempts SET status='running' WHERE id=$1",[failed.audit_id]);
  await assert.rejects(budget,new RegExp(TOKEN_USAGE_UNCERTAIN),'in-flight work still blocks concurrent admission');
  await db.query("UPDATE llm_request_attempts SET status='failed',usage=usage-'_budget_ceiling' WHERE id=$1",[failed.audit_id]);
  await assert.rejects(budget,new RegExp(TOKEN_USAGE_UNCERTAIN),'unbounded historical unknown usage must remain blocked');
  for(const invalid of [-1,0,1.5,'4352',9007199254740992]){
    await db.query("UPDATE llm_request_attempts SET usage=usage||jsonb_build_object('_budget_ceiling',$2::jsonb) WHERE id=$1",[failed.audit_id,JSON.stringify(invalid)]);
    await assert.rejects(budget,new RegExp(TOKEN_USAGE_UNCERTAIN));
  }
  await db.query("UPDATE llm_request_attempts SET usage=usage||jsonb_build_object('_budget_ceiling',$2::bigint,'_quality','complete') WHERE id=$1",[failed.audit_id,ceiling]);
  assert.equal((await budget())!.unverifiedReserve,0,'a completed usage receipt releases the conservative hold');
});
