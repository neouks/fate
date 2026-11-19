import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRuntime,type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {AgentRunner} from './runner.js';

for(const bounded of [false,true])test(`PI 1.5 bounded run patch preserves full context and persisted events (${bounded})`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fate-pi-152-history-'));
 const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
 const faux=fauxProvider({provider:'history-fixture'});await runtime.registerNativeProvider(faux.provider);
 const calls:number[]=[],extensionEnds:any[]=[],nativeEnds:any[]=[];
 const tool:ToolDefinition={name:'local_echo',label:'Local echo',description:'Synthetic local echo',executionMode:'sequential',parameters:{type:'object',properties:{index:{type:'integer'}},required:['index']},
  execute:async(_id,args:any)=>{calls.push(args.index);return {content:[{type:'text',text:`persisted-${args.index}-`+'x'.repeat(512)}],details:{}};}};
 const options={cwd:dir,agentDir:dir,resumeSessionPath:join(dir,'session.jsonl'),modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Local SDK fixture.',toolAllowlist:['local_echo'],customTools:[tool],boundedRunHistory:bounded};
 let runner:AgentRunner|undefined;
 try{
  faux.setResponses([...Array.from({length:25},(_,index)=>fauxAssistantMessage([fauxToolCall('local_echo',{index})])),context=>{
   const results=context.messages.filter(m=>m.role==='toolResult');assert.equal(results.length,25);
   assert.match(JSON.stringify(results),/persisted-0-/);assert.match(JSON.stringify(results),/persisted-24-/);
   return fauxAssistantMessage('completed');
  }]);
  runner=await AgentRunner.create({...options,onRawEvent:event=>{if(event.type==='agent_end')nativeEnds.push(event);},
   extensionFactories:[pi=>{pi.on('agent_end',event=>{extensionEnds.push(event);});}]});
  const result=await runner.prompt('Run 25 local synthetic calls');assert.equal(result.stopReason,'completed');
  assert.deepEqual(calls,Array.from({length:25},(_,i)=>i));
  assert.equal(nativeEnds.length,1);assert.equal(extensionEnds.length,1);
  // One system tool declaration, one user message, 25 call/result pairs, one answer.
  assert.equal(nativeEnds[0].messages.length,bounded?1:53);
  assert.equal(extensionEnds[0].messages.length,bounded?1:53);
  assert.equal(nativeEnds[0].runHistory?.omittedMessages,bounded?52:undefined);
  assert.equal(extensionEnds[0].runHistory?.omittedMessages,bounded?52:undefined);
  assert.equal(runner.sessionEntries.filter(e=>e.type==='message').length,53);
  const ids=runner.sessionEntries.map(e=>e.id);await runner.dispose();runner=undefined;
  runner=await AgentRunner.create(options);
  assert.deepEqual(runner.sessionEntries.slice(0,ids.length).map(e=>e.id),ids);
  assert.match(JSON.stringify(runner.messages),/persisted-0-/);
  assert.match(JSON.stringify(runner.messages),/persisted-24-/);
 }finally{await runner?.dispose();await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});

test('PI restores old sessions with newly enabled tools and honors live revocation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fate-pi-152-restore-'));
 const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
 const faux=fauxProvider({provider:'restore-fixture'});await runtime.registerNativeProvider(faux.provider);
 const options={cwd:dir,agentDir:dir,resumeSessionPath:join(dir,'session.jsonl'),modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Local SDK fixture.'};
 let runner:AgentRunner|undefined,calls=0,enabled=true;
 try{
  faux.setResponses([fauxAssistantMessage('old session')]);runner=await AgentRunner.create({...options,toolAllowlist:[]});
  await runner.prompt('No tools yet');await runner.dispose();runner=undefined;
  const ends:any[]=[];
  runner=await AgentRunner.create({...options,toolAllowlist:['new_lookup'],toolLoading:{version:'lean-tools-v1',initialActive:['new_lookup'],deferred:[],compatibility:[]},
   customTools:[{name:'new_lookup',label:'New lookup',description:'Local lookup',parameters:{type:'object',properties:{}},execute:async()=>{calls++;return {content:[{type:'text',text:'found'}],details:{}};}}],
   guard:async()=>enabled?undefined:{block:true,reason:'revoked'},onActivity:a=>{if(a.kind==='tool_end')ends.push(a);}});
  assert.ok(runner.activeToolNames.includes('new_lookup'));
  faux.setResponses([fauxAssistantMessage([fauxToolCall('new_lookup',{})]),fauxAssistantMessage('found')]);await runner.prompt('Use new tool');assert.equal(calls,1);
  enabled=false;faux.setResponses([fauxAssistantMessage([fauxToolCall('new_lookup',{})]),fauxAssistantMessage('denied')]);await runner.prompt('Check live revocation');
  assert.equal(calls,1);assert.equal(ends.at(-1).isError,true);assert.match(ends.at(-1).text,/revoked/);
 }finally{await runner?.dispose();await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});

test('PI schema coercion validates arguments before executing a domain tool',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fate-pi-152-schema-'));
 const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
 const faux=fauxProvider({provider:'schema-fixture'});await runtime.registerNativeProvider(faux.provider);
 const received:any[]=[],ends:any[]=[];
 const runner=await AgentRunner.create({cwd:dir,agentDir:dir,inMemory:true,modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Synthetic schema fixture.',toolAllowlist:['bounded_value'],
  customTools:[{name:'bounded_value',label:'Value',description:'Validate a bounded integer.',parameters:{type:'object',properties:{value:{type:'integer',minimum:1,maximum:3}},required:['value'],additionalProperties:false},execute:async(_id,args)=>{received.push(args);return {content:[{type:'text',text:'accepted'}],details:{}};}}],onActivity:a=>{if(a.kind==='tool_end')ends.push(a);}});
 try{
  for(const value of ['2','not-an-integer',9]){
   faux.setResponses([fauxAssistantMessage([fauxToolCall('bounded_value',{value})]),fauxAssistantMessage('finished')]);await runner.prompt('Validate fixture');
  }
  assert.deepEqual(received,[{value:2}]);assert.deepEqual(ends.map(e=>e.isError),[false,true,true]);
  assert.match(ends[1].text,/value/);assert.match(ends[2].text,/value/);
 }finally{await runner.dispose();await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});

test('PI successful compaction preserves the persisted original messages',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fate-pi-152-compact-'));
 const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
 const faux=fauxProvider({provider:'compact-fixture'});await runtime.registerNativeProvider(faux.provider);
 const options={cwd:dir,agentDir:dir,resumeSessionPath:join(dir,'session.jsonl'),modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Synthetic compaction fixture.',toolAllowlist:[],platform:{role:'planner',taskID:1,policy:{version:'domain-v1' as const,compaction:'native' as const,mcpLoading:'direct' as const}},compactionSettings:{keepRecentTokens:128,reserveTokens:512}};
 let runner:AgentRunner|undefined;
 try{
  runner=await AgentRunner.create(options);
  faux.setResponses([fauxAssistantMessage('first synthetic record '.repeat(1000)),fauxAssistantMessage('second synthetic record '.repeat(1000)),fauxAssistantMessage('Summary: two synthetic records completed.'),fauxAssistantMessage('Turn prefix: second record.')]);
  await runner.prompt('First');await runner.prompt('Second');
  const original=runner.sessionEntries.filter(e=>e.type==='message').map(e=>e.id);
  await runner.compact();assert.equal(runner.compactionDiagnostics.completed,1);
  assert.deepEqual(runner.sessionEntries.filter(e=>e.type==='message').map(e=>e.id),original);
  assert.ok(runner.sessionEntries.some(e=>e.type==='compaction'));
  await runner.dispose();runner=await AgentRunner.create(options);
  assert.deepEqual(runner.sessionEntries.filter(e=>e.type==='message').map(e=>e.id),original);
  assert.ok(runner.sessionEntries.some(e=>e.type==='compaction'));
  faux.setResponses([context=>{
    const sent=JSON.stringify(context.messages);
    assert.ok(!sent.includes('first synthetic record '.repeat(1000)), 'PI sends the compacted context instead of old full text');
    assert.ok(sent.includes('Summary: two synthetic records completed.'));
    return fauxAssistantMessage('Continued from native summary.');
  }]);
  await runner.prompt('Continue');
  assert.ok(JSON.stringify(runner.sessionEntries).includes('first synthetic record '.repeat(1000)), 'archived raw messages remain exact');
 }finally{await runner?.dispose();await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});

test('PI host retry settles once and abort cancels an in-flight native tool',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fate-pi-152-lifecycle-'));
 const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
 const faux=fauxProvider({provider:'lifecycle-fixture'});await runtime.registerNativeProvider(faux.provider);
 const events:any[]=[],ends:any[]=[];let retries=0,started!:()=>void,cancelled=false;
 const start=new Promise<void>(resolve=>{started=resolve;});
 const runner=await AgentRunner.create({cwd:dir,agentDir:dir,inMemory:true,modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Synthetic lifecycle fixture.',toolAllowlist:['wait_local'],
  modelPolicy:{onResponse:async()=>{},retry:async()=>++retries===1},
  customTools:[{name:'wait_local',label:'Wait',description:'Wait for local cancellation.',parameters:{type:'object',properties:{}},execute:async(_id,_args,signal)=>{started();await new Promise<void>((resolve,reject)=>{const abort=()=>{cancelled=true;reject(new Error('local cancelled'));};if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});});return {content:[],details:{}};}}],
  onActivity:a=>events.push(a),onRawEvent:e=>{if(e.type==='agent_end')ends.push(e);}});
 try{
  faux.setResponses([fauxAssistantMessage('',{stopReason:'error',errorMessage:'503 synthetic transient'}),fauxAssistantMessage('retry succeeded')]);
  const retried=await runner.prompt('Test host retry');assert.equal(retried.lastAssistantText,'retry succeeded');assert.equal(retries,1);
  assert.equal(events.filter(e=>e.kind==='settled').length,1);
  faux.setResponses([fauxAssistantMessage([fauxToolCall('wait_local',{})])]);
  const running=runner.prompt('Test cancellation');await start;await runner.abort();
  const aborted=await running;assert.equal(aborted.aborted,true);assert.equal(cancelled,true);
  assert.equal(events.filter(e=>e.kind==='settled').length,2);assert.ok(ends.length>=2);
 }finally{await runner.dispose();await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});
