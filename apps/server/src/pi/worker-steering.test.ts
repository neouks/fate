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
  }finally{release();await run?.catch(()=>{});await runner.dispose();await rm(dir,{recursive:true,force:true});}
});
