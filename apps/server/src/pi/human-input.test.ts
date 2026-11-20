import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {AgentRunner,type AgentRunnerOptions} from './runner.js';
import {askUserTool,maskedHumanResult,type HumanReply,type HumanPrompt} from './human-input.js';
import {nativeToolActivities} from './native-activity.js';
import {isCoreTool,toolIdentity} from '../agent/tool-registry.js';
import {workerTools,plannerTools,mainTools} from '../tools/index.js';

async function fixture(options:Partial<AgentRunnerOptions>={}){
 const dir=await mkdtemp(join(tmpdir(),'fate-human-input-'));
 const runtime=await ModelRuntime.create({authPath:join(dir,'auth'),modelsPath:join(dir,'models'),refreshOnCreate:false});
 const faux=fauxProvider({provider:'human-input-fixture'});await runtime.registerNativeProvider(faux.provider);
 const pending:{prompt:HumanPrompt;reply:(r:HumanReply)=>void}[]=[];
 const activities:any[]=[];
 const runner=await AgentRunner.create({cwd:dir,agentDir:dir,inMemory:true,modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Local fixture.',
  customTools:[askUserTool()],toolAllowlist:['ask_user'],onActivity:a=>{activities.push(a);},humanInput:(prompt,signal)=>new Promise((resolve,reject)=>{
   const abort=()=>reject(new Error('aborted'));signal.addEventListener('abort',abort,{once:true});
   pending.push({prompt,reply:r=>{signal.removeEventListener('abort',abort);resolve(r);}});
  }),...options});
 return {runner,faux,pending,activities,async close(){await runner.abort();await runner.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}};
}
async function until(check:()=>boolean){for(let n=0;n<200;n++){if(check())return;await delay(10);}throw new Error('Fixture did not reach the expected boundary');}

test('all three task roles expose the native question tool as a resident capability',()=>{
 for(const role of ['worker','planner','mainagent']){assert.equal(isCoreTool(role,'ask_user'),true);}
 for(const factory of [workerTools,plannerTools,mainTools])assert.ok(factory({hooks:{},taskID:1,expID:1} as any).some(t=>t.name==='ask_user'));
 assert.equal(toolIdentity('ask_user').source,'platform');
});

test('phone and OTP resume the original PI tool, with no requests during human wait',{timeout:10000},async()=>{
 const f=await fixture({maxDurationMs:1000,stopOnFinalResponse:true});
 let run:Promise<unknown>|undefined;
 try{
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall('ask_user',{question:'请输入手机号',kind:'input',sensitive:true})]),context=>{
   assert.match(JSON.stringify(context.messages),/13800001234/);
   return fauxAssistantMessage([fauxToolCall('ask_user',{question:'请输入验证码',kind:'input',sensitive:true,timeout_ms:60000})]);
  },context=>{assert.match(JSON.stringify(context.messages),/001234/);return fauxAssistantMessage('已收到');}]);
  run=f.runner.prompt('本地注册样本');await until(()=>f.pending.length===1);
  await delay(1200);assert.equal(f.faux.state.callCount,1);assert.equal(f.runner.phase,'running');
  const other=await fixture();try{other.faux.setResponses([fauxAssistantMessage('独立工作完成')]);await other.runner.prompt('独立样本');assert.equal(other.faux.state.callCount,1);}finally{await other.close();}
  assert.ok(f.pending[0]!.prompt.tool_call_id);assert.equal(f.pending[0]!.prompt.sensitive,true);
  f.pending[0]!.reply({id:'phone',status:'answered',answer:'13800001234'});await until(()=>f.pending.length===2);
  assert.equal(f.pending[1]!.prompt.timeout_ms,60000);f.pending[1]!.reply({id:'otp',status:'answered',answer:'001234'});
  await run;assert.equal(f.faux.state.callCount,3);assert.equal(f.runner.phase,'completed');
  assert.doesNotMatch(JSON.stringify(f.activities),/13800001234|001234/);
  assert.match(JSON.stringify(f.runner.sessionEntries),/13800001234/);
 }finally{await f.close();await run?.catch(()=>{});}
});

test('selection, false confirmation, cancellation, expiration and editor remain distinguishable',{timeout:10000},async()=>{
 for(const [kind,status,answer] of [['select','answered','B'],['confirm','answered',false],['confirm','cancelled',undefined],['input','expired',undefined],['editor','answered','多行\n回答']] as const){
  const f=await fixture();let run:Promise<unknown>|undefined;
  try{
   const prefill=kind==='editor'?'第一行\n原第二行':undefined;
   f.faux.setResponses([fauxAssistantMessage([fauxToolCall('ask_user',{question:'本地问题',kind,...(kind==='select'?{options:['A','B']}:{}),...(prefill?{prefill}:{})})]),context=>{
    const result=context.messages.find(m=>m.role==='toolResult') as any;
    const receipt=JSON.parse(result.content[0].text);assert.equal(receipt.status,status);assert.equal(receipt.answer,answer);return fauxAssistantMessage('结束');
   }]);
   run=f.runner.prompt('测试');await until(()=>f.pending.length===1);assert.equal(f.pending[0]!.prompt.kind,kind);
   if(kind==='editor')assert.equal(f.pending[0]!.prompt.prefill,prefill);
   f.pending[0]!.reply({id:'fixture',status,answer});await run;assert.equal(f.faux.state.callCount,2);
  }finally{await f.close();await run?.catch(()=>{});}
 }
});

test('aborting a waiting execution does not continue after a late answer',{timeout:5000},async()=>{
 const f=await fixture();let run:Promise<unknown>|undefined;
 try{
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall('ask_user',{question:'等待协助',kind:'input'})]),()=>{throw new Error('must not continue');}]);
  run=f.runner.prompt('测试');await until(()=>f.pending.length===1);await f.runner.abort();await run;
  f.pending[0]!.reply({id:'late',status:'answered',answer:'迟到'});await delay(30);assert.equal(f.faux.state.callCount,1);
 }finally{await f.close();await run?.catch(()=>{});}
});

test('answering resumes the remaining execution deadline instead of granting a fresh budget',{timeout:6000},async()=>{
 const f=await fixture({maxDurationMs:800});let run:ReturnType<typeof f.runner.prompt>|undefined;
 try{
  f.faux.setResponses([async()=>{await delay(200);return fauxAssistantMessage([fauxToolCall('ask_user',{question:'等待信息',kind:'input'})]);},
   async(_context,options)=>{await delay(1000,undefined,{signal:options?.signal});return fauxAssistantMessage('不能延长预算');}]);
  run=f.runner.prompt('测试');await until(()=>f.pending.length===1);await delay(1000);
  f.pending[0]!.reply({id:'resume',status:'answered',answer:'信息'});const result=await run;
  assert.equal(result.budgetReason,'duration_limit');assert.equal(result.stopReason,'budget');assert.equal(f.faux.state.callCount,2);
 }finally{await f.close();await run?.catch(()=>{});}
});

test('duration closing starts after active time, never while waiting; closing cannot ask',{timeout:5000},async()=>{
 const f=await fixture({maxDurationMs:800,settlementTools:[],wrapup:()=>({prompt:'结束'}),maxWrapupTurns:1,stopOnFinalResponse:true});
 let run:Promise<unknown>|undefined;
 try{
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall('ask_user',{question:'等待',kind:'input'})]),fauxAssistantMessage('结束')]);
  run=f.runner.prompt('测试');await until(()=>f.pending.length===1);await delay(1000);
  assert.equal(f.runner.phase,'running');assert.equal(f.faux.state.callCount,1);
  f.pending[0]!.reply({id:'ok',status:'answered',answer:'继续'});await run;
  assert.equal(f.faux.state.callCount,2);
 }finally{await f.close();await run?.catch(()=>{});}
 const closing=await fixture({guard:async()=>({block:true,settle:'basis_changed',reason:'收尾'}),settlementTools:[],maxWrapupTurns:1,stopOnFinalResponse:true});
 try{closing.faux.setResponses([fauxAssistantMessage([fauxToolCall('ask_user',{question:'不应弹出',kind:'input'})]),fauxAssistantMessage('结束')]);await closing.runner.prompt('收尾');assert.equal(closing.pending.length,0);}finally{await closing.close();}
});

test('native recovery masks sensitive question results just like live presentation',()=>{
 const result={role:'toolResult',toolName:'ask_user',toolCallId:'call',content:[{type:'text',text:'secret-otp'}],details:{human_input:{id:'q',status:'answered',answer:'secret-otp',sensitive:true}}};
 assert.doesNotMatch(maskedHumanResult(result)!,/secret-otp/);
 assert.doesNotMatch(JSON.stringify(nativeToolActivities(result,{content:[{type:'toolCall',id:'call',name:'ask_user',arguments:{}}]},'r',1)),/secret-otp/);
});
