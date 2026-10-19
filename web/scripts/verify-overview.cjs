// Read-only UI acceptance against the isolated neo-turn-ui-host fixture.
const {chromium}=require(process.env.FATE_PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const base=process.env.FATE_UI_BASE||'http://127.0.0.1:15179',dir=path.resolve(__dirname,'../../docs/reviews/evidence/overview-token-fix-20261019');fs.mkdirSync(dir,{recursive:true});
 const state=JSON.parse(fs.readFileSync('/tmp/fate-neo-turn-ui/state.json')),token=fs.readFileSync('/tmp/fate-neo-turn-ui/token','utf8').trim();
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:'series_token',value:token,url:base}]);await context.addInitScript(t=>localStorage.setItem('series_token',t),token);
  const page=await context.newPage(),errors=[];let streams=0;page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/activity/stream?'))streams++;});
  await page.goto(`${base}/function/tasks/detail?id=${state.task_id}&tab=sessions&panel=overview`);
  const card=page.locator('[data-slot="card"]').filter({has:page.getByText('LLM Token 用量',{exact:false})});
  await card.getByText('83.8%',{exact:true}).first().waitFor();assert.equal(await page.getByRole('dialog',{name:'任务详情'}).count(),0);assert.equal(await page.getByRole('tablist',{name:'任务导航',exact:true}).getByRole('tab').count(),5);assert.equal(await page.getByRole('tab',{name:'任务详情',exact:true}).getAttribute('aria-selected'),'true');
  assert.ok((await card.innerText()).includes('共 4 次请求'));assert.ok((await card.innerText()).includes('334'));assert.ok((await card.innerText()).includes('1 次压缩'));assert.ok((await card.innerText()).includes('1 次失败'));assert.ok((await card.innerText()).includes('1 次请求用量'));
  const before=streams;await page.getByRole('tab',{name:'对话',exact:true}).click();const input=page.getByRole('textbox',{name:'给主 Agent 发消息',exact:true});await input.fill('LOCAL draft retained; do not send');await page.getByRole('tab',{name:'任务详情',exact:true}).click();await card.waitFor();await page.goBack();await input.waitFor();assert.equal(await input.inputValue(),'LOCAL draft retained; do not send');await page.goForward();await card.waitFor();assert.equal(streams,before);
  const goal=page.getByPlaceholder('新增目标，如『拿到管理员账号的越权访问』');await goal.fill('LOCAL unsaved goal');await page.getByRole('tab',{name:'发现',exact:false}).first().click();await page.getByRole('tab',{name:'任务',exact:true}).click();await goal.waitFor();assert.equal(await goal.inputValue(),'LOCAL unsaved goal');
  const viewports=[];
  for(const width of [390,693,846,1440]){
   await page.setViewportSize({width,height:950});await page.waitForTimeout(250);assert.equal(await page.getByRole('dialog').count(),0,'hidden chat must not open the execution drawer');await card.scrollIntoViewIfNeeded();
   for(const dark of [false,true]){await page.evaluate(d=>document.documentElement.classList.toggle('dark',d),dark);await page.waitForTimeout(180);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:`${dir}/${dark?'dark':'light'}-${width}.png`});viewports.push({width,dark});}
  }
  assert.deepEqual(errors,[]);const report={checks:['legacy drawer link opens full-width task content','five primary categories retained','audited usage and unknown requests displayed','history back/forward preserves composer draft','tab switches do not add task SSE subscriptions','unsaved goal retained across primary tabs'],viewports,errors};fs.writeFileSync(dir+'/browser.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
