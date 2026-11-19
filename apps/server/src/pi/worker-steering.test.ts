import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {AgentRunner} from './runner.js';

test('native PI steering reaches the next request after tools finish and honors input handlers',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fate-worker-steering-'));
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
  const faux=fauxProvider({provider:'worker-steering-fixture'});await runtime.registerNativeProvider(faux.provider);
  let started!:()=>void,release!:()=>void,finished=false;
  const toolStarted=new Promise<void>(r=>{started=r;}),gate=new Promise<void>(r=>{release=r;});
  const queues:string[][]=[];
  const runner=await AgentRunner.create({cwd:dir,agentDir:dir,inMemory:true,modelRuntime:runtime,model:faux.getModel(),
    systemPrompt:'Local fixture.',toolAllowlist:['local_wait'],customTools:[{name:'local_wait',label:'Local wait',description:'Local fixture barrier.',parameters:{type:'object',properties:{}},
      execute:async()=>{started();await gate;finished=true;return {content:[{type:'text',text:'done'}],details:{}};}}],
    extensionFactories:[pi=>{pi.on('input',event=>event.text==='handled-by-extension'?{action:'handled'}:undefined);}],
    onActivity:a=>{if(a.kind==='queue_update')queues.push([...a.steering]);}});
  const correction='不要重复 A，只总结 B';
  let run:ReturnType<typeof runner.prompt>|undefined;
  try{
    faux.setResponses([fauxAssistantMessage([fauxToolCall('local_wait',{})]),context=>{
      assert.equal(finished,true);
      const users=context.messages.filter(m=>m.role==='user');
      assert.match(JSON.stringify(users),new RegExp(correction));
      assert.doesNotMatch(JSON.stringify(users),/handled-by-extension/);
      return fauxAssistantMessage('已按纠偏总结 B');
    }]);
    run=runner.prompt('执行本地测试');await toolStarted;
    assert.equal(await runner.steer(correction),'queued');assert.equal(finished,false);
    assert.equal(await runner.steer('handled-by-extension'),'handled');
    assert.ok(queues.some(q=>q.includes(correction)));
    release();const result=await run;
    assert.equal(result.lastAssistantText,'已按纠偏总结 B');
    assert.match(JSON.stringify(runner.sessionEntries),new RegExp(correction));
  }finally{release();await run?.catch(()=>{});await runner.dispose();await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:50});}
});

test('queued correction cannot reopen a Worker after its natural final response',{timeout:5000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fate-final-steering-'));
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
  const faux=fauxProvider({provider:'worker-final-fixture'});await runtime.registerNativeProvider(faux.provider);
  let started!:()=>void,release!:()=>void;
  const ready=new Promise<void>(r=>{started=r;}),gate=new Promise<void>(r=>{release=r;});
  const statuses:string[]=[];
  const runner=await AgentRunner.create({cwd:dir,agentDir:dir,inMemory:true,modelRuntime:runtime,model:faux.getModel(),
    systemPrompt:'Local fixture',toolAllowlist:[],stopOnFinalResponse:true,
    onActivity:a=>{if(a.kind==='host_status')statuses.push(a.phase);}});
  let run:ReturnType<typeof runner.prompt>|undefined;
  try{
    faux.setResponses([async()=>{started();await gate;return fauxAssistantMessage('本方向已完成');},()=>{throw new Error('must not reopen completed Worker');}]);
    run=runner.prompt('检查本地样本');await ready;
    assert.equal(await runner.steer('queued-new-work'),'queued');
    assert.equal(await runner.followUp('queued-follow-up'),'queued');
    release();const result=await run;
    assert.equal(result.stopReason,'completed');assert.equal(result.aborted,false);
    assert.equal(result.lastAssistantText,'本方向已完成');assert.equal(faux.state.callCount,1);
    assert.equal(runner.phase,'completed');assert.ok(statuses.includes('steering_discarded'));
    assert.doesNotMatch(JSON.stringify(runner.sessionEntries),/queued-new-work|queued-follow-up/);
    await assert.rejects(runner.steer('late correction'),{statusCode:409});
  }finally{release();await run?.catch(()=>{});await runner.dispose();await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:50});}
});

test('closing rejects steering and follow-up, clears pending work and permits saved-record writeback',{timeout:5000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fate-closing-steering-'));
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
  const faux=fauxProvider({provider:'worker-closing-fixture'});await runtime.registerNativeProvider(faux.provider);
  let closeReady!:()=>void,release!:()=>void;
  const ready=new Promise<void>(r=>{closeReady=r;}),gate=new Promise<void>(r=>{release=r;});
  let firstReady!:()=>void,releaseFirst!:()=>void;
  const first=new Promise<void>(r=>{firstReady=r;}),firstGate=new Promise<void>(r=>{releaseFirst=r;});
  let operations=0,saves=0;
  const runner=await AgentRunner.create({cwd:dir,agentDir:dir,inMemory:true,modelRuntime:runtime,model:faux.getModel(),
    systemPrompt:'Local fixture',stopOnFinalResponse:true,toolAllowlist:['local_operation','local_save'],settlementTools:['local_save'],maxWrapupTurns:2,
    customTools:[{name:'local_operation',label:'Local operation',description:'Fixture',parameters:{type:'object',properties:{}},
      execute:async()=>{operations++;return {content:[{type:'text',text:'executed'}],details:{}};}},
    {name:'local_save',label:'Local save',description:'Fixture',parameters:{type:'object',properties:{}},
      execute:async()=>{saves++;return {content:[{type:'text',text:'saved fact and finding'}],details:{}};}}],
    guard:async g=>g.toolName==='local_operation'?{block:true,settle:'basis_changed',reason:'Fixture basis changed'}:undefined,
  });
  let run:ReturnType<typeof runner.prompt>|undefined;
  try{
    faux.setResponses([async()=>{firstReady();await firstGate;return fauxAssistantMessage([fauxToolCall('local_operation',{})]);},async context=>{
      closeReady();await gate;
      assert.doesNotMatch(JSON.stringify(context.messages),/late-new-work/);
      return fauxAssistantMessage([fauxToolCall('local_save',{})]);
    },fauxAssistantMessage('已保存并结束')]);
    run=runner.prompt('检查本地样本');await first;
    assert.equal(await runner.steer('late-new-work'),'queued');releaseFirst();await ready;
    assert.equal(runner.phase,'closing');
    await assert.rejects(runner.steer('late-new-work'),{statusCode:409});
    await assert.rejects(runner.followUp('late-new-work'),{statusCode:409});
    release();const result=await run;
    assert.equal(result.settlementReason,'basis_changed');
    assert.equal(operations,0);assert.equal(saves,1);assert.equal(faux.state.callCount,3);
  }finally{releaseFirst();release();await run?.catch(()=>{});await runner.dispose();await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:50});}
});

test('an awaiting native input handler cannot enqueue new work after completion',{timeout:5000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fate-input-race-'));
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
  const faux=fauxProvider({provider:'worker-input-race'});await runtime.registerNativeProvider(faux.provider);
  let requestReady!:()=>void,releaseRequest!:()=>void,inputReady!:()=>void,releaseInput!:()=>void;
  const requested=new Promise<void>(r=>{requestReady=r;}),requestGate=new Promise<void>(r=>{releaseRequest=r;});
  const entered=new Promise<void>(r=>{inputReady=r;}),inputGate=new Promise<void>(r=>{releaseInput=r;});
  const runner=await AgentRunner.create({cwd:dir,agentDir:dir,inMemory:true,modelRuntime:runtime,model:faux.getModel(),
    systemPrompt:'Local fixture',toolAllowlist:[],stopOnFinalResponse:true,
    extensionFactories:[pi=>{pi.on('input',async event=>{if(event.text==='late-input'){inputReady();await inputGate;}});}],
  });
  let run:ReturnType<typeof runner.prompt>|undefined;
  try{
    faux.setResponses([async()=>{requestReady();await requestGate;return fauxAssistantMessage('正常结束');}]);
    run=runner.prompt('检查本地样本');await requested;
    const rejected=assert.rejects(runner.steer('late-input'),{statusCode:409});await entered;
    releaseRequest();assert.equal((await run).stopReason,'completed');
    releaseInput();await rejected;
    assert.equal(faux.state.callCount,1);assert.doesNotMatch(JSON.stringify(runner.sessionEntries),/late-input/);
  }finally{releaseRequest();releaseInput();await run?.catch(()=>{});await runner.dispose();await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:50});}
});
