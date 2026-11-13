// Synthetic API responses only; no model, target, or production database requests.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.FATE_TEST_ORIGIN;assert.ok(origin);
const body='{"sample":"本地合成资料"}';
const request='POST /sample HTTP/1.1\r\nHost: fixture.test\r\nContent-Type: application/json\r\nX-Request: kept\r\n\r\n'+body;
const response='HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Response: kept\r\n\r\n{"result":"local fixture"}';
const finding={id:'10',finding_id:'10',task_id:'7',name:'合成报告排版',summary:'仅用于本地排版核对。',vulnclass:'合成类型',severity:'info',status:'confirmed',asset_ids:[],ts:'2026-11-13T00:00:00Z',created_at:'2026-11-13T00:00:00Z',evidence:'local fixture',report:'历史正文',evidence_version:1,report_evidence_version:1,report_revision:1,report_sections:{description:'精简、直接的自然语言描述。',impact:[],remediation:[],discovery:{}},reproduction:{entry_point:'http://fixture.test/sample',prerequisites:[],provenance:'',steps:[{id:'one',action:'提交合成查询',request,response,expected:'',proves:'核对保存的全部报文',verified:true,traffic_id:'traffic-one'},{id:'two',action:'核对历史片段',request:'GET /sample HTTP/1.1',response:'{"ok":true}',expected:'',proves:'记录证据缺口',verified:true,packet_note:'原始证据未包含完整 HTTP 请求与响应，不补造。'}]}};
const browser=await chromium.launch({channel:'chrome',headless:true});
try{for(const width of [1440,390])for(const theme of ['light','dark']){
 const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme});
 await context.addCookies([{name:'series_token',value:'fixture',url:origin},{name:'theme_mode',value:theme,url:origin}]);
 await context.addInitScript(()=>localStorage.setItem('series_token','fixture'));
 const errors=[],writes=[];
 await context.route('**/*',route=>{
  const req=route.request(),u=new URL(req.url()),p=u.pathname,ok=json=>route.fulfill({json});
  if(u.origin!==origin)return route.abort();if(!p.startsWith('/api/'))return route.continue();
  if(req.method()!=='GET'){writes.push(p);return route.abort();}
  if(p==='/api/exploration/findings/10')return ok(finding);
  if(p.endsWith('/reproduction'))return ok({...finding,versions:[],images:[],markdown:''});
  if(p.endsWith('/traffic'))return ok({bindings:[{id:'bound-one',snapshot_id:'traffic-one',role:'proof',snapshot:{method:'POST',url:'http://fixture.test/sample'}}],version:1});
  if(p.endsWith('/body'))return route.fulfill({body:body,contentType:'application/octet-stream'});
  if(p.endsWith('/retests'))return ok([]);
  if(p.includes('status'))return ok({initialized:true,running:false});
  return ok({items:[],tasks:[],profiles:[],categories:[],companies:[],conversations:[]});
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/function/findings/detail?id=10');
 const first=page.getByText('1. 提交合成查询',{exact:true});await first.waitFor();await first.scrollIntoViewIfNeeded();
 assert.equal(await first.locator('xpath=ancestor::*[@data-slot="card"]').count(),1); // report container only, no step cards
 const packet=page.locator('pre').filter({hasText:'X-Request: kept'});assert.equal(await packet.count(),1);
 assert.equal(await packet.textContent(),request);
 assert.equal(await packet.locator('xpath=ancestor::details').count(),0);
 assert.ok(await page.getByText('原始证据未包含完整 HTTP 请求与响应，不补造。',{exact:true}).isVisible());
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'下载请求 Body',exact:true}).click();assert.match((await download).suggestedFilename(),/evidence-bound-one-request/);
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 if(process.env.FATE_SCREENSHOTS){mkdirSync(process.env.FATE_SCREENSHOTS,{recursive:true});await page.screenshot({path:`${process.env.FATE_SCREENSHOTS}/reporter-${width}-${theme}.png`});}
 console.log(JSON.stringify({width,theme,passed:true}));await context.close();
}}finally{await browser.close();}
