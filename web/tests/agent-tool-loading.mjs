// Browser-only API fixtures; never writes production settings.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.FATE_TEST_ORIGIN;assert(origin);
const browser=await chromium.launch({channel:'chrome',headless:true});
try{for(const width of [1440,390]){
 const context=await browser.newContext({viewport:{width,height:1000},colorScheme:width===390?'dark':'light'});
 await context.addCookies([{name:'series_token',value:'fixture',url:origin}]);await context.addInitScript(()=>localStorage.setItem('series_token','fixture'));
 const overrides={worker:{},planner:{},mainagent:{}},roles=Object.keys(overrides);
 const agents=roles.map((key,i)=>({id:String(i+1),key,name:key,builtin:true,enabled:true,max_turns:10,run_seconds:600}));
 const tools=['asset_get','context_get','tool_search','report_finding'].map(key=>({key,system:true,kind:'builtin',description:'合成工具 '+key,enabled:key!=='report_finding',agents:roles,implementation_status:'active',schema:{}}));
 let failRead=true,failSave=true,saves=0;
 const settings=role=>({overrides:overrides[role],editable_tools:['asset_get','context_get','report_finding'],resident:tools.filter(t=>(overrides[role][t.key]??(['context_get','tool_search'].includes(t.key)?'resident':'deferred'))==='resident').map(t=>t.key),deferred:[],default_mode:'deferred',default_resident:['context_get','tool_search'],fallback:tools.find(t=>t.key==='tool_search').agents.includes(role)?null:'tool_search 已禁用或未绑定，使用直接装配',applies_on:'next_run'});
 await context.route('**/*',route=>{
  const req=route.request(),url=new URL(req.url()),p=url.pathname,ok=json=>route.fulfill({json});
  if(url.origin!==origin)return route.abort();if(!p.startsWith('/api/'))return route.continue();
  const match=p.match(/^\/api\/agents\/([^/]+)\/tool-loading$/);
  if(match){const role=match[1];if(req.method()==='PUT'){
   if(failSave){failSave=false;return route.fulfill({status:503,json:{error:'合成保存失败，请重试'}});}
   overrides[role]=req.postDataJSON().overrides;saves++;return ok(settings(role));
  }if(failRead){return route.fulfill({status:503,json:{error:'合成读取失败'}});}return ok(settings(role));}
  if(p==='/api/agents')return ok({agents});
  const detail=agents.find(a=>p==='/api/agents/'+a.key);if(detail)return ok({agent:detail,prompt:'合成提示词',variables:[],versions:[],visibility:{mcp:[],skill:[]},llm_profiles:[]});
  if(p==='/api/tools')return ok({tools,roles:[]});
  const tool=tools.find(t=>p==='/api/tools/'+t.key);if(tool&&req.method()==='PUT'){Object.assign(tool,req.postDataJSON());return ok({ok:true});}
  if(p==='/api/settings')return ok({traffic_capture:true});
  if(!['GET','HEAD'].includes(req.method()))throw Error('Unexpected API write: '+p);
  return ok({items:[],tasks:[],categories:[],agents:[],tools:[],skills:[],servers:[],profiles:[],initialized:true});
 });
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(20000);
 const open=async role=>{await page.goto(origin+'/function/tasks?settings=true&settingsTab=agents&settingsAgent='+role,{waitUntil:'domcontentloaded',timeout:120000});try{await page.getByRole('tab',{name:'Tools',exact:true}).click();}catch(error){console.error(JSON.stringify({url:page.url(),errors,body:(await page.locator('body').innerText()).slice(-5000)}));throw error;}};
 await open('worker');await page.getByRole('alert').filter({hasText:'合成读取失败'}).waitFor();failRead=false;await page.getByRole('button',{name:'重新加载',exact:true}).click();
 await page.getByLabel('asset_get 常驻',{exact:true}).click();await page.getByLabel('context_get 按需检索',{exact:true}).click();
 assert(await page.getByLabel('report_finding 常驻',{exact:true}).isDisabled());
 assert.equal(await page.getByLabel('tool_search 按需检索',{exact:true}).count(),0);
 await page.getByRole('checkbox',{name:'tool_search',exact:true}).uncheck();
 await page.waitForFunction(()=>document.querySelector('[aria-label="asset_get 按需检索"]')?.disabled&&document.querySelector('[aria-label="asset_get 常驻"]')?.disabled===false);
 await page.getByRole('checkbox',{name:'tool_search',exact:true}).check();
 await page.waitForFunction(()=>document.querySelector('[aria-label="asset_get 按需检索"]')?.disabled===false);
 assert.equal(await page.getByLabel('asset_get 常驻',{exact:true}).getAttribute('data-state'),'on');
 await page.getByRole('button',{name:'保存加载配置',exact:true}).click();await page.getByRole('alert').filter({hasText:'合成保存失败'}).waitFor();
 assert.equal(await page.getByLabel('asset_get 常驻',{exact:true}).getAttribute('data-state'),'on');
 await page.getByRole('button',{name:'保存加载配置',exact:true}).click();await page.getByText('工具加载配置已保存，下次执行或恢复会话时生效',{exact:true}).waitFor();
 assert.deepEqual(overrides.worker,{asset_get:'resident',context_get:'deferred'});
 await open('worker');await page.getByLabel('asset_get 常驻',{exact:true}).waitFor();
 await page.waitForFunction(()=>document.querySelector('[aria-label="asset_get 常驻"]')?.getAttribute('data-state')==='on');
 if(process.env.FATE_SCREENSHOT_DIR){mkdirSync(process.env.FATE_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:process.env.FATE_SCREENSHOT_DIR+`/agent-tool-loading-${width}.png`,fullPage:true});}
 const boxes=await page.locator('[data-tool-loading]').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {right:r.right,width:r.width,scroll:n.scrollWidth,client:n.clientWidth};}));
 assert(boxes.every(b=>b.scroll<=b.client+1&&b.right<=width+1),'tool settings overflow');
 await open('mainagent');await page.waitForFunction(()=>document.querySelector('[aria-label="asset_get 默认加载"]')?.getAttribute('data-state')==='on');
 assert.deepEqual(overrides.mainagent,{});
 await page.getByLabel('asset_get 按需检索',{exact:true}).click();await page.getByRole('button',{name:'保存加载配置',exact:true}).click();await page.getByText('工具加载配置已保存，下次执行或恢复会话时生效',{exact:true}).waitFor();
 await open('worker');await page.getByRole('button',{name:'恢复默认',exact:true}).click();await page.getByRole('button',{name:'保存加载配置',exact:true}).click();
 await page.getByText('工具加载配置已保存，下次执行或恢复会话时生效',{exact:true}).waitFor();assert.deepEqual(overrides.worker,{});assert.deepEqual(overrides.mainagent,{asset_get:'deferred'});
 assert.equal(saves,3);assert.deepEqual(errors,[]);console.log(JSON.stringify({width,passed:true,saves,checks:'load failure, save retry, persist/reload, role isolation, reset, fixed search entry, binding refresh preserves draft, disabled tool, no overflow'}));
 await context.close();
}}finally{await browser.close();}
