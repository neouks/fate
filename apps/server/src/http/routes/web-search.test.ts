import assert from 'node:assert/strict';
import {test} from 'node:test';
import Fastify from 'fastify';
import {registerWebSearchRoutes} from './web-search.js';
import {webFixture} from '../../search/fixtures/web-fixture.js';
import {WebAccessHost,webAccessRuntime} from '../../search/web-access-host.js';
import {WEB_ACCESS_SETTING} from '../../search/web-access-config.js';
import {applyToolBindings} from '../../agent/tool-bindings.js';
import {webAccessTools} from '../../tools/web-access.js';
import {runContext} from '../../tools/context.js';

test('platform saves private extension config and tests unsaved input without changing live config',async t=>{
 t.mock.method(webAccessRuntime,'create',(root:string)=>new WebAccessHost(root,new URL('../../search/fixtures/web-access-worker.mjs',import.meta.url)));
 const f=webFixture(),app=Fastify();app.decorate('db',f.db);registerWebSearchRoutes(app);
 const put=(payload:object)=>app.inject({method:'PUT',url:'/api/settings/web-search',payload});
 try{
  assert.equal((await put({web_search_enabled:'true'})).statusCode,400);
  assert.equal((await put({web_search_enabled:true,sources:['baidu'],default_source:'baidu'})).statusCode,400);
  assert.equal((await put({web_search_enabled:true,api_keys:{deepseek:'!shell'}})).statusCode,400);
  let response=await put({web_search_enabled:true,api_keys:{deepseek:'synthetic-after'},agent_roles:['worker']});
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().implementation,'pi-web-access');assert.equal(response.json().keys_set.deepseek,true);assert.doesNotMatch(response.body,/synthetic-after/);
  await put({web_search_enabled:true,api_keys:{deepseek:''}});assert.equal(JSON.parse(f.settings.get(WEB_ACCESS_SETTING)!).keys.deepseek,'synthetic-after');
  const before=f.settings.get(WEB_ACCESS_SETTING);
  response=await app.inject({method:'POST',url:'/api/settings/web-search/test',payload:{query:'test config',api_keys:{deepseek:'synthetic-before'}}});
  assert.equal(response.json().ok,true,response.body);assert.equal(response.json().count,1);assert.equal(response.json().results[0].title,'configuration A');
  assert.equal(f.settings.get(WEB_ACCESS_SETTING),before);assert.doesNotMatch(response.body,/synthetic-before/);
  response=await app.inject({method:'POST',url:'/api/settings/web-search/test',payload:{query:'saved config'}});assert.equal(response.json().results[0].title,'configuration B');
  const tools=webAccessTools(runContext(f.db,0,0,'worker'));assert.equal((await applyToolBindings(f.db,'worker',tools)).length,3);
  await put({web_search_enabled:false});assert.equal((await applyToolBindings(f.db,'worker',tools)).length,0);
  response=await put({web_search_enabled:true,clear_keys:['deepseek']});assert.equal(response.json().ready,false);assert.equal(response.json().keys_set.deepseek,false);
  response=await put({web_search_enabled:true,sources:['searxng'],default_source:'searxng',searxng_url:'https://93.184.216.34',domain_filter:['cnblogs.com']});
  assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json().domain_filter,['cnblogs.com']);
  const saved=f.settings.get(WEB_ACCESS_SETTING);
  response=await app.inject({method:'POST',url:'/api/settings/web-search/test',payload:{query:'TypeScript',domain_filter:['csdn.net']}});
  assert.equal(response.json().ok,true,response.body);assert.match(response.json().results[0].url,/csdn.net/);assert.equal(f.settings.get(WEB_ACCESS_SETTING),saved);
  response=await app.inject({method:'POST',url:'/api/settings/web-search/test',payload:{query:'TypeScript'}});
  assert.match(response.json().results[0].url,/cnblogs.com/);
 }finally{await app.close();}
});
