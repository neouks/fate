// Synthetic read-only API: never connects to a backend or runs a Worker.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.FATE_TEST_ORIGIN;assert.ok(origin);assert.notEqual(new URL(origin).port,'8787');
if(process.env.FATE_SCREENSHOTS)mkdirSync(process.env.FATE_SCREENSHOTS,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{for(const width of [1440,390]){
 const context=await browser.newContext({viewport:{width,height:1000}});
 await context.addCookies([{name:'series_token',value:'fixture',url:origin}]);
 await context.addInitScript(()=>{localStorage.setItem('series_token','fixture');window.auditSources=[];window.EventSource=class extends EventTarget{static CLOSED=2;readyState=1;constructor(url){super();this.url=url;window.auditSources.push(this);}close(){this.readyState=2;}};});
 const ts='2026-11-19T06:00:00Z',requests=[],errors=[],writes=[];
 const task={id:'501',name:'系统审计合成测试',goal:'核对本地记录',status:'running',paused:true,created_at:ts,updated_at:ts,exploration_id:301};
 const nodes=[{id:'201',type:'intent',state:'paused',owner:'work#201',payload:JSON.stringify({summary:'核对文本 201'}),origin:'planner',ts}];
 const record=(seq,type,source,status,summary)=>({seq,worker:type==='system'||type==='important_fact'?'system':'work#201',kind:'status',intent_id:'201',summary,detail:summary+'\n完整原文：'+('只保留原有验收范围。'.repeat(40)),ts,
  audit_event:{type,source,status,title:{correction:'Worker 纠偏',control:'停止 Worker',important_fact:'重要事实',system:'模型切换'}[type],intent_id:'201',...(type==='important_fact'?{fact_id:'301',reason:'已有证据改变后续判断，无需重复执行。'}:{source_session:'intent:201'})}});
 const records=[record(1,'correction','user','submitted','人工纠偏：不要扩展目标'),record(2,'correction','planner','submitted','Planner 纠偏：复用已保存证据'),record(3,'control','planner','stop_requested','停止请求已提交'),record(4,'control','planner','stopped','旧意图已停止'),record(5,'important_fact','worker','saved','已确认关键事实'),record(6,'system','system','recorded','模型配置已切换')];
 await context.route('**/*',route=>{
  const req=route.request(),u=new URL(req.url()),p=u.pathname,ok=json=>route.fulfill({status:200,json});
  if(u.origin!==origin)return route.abort();
  if(!['GET','HEAD'].includes(req.method())){writes.push(req.url());return route.abort();}
  if(!p.startsWith('/api/'))return route.continue();requests.push(p+u.search);
  if(p==='/api/tasks/501')return ok(task);
  if(p==='/api/tasks')return ok({tasks:[task],total:1});
  if(p==='/api/tasks/summary')return ok({total:1,by_status:{running:1}});
  if(p==='/api/exploration/main-sessions')return ok({sessions:[{seq:0,created_at:ts}],current:0});
  if(p.includes('/intents'))return ok({items:nodes,completed_count:0});
  if(p==='/api/exploration/activity/history'){
   const system=u.searchParams.get('session')==='system',type=u.searchParams.get('audit_type'),before=Number(u.searchParams.get('before'));
   const available=system?records.filter(r=>!type||r.audit_event.type===type):u.searchParams.get('session')==='intent:201'?records.filter(r=>r.audit_event.type==='correction'):[];
   const matching=available.filter(r=>!before||r.seq<before),items=matching.slice(-3);
   return ok({items,snapshot_cursor:records.at(-1).seq,earliest_cursor:items[0]?.seq||0,latest_cursor:items.at(-1)?.seq||0,has_more:matching.length>items.length});
  }
  if(p.endsWith('/turns'))return ok({items:[]});
  if(p==='/api/exploration/tokens')return ok({workers:[],sessions:[]});
  if(p.includes('/findings'))return ok([]);
  if(p.endsWith('/agents'))return ok({agents:[]});
  if(p.includes('/llm')||p.includes('/profiles'))return ok([]);
  if(p.endsWith('/status'))return ok({running:false,initialized:true});
  return ok({items:[],total:0,goals:[],constraints:[],conversations:[],sources:[],assets:[],rows:[],scope:[],servers:[],skills:[],tools:[],counts:{}});
 });
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/function/tasks/detail/?id=501&tab=sessions&section=chat');
 const chooseSystem=async()=>{
  const button=page.getByRole('button',{name:'系统事件',exact:true});
  if(!await button.isVisible())await page.getByRole('button',{name:'执行过程',exact:true}).click();
  await button.click();
 };
 await chooseSystem();
 const timeline=page.getByRole('list',{name:'重要事件时间线'}),panel=page.locator('[aria-label="系统事件时间线"]').last();
 await timeline.locator('[data-audit-id="6"]').waitFor();
 const older=page.getByRole('button',{name:'加载更早记录',exact:true});
 if(await older.isVisible())await older.click();
 await timeline.locator('[data-audit-id="1"]').waitFor();
 assert.equal(await timeline.locator('[data-audit-id]').count(),6);
 await page.getByRole('radio',{name:'纠偏',exact:true}).click();
 await timeline.locator('[data-audit-id="1"]').waitFor();
 assert.equal(await timeline.locator('[data-audit-id]').count(),2);assert.ok(requests.some(p=>p.includes('audit_type=correction')));
 await timeline.getByRole('button',{name:'展开详情'}).first().click();await timeline.getByText(/完整原文/).first().waitFor();
 const live=record(7,'correction','mainagent','submitted','主 Agent 实时纠偏');records.push(live);
 await page.evaluate(event=>{const s=window.auditSources.findLast(s=>s.url.includes('activity/stream'));s.onmessage({data:JSON.stringify(event)});s.onmessage({data:JSON.stringify(event)});},live);
 await timeline.locator('[data-audit-id="7"]').waitFor();assert.equal(await timeline.locator('[data-audit-id="7"]').count(),1);
 await page.getByRole('radio',{name:'重要事实',exact:true}).click();await timeline.locator('[data-audit-id="5"]').waitFor();assert.equal(await timeline.locator('[data-audit-id]').count(),1);
 assert.ok((await timeline.getByRole('link',{name:'查看事实 #301'}).getAttribute('href')).includes('node=301'));
 await page.getByRole('radio',{name:'执行控制',exact:true}).click();await timeline.getByText('停止请求已提交',{exact:true}).first().waitFor();await timeline.getByText('已停止',{exact:true}).waitFor();
 await page.getByRole('radio',{name:'全部',exact:true}).click();await timeline.locator('[data-audit-id="7"]').waitFor();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow');
 if(process.env.FATE_SCREENSHOTS)await page.screenshot({path:`${process.env.FATE_SCREENSHOTS}/system-audit-${width}.png`});
 assert.equal(requests.some(p=>/^\/api\/exploration\/activity\?/.test(p)),false,'must not scan all activity');
 assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
 console.log(`PASS system audit ${width}px: paging, categories, replay dedup, details, links, read-only`);
 await context.close();
}}finally{await browser.close();}
