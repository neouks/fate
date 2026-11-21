import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateToolArguments} from '@earendil-works/pi-ai';
import {parseToolCallArguments} from '@earendil-works/pi-ai/utils/json-parse';
import {recordFactTool} from './graph.js';
import {insertAssetsTool} from './assets.js';
import {contextGetTool} from './context-read.js';
import {httpRequestTool} from './evidence.js';
import {runContext} from './context.js';
import {normalizeWritebackScope} from './writeback-scope.js';
import {normalizeAssetInput} from '../db/asset-write.js';
import {effectiveToolDescription} from '../agent/tool-descriptions.js';
import {evidenceRequest} from '../evidence/http.js';

const ctx=runContext({} as never,1,1,'worker');
const validate=(tool:ReturnType<typeof recordFactTool>,args:Record<string,any>)=>validateToolArguments(tool,{type:'toolCall',id:'fixture',name:tool.name,arguments:args});

test('scope and IP rules agree between native schema and normalization',()=>{
 const facts=recordFactTool(ctx),assets=insertAssetsTool(ctx);
 for(const tested of ['',' ','\t\n']){
  assert.throws(()=>validate(facts,{summary:'fixture',evidence:'synthetic',scope:{tested}}));
  assert.throws(()=>normalizeWritebackScope({tested}));
 }
 for(const ip of ['192.0.2.1','2001:db8::1','::1']){
  const asset={type:'service',url:'https://example.test',service_ip:ip};
  assert.doesNotThrow(()=>validate(assets,{assets:[asset]}));assert.doesNotThrow(()=>normalizeAssetInput(asset));
 }
 for(const ip of ['example.test','999.1.1.1','2001:::1']){
  const asset={type:'service',url:'https://example.test',service_ip:ip};
  assert.throws(()=>validate(assets,{assets:[asset]}));assert.throws(()=>normalizeAssetInput(asset));
 }
});

test('native evidence references cannot opt into node character paging',()=>{
 const tool=contextGetTool(ctx);
 for(const ref of ['traffic:fixture','output:fixture','attachment:fixture']){
  assert.throws(()=>validate(tool,{items:[{ref,max_chars:100}]}));
  assert.doesNotThrow(()=>validate(tool,{items:[{ref}]}));
 }
 assert.doesNotThrow(()=>validate(tool,{items:[{ref:'node:1',max_chars:100}]}));
});

test('root continuation accepts omitted or empty field without rewriting input',()=>{
 for(const role of ['worker','planner','reporter'] as const){
  const tool=contextGetTool(runContext({} as never,1,1,role));
  assert.equal((tool.parameters as any).properties.items.items.properties.field.default,'');
  for(const field of [undefined,'','/payload/evidence']){
   const args={items:[{ref:'node:39112',view:'detail',version:0,offset:3000,...(field===undefined?{}:{field})}]};
   const before=structuredClone(args);
   assert.doesNotThrow(()=>validate(tool,args));assert.deepEqual(args,before);
  }
 }
});

test('HTTP rejects invalid and undeclared inputs before transport or storage',async()=>{
 const tool=httpRequestTool(ctx);
 for(const args of [{url:'not a URL'},{url:'https://'},{url:'http://?x'},{url:'http:///a'},{url:'file:///tmp/fixture'},{url:'https://example.test',timeout_ms:1},{url:'https://example.test',method:'GET\nBad'}]){
  assert.throws(()=>validate(tool,args));
  await assert.rejects(evidenceRequest(ctx,args));
  const result=await tool.execute('fixture',args,undefined,undefined,{} as never);
  assert.equal(result.isError,true);
  assert.match(JSON.stringify(result),/Validation failed/);
 }
 assert.doesNotThrow(()=>validate(tool,{url:'https://example.test',method:'GET',follow_redirects:false}));
});

test('only known placeholder and old built-in descriptions resolve to current contract',()=>{
 const defaultText=effectiveToolDescription('record_fact','unused','EDITED DESC');
 assert.equal(defaultText.source,'builtin');assert.match(defaultText.description,/facts 数组/);
 assert.deepEqual(effectiveToolDescription('record_fact','unused','My description'),{description:'My description',source:'custom'});
});

test('malformed JSON is retained verbatim and rejected before fact execution',()=>{
 const raw='{"facts":[{"summary":"合成","evidence":"original", {"summary":"bad"}]}';
 const parsed=parseToolCallArguments(raw);
 assert.deepEqual(parsed.arguments,{});assert.ok(parsed.argumentsError?.endsWith(raw));
 assert.throws(()=>validateToolArguments(recordFactTool(ctx),{type:'toolCall',id:'fixture',name:'record_fact',...parsed}),/Invalid arguments/);
});
