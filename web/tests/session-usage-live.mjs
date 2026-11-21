// Read-only UI checks against real persisted model usage. Optional compaction
// replay uses an actual provider-test receipt, explicitly separate from live API.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.FATE_TEST_ORIGIN||'http://127.0.0.1:8787';
const id=process.env.FATE_TEST_CONVERSATION;
assert.ok(id,'Provide an idle real-model test conversation');
const key=readFileSync(process.env.FATE_TEST_JWT_KEY_FILE,'utf8').trim(),now=Math.floor(Date.now()/1000);
const body=[{alg:'HS256',typ:'JWT'},{sub:'SERIES',iat:now,exp:now+3600}].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
const token=body+'.'+createHmac('sha256',key).update(body).digest('base64url');
const response=await fetch(`${origin}/api/conversations/${id}/usage`,{headers:{'X-Series-Token':token}});
assert.equal(response.status,200);const usage=await response.json();
assert.equal(usage.total.usage_complete,true);assert.equal(usage.context.state,'recorded');assert.ok(usage.context.capacity>0);
const replay=process.env.FATE_COMPACTION_EVIDENCE?JSON.parse(readFileSync(process.env.FATE_COMPACTION_EVIDENCE,'utf8')).snapshots.find(s=>s.stage==='after-compaction').api:null;
if(replay){assert.equal(replay.context.state,'compacted');assert.equal(replay.context.tokens,null);}
const out=process.env.FATE_SCREENSHOTS;if(out)mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 for(const [width,theme] of [[1440,'light'],[390,'light'],[1440,'dark']]){
  const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme});
  await context.addCookies([{name:'series_token',value:token,url:origin},{name:'theme_mode',value:theme,url:origin}]);
  await context.addInitScript(token=>localStorage.setItem('series_token',token),token);
  const page=await context.newPage(),errors=[];page.setDefaultTimeout(30000);
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${origin}/chat?c=${id}`);
  const trigger=page.getByRole('button',{name:'当前上下文使用情况',exact:true});
  await page.waitForFunction(()=>document.querySelector('[aria-label="当前上下文使用情况"]')?.textContent.includes('%'));
  assert.ok((await trigger.innerText()).includes(((usage.context.tokens/usage.context.capacity)*100).toFixed(1)+'%'));
  await trigger.click();const popover=page.locator('.context-usage-popover');
  async function value(label){return popover.locator('dl > div').filter({has:page.locator('dt').filter({hasText:new RegExp('^'+label+'$')})}).locator('dd').innerText();}
  const fmt=n=>n.toLocaleString('zh-CN');
  for(const [label,n] of [['非缓存输入',usage.total.uncached_input_tokens],['输出',usage.total.output_tokens],['缓存读取',usage.total.cache_read_tokens],['缓存写入',usage.total.cache_write_tokens],['总计',usage.total.input_tokens+usage.total.output_tokens]])assert.equal(await value(label),fmt(n));
  assert.equal(await value('上下文'),`${fmt(usage.context.tokens)} / ${fmt(usage.context.capacity)}`);
  assert.equal(await value('缓存命中率'),((usage.total.cache_read_tokens/usage.total.input_tokens)*100).toFixed(1)+'%');
  assert.equal(await popover.getByText(/历史请求未记录/).count(),0);
  if(out)await page.screenshot({animations:'disabled',path:`${out}/live-${width}-${theme}.png`});
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'会话信息：上下文与消费预估',exact:true}).click();
  assert.ok((await page.locator('.pi-web-info-card').first().innerText()).includes(fmt(usage.context.tokens)));
  await page.getByRole('button',{name:'关闭会话信息',exact:true}).click();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  console.log(`PASS live token counts and capacity ${width}px ${theme}`);
  if(replay){
   await page.route(`**/api/conversations/${id}/usage`,route=>route.fulfill({json:replay}));
   await page.reload();await page.getByRole('button',{name:'当前上下文使用情况',exact:true}).filter({hasText:'压缩后待校准'}).waitFor();
   await trigger.click();assert.equal(await value('上下文'),`— / ${fmt(replay.context.capacity)}`);
   assert.equal(await value('总计'),fmt(replay.total.input_tokens+replay.total.output_tokens));
   await popover.getByText(/压缩请求后等待下一次对话请求校准/).waitFor();
   if(out)await page.screenshot({animations:'disabled',path:`${out}/recorded-compaction-${width}-${theme}.png`});
   console.log(`PASS recorded real compaction UI replay ${width}px ${theme}`);
  }
  assert.deepEqual(errors,[]);await context.close();
 }
}finally{await browser.close();}
