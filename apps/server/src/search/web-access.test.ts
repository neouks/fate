import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { AgentRunner } from '../pi/runner.js';
import { webAccessTools } from '../tools/web-access.js';
import { runContext } from '../tools/context.js';
import { WebAccessHost, webAccessRuntime } from './web-access-host.js';
import { WEB_ACCESS_SETTING, updateWebAccessConfig, type WebAccessConfig } from './web-access-config.js';
import type { Database } from '../db/index.js';

const fixtureWorker = new URL('./fixtures/web-access-worker.mjs', import.meta.url);
import {webFixture} from './fixtures/web-fixture.js';
const text=(r:any)=>r.content.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join('\n');
test('native web tools reload credentials, isolate sessions, restore content and enforce live grants', async t=>{
  t.mock.method(webAccessRuntime,'create',(root:string)=>new WebAccessHost(root,fixtureWorker));
  const f=webFixture(),dir=await mkdtemp(join(tmpdir(),'series-web-native-'));
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
  const faux=fauxProvider({provider:'web-integration-fixture'});await runtime.registerNativeProvider(faux.provider);
  const make=async(name:string)=>{
    const tools=webAccessTools(runContext(f.db,0,0,'worker'));
    return AgentRunner.create({cwd:dir,agentDir:dir,resumeSessionPath:join(dir,name+'.jsonl'),modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Synthetic fixtures only.',customTools:tools,toolAllowlist:tools.map(t=>t.name)});
  };
  const call=async(runner:AgentRunner,name:string,args:Record<string,unknown>)=>{
    faux.setResponses([fauxAssistantMessage([fauxToolCall(name,args)]),fauxAssistantMessage('Done')]);await runner.prompt('Run fixture');
    const result=runner.messages.filter(m=>m.role==='toolResult').at(-1)!;assert.equal(result.toolName,name);return result;
  };
  const id=(runner:AgentRunner,type:string)=>{const entry=runner.sessionEntries.filter((e:any)=>e.type==='custom'&&e.customType==='web-search-results'&&e.data.type===type).at(-1) as any;assert.ok(entry);return entry.data.id;};
  let a:AgentRunner|undefined,b:AgentRunner|undefined;
  try{
    a=await make('a');b=await make('b');
    assert.match(text(await call(a,'web_search',{query:'fixture'})),/configuration A/);
    f.settings.set(WEB_ACCESS_SETTING,JSON.stringify({...f.config,keys:{deepseek:'synthetic-after'}}));
    assert.match(text(await call(a,'web_search',{query:'updated fixture'})),/configuration B/);
    assert.equal((await call(a,'fetch_content',{url:'https://93.184.216.34/native-web-fixture',mode:'raw'})).isError,false);
    const responseId=id(a,'fetch');
    const first=await call(a,'get_search_content',{responseId,urlIndex:0,limit:1000});assert.match(text(first),/Paragraph 0/);
    const offset=(first.details as any).nextOffset;assert.ok(offset);
    const second=await call(a,'get_search_content',{responseId,urlIndex:0,offset,limit:1000});assert.notEqual(text(first),text(second));
    assert.equal((await call(b,'get_search_content',{responseId,urlIndex:0})).isError,true);
    await b.dispose();b=undefined;await a.dispose();a=await make('a');
    assert.match(text(await call(a,'get_search_content',{responseId,urlIndex:0,limit:1000})),/Paragraph 0/);
    f.disabled.add('get_search_content');assert.equal((await call(a,'get_search_content',{responseId,urlIndex:0})).isError,true);f.disabled.clear();
    f.settings.set('web_search_enabled','false');assert.equal((await call(a,'web_search',{query:'blocked'})).isError,true);
    f.settings.set('web_search_enabled','true');assert.equal((await call(a,'web_search',{query:'blocked provider',provider:'brave'})).isError,true);
    assert.equal((await call(a,'fetch_content',{url:'/etc/passwd'})).isError,true);
  }finally{await a?.dispose();await b?.dispose();await rm(dir,{recursive:true,force:true});}
});
test('isolated web calls abort without leaving a worker running',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'series-web-abort-')),host=new WebAccessHost(dir,fixtureWorker);
 try{
  const {config}=webFixture(),controller=new AbortController();
  const call=host.call(config,'web_search',{query:'wait forever'},[],controller.signal);
  const timer=setTimeout(()=>controller.abort(),1000);
  await assert.rejects(call);clearTimeout(timer);await host.dispose();
 }finally{await host.dispose();await rm(dir,{recursive:true,force:true});}
});
test('settings accept provider credentials only as text and explicit clears stop fallback',()=>{
 const {config}=webFixture();
 for(const value of ['!run-a-command','$ENV_SECRET'])assert.throws(()=>updateWebAccessConfig(config,{api_keys:{deepseek:value}}));
 const cleared=updateWebAccessConfig(config,{clear_keys:['deepseek'],clear_proxy:true});assert.equal(cleared.keys.deepseek,'');assert.equal(cleared.proxy_configured,true);
 assert.throws(()=>updateWebAccessConfig(config,{sources:['baidu'],default_source:'baidu'}));
});

test('native SearXNG applies platform sites, explicit overrides and live changes without a new schema',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'series-web-sites-')),host=new WebAccessHost(dir,fixtureWorker);
 const config:WebAccessConfig={sources:['searxng'],default_source:'searxng',keys:{},searxng_url:'https://93.184.216.34',proxy:'',domain_filter:['cnblogs.com']};
 const search=async(c:WebAccessConfig,args:Record<string,unknown>={})=>{
  const result=await host.call(c,'web_search',{query:'TypeScript',numResults:3,...args},[]);
  assert.notEqual(result.isError,true,text(result));return text(result);
 };
 try{
  const initial=await search(config);assert.match(initial,/site:cnblogs.com/);assert.match(initial,/https:\/\/cnblogs.com\/fixture/);assert.doesNotMatch(initial,/https:\/\/csdn.net/);
  const override=await search(config,{domainFilter:['csdn.net']});assert.match(override,/site:csdn.net/);assert.doesNotMatch(override,/https:\/\/cnblogs.com/);
  assert.match(await search(config,{domainFilter:[]}),/https:\/\/example.com\/fixture/);
  assert.doesNotMatch(await search({...config,domain_filter:['-cnblogs.com']}),/https:\/\/cnblogs.com/);
  assert.deepEqual(updateWebAccessConfig(config,{domain_filter:[' CNBLOGS.com ','cnblogs.com','-csdn.net']}).domain_filter,['cnblogs.com','-csdn.net']);
  for(const domain_filter of ['cnblogs.com',[123],['https://cnblogs.com'],['cnblogs.com/path'],['a.com?engines=bing'],['*'],Array(21).fill('example.com')])assert.throws(()=>updateWebAccessConfig(config,{domain_filter}));
  assert.deepEqual(updateWebAccessConfig(config,{domain_filter:[]}).domain_filter,[]);
 }finally{await host.dispose();await rm(dir,{recursive:true,force:true});}
});
