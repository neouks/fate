// Deterministic browser fixtures: no production API writes, model calls or target requests.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.FATE_TEST_ORIGIN;assert.ok(origin);
const browser=await chromium.launch({channel:'chrome',headless:true});
try {for(const [width,theme] of [[1440,'light'],[390,'dark']]) {
  const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme});
  await context.addCookies([{name:'series_token',value:'fixture',url:origin},{name:'theme_mode',value:theme,url:origin}]);
  await context.addInitScript(()=>localStorage.setItem('series_token','fixture'));
  let failList=true,failDelete=true,deleteCalls=0,releaseDetail;
  const detailGate=new Promise(resolve=>{releaseDetail=resolve;});
  const agents=[{id:'1',key:'fixture',name:'合成助手',builtin:false,deletable:true,enabled:true,max_turns:17,run_seconds:234,mcp_count:0,skill_count:0,tool_count:0}];
  await context.route('**/*',async route=>{
    const req=route.request(),u=new URL(req.url()),p=u.pathname,ok=json=>route.fulfill({json});
    if(u.origin!==origin)return route.abort();if(!p.startsWith('/api/'))return route.continue();
    if(p==='/api/agents'){
      if(req.method()==='POST'){const b=req.postDataJSON();const a={...agents[0],...b,id:'2'};agents.push(a);return route.fulfill({status:201,json:a});}
      if(failList)return route.fulfill({status:503,json:{error:'合成加载失败'}});
      return ok({agents});
    }
    if(p.startsWith('/api/agents/')&&req.method()==='DELETE'){
      deleteCalls++;if(failDelete)return route.fulfill({status:409,json:{error:'该 Agent 仍有排队或运行中的会话'}});
      const key=p.split('/').pop();agents.splice(agents.findIndex(a=>a.key===key),1);return ok({deleted:key});
    }
    if(p==='/api/agents/fixture'){await detailGate;return ok({agent:agents[0],prompt:'合成提示词',variables:[],visibility:{mcp:[],skill:[]},llm_profiles:[],versions:[{version:1,ts:'2026-11-12T01:00:00Z',note:'合成版本',template_text:'合成提示词'}]});}
    if(p.includes('status'))return ok({initialized:true,running:false});
    return ok({items:[],tasks:[],categories:[],agents:[],conversations:[],missing:[],tools:[],skills:[],servers:[],triggers:[]});
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
  try {
    await page.goto(origin+'/system/agents');await page.getByRole('alert').filter({hasText:'合成加载失败'}).waitFor();
    failList=false;await page.getByRole('button',{name:'重试',exact:true}).click();
    await page.getByRole('button',{name:/合成助手 fixture/}).click();
    await page.getByText('正在加载 Agent 配置…',{exact:true}).waitFor();assert.equal(await page.locator('#run-seconds').count(),0);releaseDetail();
    await page.locator('#max-turns').waitFor();assert.equal(await page.locator('#max-turns').inputValue(),'17');assert.equal(await page.locator('#run-seconds').inputValue(),'234');
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'新建 Agent',exact:true}).click();
    await page.locator('#agent-key').fill('new_fixture');await page.locator('#agent-name').fill('新建合成助手');
    await page.getByRole('button',{name:'创建',exact:true}).click();
    await page.getByText('已创建 Agent「新建合成助手」',{exact:true}).waitFor();await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'删除 Agent「新建合成助手」',exact:true}).click();
    const dialog=page.getByRole('alertdialog');await dialog.getByRole('button',{name:'删除',exact:true}).click();
    await page.getByText(/删除失败：.*仍有排队/).waitFor();assert.equal(await dialog.isVisible(),true);assert.equal(deleteCalls,1);
    if(process.env.FATE_SCREENSHOTS){mkdirSync(process.env.FATE_SCREENSHOTS,{recursive:true});await page.screenshot({path:`${process.env.FATE_SCREENSHOTS}/agents-${width}-${theme}.png`});}
    failDelete=false;await dialog.getByRole('button',{name:'删除',exact:true}).click();
    await page.getByText('已删除 Agent「新建合成助手」',{exact:true}).waitFor();await dialog.waitFor({state:'hidden'});
    assert.equal(await page.getByRole('button',{name:'删除 Agent「新建合成助手」',exact:true}).count(),0);assert.equal(deleteCalls,2);assert.deepEqual(errors,[]);
    console.log(JSON.stringify({width,theme,passed:true,deleteCalls}));
  } catch(e) {console.error(await page.locator('body').innerText());throw e;} finally {await context.close();}
}}finally{await browser.close();}
