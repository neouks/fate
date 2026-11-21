// Exercises the actual in-browser mock API. No backend/model traffic is permitted.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.FATE_TEST_ORIGIN||'http://127.0.0.1:3001';
const out=process.env.FATE_SCREENSHOTS;
if(out)mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 for(const [width,theme] of [[1440,'light'],[390,'light'],[1440,'dark']]){
  const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme});
  await context.addCookies([{name:'theme_mode',value:theme,url:origin}]);
  const page=await context.newPage(),errors=[],requests=[];
  page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(120000);
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',route=>{
   const u=new URL(route.request().url());
   if(u.origin!==origin)return route.abort();
   if(u.pathname.startsWith('/api/')){requests.push(u.pathname);return route.abort();}
   return route.continue();
  });
  async function shot(name){if(out)await page.screenshot({animations:'disabled',path:`${out}/${name}-${width}-${theme}.png`});}
  async function model(name){
   const trigger=page.getByRole('combobox',{name:'会话模型',exact:true});
   await trigger.click();
   await page.getByRole('combobox',{name:'筛选模型',exact:true}).fill(name);
   await page.getByRole('option').filter({hasText:name}).click();
   await page.waitForFunction(name=>[...document.querySelectorAll('[aria-label="会话模型"]')].some(n=>n.getBoundingClientRect().width&&n.textContent.includes(name)),name);
   await page.getByRole('combobox',{name:'会话模型',exact:true}).waitFor({state:'visible'});
  }
  async function session(name){
   const button=page.getByRole('button',{name,exact:true});
   if(!await button.isVisible())await page.getByRole('button',{name:'执行过程',exact:true}).click();
   await button.click();
  }
  await page.goto(origin+'/chat?c=1');
  await page.addStyleTag({content:'nextjs-portal { display:none !important; }'});
  await page.getByRole('textbox',{name:'会话消息',exact:true}).fill('检查模型菜单');
  assert.equal(await page.getByText(/紧凑排版|舒展排版|舒适排版/).count(),0);
  if(width<768)await page.getByRole('button',{name:'切换会话列表',exact:true}).click();
  const agent=page.getByRole('combobox',{name:'新会话 Agent',exact:true});
  await agent.focus();
  await page.keyboard.press('Space');
  const agentName=await page.getByRole('option').last().innerText();
  await page.keyboard.press('End');
  await page.waitForFunction(()=>document.activeElement===[...document.querySelectorAll('[role=option]')].at(-1));
  await page.keyboard.press('Enter');
  await page.getByRole('listbox').waitFor({state:'hidden'});
  assert.equal(await agent.innerText(),agentName);
  await shot('agent-select-closed');
  if(width<768){
   await page.getByRole('button',{name:'关闭会话列表',exact:true}).click();
   await page.getByRole('dialog',{name:'会话列表',exact:true}).waitFor({state:'hidden'});
  }

  await page.getByRole('combobox',{name:'会话模型',exact:true}).click();
  await page.getByRole('combobox',{name:'筛选模型',exact:true}).waitFor();
  await page.getByText('Anthropic',{exact:true}).waitFor();
  await page.getByText('DeepSeek',{exact:true}).waitFor();
  await page.getByRole('button',{name:'收藏 deepseek-v4-flash',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'取消收藏 deepseek-v4-flash',exact:true}).getAttribute('aria-pressed'),'true');
  await shot('model-picker');
  await page.getByRole('combobox',{name:'筛选模型',exact:true}).fill('no-such-model');
  await page.getByText('没有匹配的模型').waitFor();
  assert.equal(await page.locator('.model-picker-favorite:visible').count(),0);
  await page.keyboard.press('Escape');
  await model('deepseek-v4-flash');
  await page.getByRole('button',{name:'会话信息：上下文与消费预估',exact:true}).click();
  const pricing=page.getByRole('combobox',{name:'模型',exact:true});
  await pricing.click();
  await page.getByRole('option').last().waitFor();
  const pricingName=await page.getByRole('option').last().innerText();
  await shot('pricing-select');
  await page.keyboard.press('End');
  await page.waitForFunction(()=>document.activeElement===[...document.querySelectorAll('[role=option]')].at(-1));
  await page.keyboard.press('Enter');
  await page.getByRole('listbox').waitFor({state:'hidden'});
  assert.equal(await pricing.innerText(),pricingName);
  await page.getByRole('button',{name:'关闭会话信息',exact:true}).click();
  await page.getByRole('button',{name:'当前上下文使用情况',exact:true}).click();
  await page.getByText('缓存命中率',{exact:true}).waitFor();
  await shot('chat-context');
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByText('已收到你的消息（Mock 演示，无模型请求）。',{exact:true}).waitFor();
  await page.getByRole('combobox',{name:'会话模型',exact:true}).click();
  await page.keyboard.press('Escape');
  await page.goto(origin+'/function/tasks/detail?id=t-acme-web&section=chat');
  await page.addStyleTag({content:'nextjs-portal { display:none !important; }'});
  await page.getByRole('textbox',{name:'Planner 对话',exact:true}).waitFor();
  await model('deepseek-v4-flash');
  await page.getByText('已保存，仅此会话的下次执行使用新模型。',{exact:true}).waitFor();
  await shot('planner');
  await session('主 Agent · 会话 #1');
  await page.getByRole('textbox',{name:'给主 Agent 当前会话发消息',exact:true}).waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('[aria-label="会话模型"]')].some(n=>n.getBoundingClientRect().width&&!n.disabled&&n.textContent.includes('claude-opus')));
  assert.match(await page.getByRole('combobox',{name:'会话模型',exact:true}).innerText(),/claude-opus/);
  await model('deepseek-v4-flash');
  await shot('main-agent');
  await session('#i3 枚举后台功能与用户数据接口 实时');
  const worker=page.getByRole('textbox',{name:'对话 Worker #i3',exact:true});
  await worker.fill('待发送的补充说明');
  await page.waitForFunction(()=>[...document.querySelectorAll('[aria-label="会话模型"]')].some(n=>n.getBoundingClientRect().width&&!n.disabled&&n.textContent.includes('claude-opus')));
  assert.match(await page.getByRole('combobox',{name:'会话模型',exact:true}).innerText(),/claude-opus/);
  await model('deepseek-v4-flash');
  assert.equal(await worker.inputValue(),'待发送的补充说明');
  await page.getByRole('button',{name:'当前上下文使用情况',exact:true}).click();
  await page.getByText('缓存命中率',{exact:true}).waitFor();
  await shot('worker-context');
  await page.keyboard.press('Escape');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow');
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  console.log(`PASS conversation controls ${width}px ${theme}`);
  await context.close();
 }
}finally{await browser.close();}
