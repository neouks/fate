import { publicTransport } from './public-web.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { referenceSearch } from './references.js';
import { preferences } from './sources.js';
import type { Database } from '../db/index.js';

const unused = {} as Database;
const prefs = preferences(['baidu','bing','github','cnblogs','csdn','wechat'], 'bing');
const rss = '<rss><channel><item><title>Support</title><link>https://example.org/docs</link></item></channel></rss>';

test('automatic mode retains successful results, reports partial outages, explicit source never switches',async t=>{
  const mock = t.mock.method(publicTransport,'fetch',async (url:URL)=>url.hostname === 'www.bing.com'
    ? new Response(rss) : new Response('slow',{status:429}));
  const answer = await referenceSearch(unused,{query:'Support',source:'auto'},prefs);
  assert.equal(answer.count,1);
  assert.equal(answer.status,'partial');
  assert.deepEqual(answer.failures,[{source:'baidu',reason:'来源限流，请稍后重试'}]);
  assert.equal(answer.results[0]?.source,'example.org');
  mock.mock.resetCalls();
  await assert.rejects(referenceSearch(unused,{query:'Support',source:'baidu'},prefs),/限流/);
  assert.equal(mock.mock.callCount(),1);
});

test('zero results, challenge, changed format, oversized body, timeout and cancellation are distinct',async t=>{
  const mock = t.mock.method(publicTransport,'fetch',async()=>new Response('<rss><channel/></rss>'));
  const run = () => referenceSearch(unused,{query:'Tomcat'},prefs);
  assert.equal((await run()).status,'empty');
  mock.mock.mockImplementation(async()=>new Response('<title>百度安全验证</title>'));
  await assert.rejects(referenceSearch(unused,{query:'CMS',source:'baidu'},prefs),/安全验证/);
  await assert.rejects(run(), /安全验证/);
  mock.mock.mockImplementation(async()=>new Response('<html>changed</html>'));
  await assert.rejects(run(), /不是搜索结果/);
  mock.mock.mockImplementation(async()=>new Response('x'.repeat(2*1024*1024+1)));
  await assert.rejects(run(),/大小限制/);
  mock.mock.mockImplementation(async()=>{throw new DOMException('timeout','TimeoutError');});
  await assert.rejects(run(),/搜索超时/);
  await assert.rejects(referenceSearch(unused,{query:'CMS'},prefs,{signal:AbortSignal.abort()}),/已取消/);
});

test('community sources accept only matching article links from Baidu', async t=>{
  const links = {wechat:'https://mp.weixin.qq.com/s/article', csdn:'https://blog.csdn.net/demo/article/details/321',
    cnblogs:'https://www.cnblogs.com/demo/p/32.html'} as const;
  t.mock.method(publicTransport,'fetch',async()=>new Response(Object.values(links).map(mu=>
    '<div class="result" data-log=\''+JSON.stringify({mu})+'\'><h3>Tomcat</h3></div>').join('')));
  for(const source of ['wechat','csdn','cnblogs'] as const){
    const result = await referenceSearch(unused,{query:'Tomcat',source},prefs);
    assert.deepEqual(result.results.map(r=>[r.engine,r.source,r.url]),[['baidu',source,links[source]]]);
  }
});
