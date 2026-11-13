import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {buildModelSource,testProfileConnection,type ProfileLike} from './providerFromProfile.js';
import {profilePolicy,validateProfilePolicy} from './profile-policy.js';
import {classifyModelError,retryRule} from './retry-policy.js';
const base:ProfileLike={id:990,name:'synthetic',model:'deepseek-flash',baseURL:'http://127.0.0.1',apiKey:'synthetic-only',contextWindowK:0,maxTokens:0};
const context={systemPrompt:'Local synthetic fixture',messages:[{role:'user' as const,content:'ping',timestamp:1}]};
async function fixture<T>(fn:(url:string,requests:Record<string,any>[])=>Promise<T>){
 const requests:Record<string,any>[]=[];
 const server=createServer(async(req,res)=>{let text='';for await(const part of req)text+=part;const body=JSON.parse(text);requests.push(body);
  if(body.stream===false){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'local',object:'chat.completion',model:'deepseek-flash',choices:[{index:0,message:{role:'assistant',content:'pong',reasoning_content:'synthetic'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:2,total_tokens:4}}));}
  else {res.statusCode=400;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:{type:'invalid_request_error',message:'local capture complete'}}));}
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{return await fn(`http://127.0.0.1:${(server.address() as {port:number}).port}`,requests);}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
}
for(const format of ['openai','anthropic','openai-responses'])test(`${format}: native pi preserves DeepSeek off/max/default and request caps`,async()=>fixture(async(url,requests)=>{
 for(const [thinkingType,reasoningEffort,wanted] of [['disabled','high','off'],['enabled','max','max'],['enabled','medium','high'],['medium','','high'],['','','default']] as const){
  const s=await buildModelSource({...base,format,baseURL:url,thinkingType,reasoningEffort});
  await s.modelRuntime.completeSimple(s.model,context,{...(s.thinkingLevel!=='off'?{reasoning:s.thinkingLevel}:{}),maxTokens:2048});
  const wire=requests.at(-1)!;assert.ok(wire);
  assert.equal(wire[format==='openai-responses'?'max_output_tokens':'max_tokens'],2048);
  if(wanted==='default'){for(const k of ['thinking','reasoning','reasoning_effort','output_config'])assert.equal(wire[k],undefined);}
  else if(format==='openai-responses')assert.equal(wire.reasoning.effort,wanted==='off'?'none':wanted);
  else {assert.equal(wire.thinking.type,wanted==='off'?'disabled':'enabled');assert.equal(format==='anthropic'?wire.output_config?.effort:wire.reasoning_effort,wanted==='off'?undefined:wanted);assert.equal(wire.thinking.budget_tokens,undefined);}
 }
 const s=await buildModelSource({...base,baseURL:url,format,reasoningEffort:'max'});
 await s.modelRuntime.completeSimple(s.model,context,{maxTokens:256});const wire=requests.at(-1)!;
 if(format==='openai-responses')assert.equal(wire.reasoning.effort,'none');else assert.equal(wire.thinking.type,'disabled');
}));
test('zero DeepSeek output limit omitted on all protocols; smaller request stays bounded',async()=>fixture(async(url,requests)=>{
 for(const format of ['openai','anthropic','openai-responses']){
  const s=await buildModelSource({...base,baseURL:url,format,thinkingType:'enabled'});
  await s.modelRuntime.completeSimple(s.model,context,{reasoning:s.thinkingLevel as 'high'});
  for(const name of ['max_tokens','max_completion_tokens','max_output_tokens'])assert.equal(requests.at(-1)![name],undefined);
 }
 const s=await buildModelSource({...base,baseURL:url,maxTokens:10000});
 await s.modelRuntime.completeSimple(s.model,context,{maxTokens:1024});assert.equal(requests.at(-1)!.max_tokens,1024);
}));
test('connection test uses runtime thinking and non-stream transport',async()=>fixture(async(url,requests)=>{
 const result=await testProfileConnection({...base,baseURL:url,streaming:false,thinkingType:'enabled',reasoningEffort:'max',maxTokens:2000});
 assert.equal(result.ok,true,result.error);assert.equal(result.reply,'pong');
 assert.equal(requests[0]!.thinking.type,'enabled');assert.equal(requests[0]!.reasoning_effort,'max');assert.equal(requests[0]!.stream,false);assert.equal(requests[0]!.max_tokens,2000);
}));
test('validation/default/legacy policy',()=>{
 assert.equal(profilePolicy(base).contextWindow,128000);assert.equal(profilePolicy({...base,thinkingType:'medium'}).effort,'high');
 assert.equal(profilePolicy({...base,thinkingType:'disabled',reasoningEffort:'max'}).level,'off');
 for(const patch of [{contextWindowK:-1},{contextWindowK:NaN},{maxTokens:131073},{thinkingType:'bogus'},{reasoningEffort:'extreme'},{sessionHeaderKey:'Authorization'},{proxy:'socks5://localhost:1080'},{format:'anthropic',maxTokensField:'max_completion_tokens'}])assert.throws(()=>validateProfilePolicy({...base,...patch}));
});
test('retry rejects deterministic errors and honors disabled/interval settings',()=>{
 for(const status of [400,401,402,403,404,413,422])assert.equal(classifyModelError(`${status}: synthetic`).transient,false);
 for(const status of [408,409,429,500,502,503,504])assert.equal(classifyModelError(`${status}: synthetic`).transient,true);
 assert.equal(classifyModelError('fetch failed').transient,true);assert.equal(classifyModelError('unknown rejection').transient,false);
 assert.equal(retryRule({attempts:-1}).attempts,0);assert.equal(retryRule({}, {attempts:-1}).attempts,0);
 assert.equal(retryRule({interval_ms:60000}).delay(1),60000);assert.equal(retryRule().delay(20),4000);
});
