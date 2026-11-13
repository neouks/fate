// Run against a built frontend. All API traffic is synthetic; no backend or model is called.
// FATE_TEST_ORIGIN=http://127.0.0.1:15196 PLAYWRIGHT_MODULE=/path/to/playwright node web/tests/process-display.mjs
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.FATE_TEST_ORIGIN;
assert.ok(origin,'FATE_TEST_ORIGIN is required');
const screenshots=process.env.FATE_SCREENSHOTS;
if(screenshots)mkdirSync(screenshots,{recursive:true});
const ts='2026-11-12T00:00:00Z',turn_id='synthetic-process';
const task={id:'501',name:'执行过程合成任务',description:'本地合成资料',goal:'核对样本文本',status:'paused',paused:true,created_at:ts,updated_at:ts,exploration_id:301};
const node={id:'201',type:'intent',state:'done',payload:JSON.stringify({summary:'核对合成文件'}),origin:'planner',ts};
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 for(const [width,theme] of [[1440,'light'],[1440,'dark'],[390,'light'],[390,'dark']]){
  for(const chat of [false,true]){
   const worker=chat?'auto':'work#1',endStatus=theme==='dark'?'failed':width===390?'stopped':'completed';
   const act=(seq,kind,summary,extra={})=>({seq,kind,summary,detail:summary,ts,worker,intent_id:chat?undefined:'201',turn_id,metadata:{turn_id},...extra});
   const initial=[act(1,'thinking','先核对已有记录，避免重复读取。',{detail:undefined,stream_id:'thought-1'}),act(2,'tool_use','context_get {"ref":"node:201"}',{tool:'context_get',tool_use_id:'call-1',detail:undefined}),act(3,'tool_result','已读取结果',{tool:'context_get',tool_use_id:'call-1',is_error:true,detail:undefined})];
   initial.push(act(4,'tool_use','bash {"command":"fixture"}',{tool:'bash',tool_use_id:'cancelled'}),act(5,'tool_result','Command aborted',{tool:'bash',tool_use_id:'cancelled',is_error:true}));
   const final=act(7,'text','最终答复保持原字号。',{metadata:{turn_id,final_answer:true}});
   const end=act(8,'result','执行结束',{metadata:{turn_id,event_type:'lifecycle',status:endStatus}});
   let ended=false,detailBroken=true,detailRequests=0;
   const errors=[],writes=[];
   const context=await browser.newContext({viewport:{width,height:950},colorScheme:theme});
   await context.addCookies([{name:'series_token',value:'fixture',url:origin},{name:'theme_mode',value:theme,url:origin}]);
   await context.addInitScript(()=>{
    localStorage.setItem('series_token','fixture');window.fixtureStreams=[];
    window.EventSource=class extends EventTarget {
     static CLOSED=2;readyState=1;onmessage=null;
     constructor(url){super();this.url=url;window.fixtureStreams.push(this);setTimeout(()=>this.dispatchEvent(new Event('open')),0);}
     close(){this.readyState=2;}
     emit(type,data){const e=new MessageEvent(type,{data:JSON.stringify(data)});if(type==='message')this.onmessage?.(e);this.dispatchEvent(e);}
    };
   });
   await context.route('**/*',route=>{
    const req=route.request(),u=new URL(req.url()),p=u.pathname,ok=json=>route.fulfill({status:200,json});
    if(u.origin!==origin)return route.abort();
    if(!p.startsWith('/api/'))return route.continue();
    if(req.method()!=='GET'){writes.push(p);return route.abort();}
    if(p==='/api/tasks/501')return ok(task);
    if(p==='/api/conversations')return ok({conversations:[{id:801,agent_key:'auto',title:'合成独立会话',created_at:ts,updated_at:ts,status:ended?'idle':'running'}]});
    if(p==='/api/exploration/main-sessions')return ok({sessions:[{seq:0,created_at:ts}],current:0});
    if(p.includes('/intents'))return ok({items:[node],completed_count:1});
    if(p==='/api/exploration/activity/history'||p==='/api/conversations/801/messages')return ok({items:chat||u.searchParams.get('session')==='intent:201'?[...initial,...ended?[final,end]:[]]:[],snapshot_cursor:8,cursor:8,earliest_cursor:1,latest_cursor:8,has_more:false,hasMore:false,running:!ended});
    if(p.endsWith('/turns'))return ok({items:[{turn_id,role:chat?'auto':'worker',worker,status:ended?endStatus:'running',revision:8,started_at:ts,finished_at:ended?ts:null,models:[],steps:2,tool_calls:2,failed_tool_calls:2,...ended?{final_activity:final}:{}}]});
    if(p==='/api/exploration/activity/1'||p==='/api/conversations/801/messages/1'){
     detailRequests++;
     if(detailBroken)return route.fulfill({status:500,json:{error:'合成读取失败'}});
     const offset=Number(u.searchParams.get('offset')||0),text=offset?'第二页原文。':'完整推理第一页。';
     return ok({detail:text,offset,next_offset:offset?8200:8192,total_chars:8200,has_more:!offset,version:'v1',field:'detail'});
    }
    if(p.includes('/tokens/'))return ok({models:[],workers:[],sessions:[],total:{input:0,output:0,cache_read:0,cache_write:0,total:0}});
    if(p.endsWith('/agents'))return ok({agents:[]});
    if(p.includes('/llm')||p.includes('/profiles'))return ok([]);
    if(p.endsWith('/status'))return ok({running:false,initialized:true});
    return ok({items:[],total:0,goals:[],constraints:[],conversations:[],sources:[],assets:[],rows:[],scope:[]});
   });
   const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
   const path=chat?'/chat?c=801':'/function/tasks/detail?id=501&tab=sessions&section=chat&intent=201';
   const emit=(type,data)=>page.evaluate(({type,data})=>window.fixtureStreams.filter(s=>s.readyState!==2).forEach(s=>s.emit(type,data)),{type,data});
   await page.goto(origin+path);
   if(!chat){const workerRow=page.getByRole('button',{name:/#201.*核对合成文件/});await workerRow.waitFor({timeout:2000}).catch(async()=>{await page.getByRole('button',{name:'执行过程',exact:true}).click();});await workerRow.click().catch(async e=>{console.error(await page.locator('body').innerText());throw e;});}
   const segment=page.locator('[data-process-segment]').first(),trigger=segment.locator(':scope > button');
   await trigger.waitFor().catch(async e=>{console.error(await page.locator('body').innerText(),errors);throw e;});assert.equal(await trigger.getAttribute('aria-expanded'),'true');
   const thought=segment.locator('.execution-thought').first(),row=thought.locator(':scope > button');
   await row.getByText('先核对已有记录，避免重复读取。',{exact:true}).waitFor();
   assert.equal(await row.getAttribute('aria-expanded'),'false');assert.equal(detailRequests,0);
   assert.equal(await row.evaluate(el=>getComputedStyle(el).fontSize),'13px');
   assert.equal(await row.evaluate(el=>getComputedStyle(el).paddingTop),'4px');
   assert.equal(await segment.locator('.execution-tool > button').first().getAttribute('aria-expanded'),'false');
   await trigger.getByText('· 1 次异常',{exact:true}).waitFor();
   const cancelled=segment.locator('[data-tool-status="stopped"]');
   await cancelled.getByRole('button').click();
   await cancelled.getByText('输出（已停止）',{exact:true}).waitFor();
   await row.click();await thought.getByRole('button',{name:'重新读取第一页'}).waitFor();
   detailBroken=false;await thought.getByRole('button',{name:'重新读取第一页'}).click();
   await thought.getByText('完整推理第一页。',{exact:true}).waitFor();
   await thought.getByRole('button',{name:'下一页'}).click();await thought.getByText('第二页原文。',{exact:true}).waitFor();
   await thought.getByRole('button',{name:'复制当前片段'}).waitFor();
   await trigger.click();assert.equal(await trigger.getAttribute('aria-expanded'),'false');
   const stream={worker,intent_id:chat?undefined:'201',turn_id,stream_id:'thought-2',channel:'thinking',text:'中文增量正在更新',offset:9,ts,active:true};
   await emit('streams',{items:[stream]});
   assert.equal(await trigger.getAttribute('aria-expanded'),'false');
   await trigger.click();await segment.getByText(/中文增量正在更新/).first().waitFor();
   const persisted=act(6,'thinking',stream.text,{stream_id:'thought-2',channel:'thinking'});
   initial.push(persisted);await emit('message',persisted);await emit('message',persisted);await emit('streams',{items:[]});
   await trigger.click();ended=true;await emit('message',final);await emit('message',end);await emit('streams',{items:[]});
   await emit('turn_summary',{requested_ids:[turn_id],items:[{turn_id,revision:9,role:chat?'auto':'worker',worker,status:endStatus,started_at:ts,finished_at:ts,models:[],steps:2,tool_calls:2,failed_tool_calls:2,final_activity:final}]});
   await page.locator('[data-final-answer]').getByText(final.summary,{exact:true}).waitFor();
   assert.equal(await trigger.getAttribute('aria-expanded'),'false');
   await trigger.click();assert.equal(await segment.locator('.execution-thought').count(),2);
   await page.reload();if(!chat){const workerRow=page.getByRole('button',{name:/#201.*核对合成文件/});await workerRow.waitFor({timeout:2000}).catch(async()=>{await page.getByRole('button',{name:'执行过程',exact:true}).click();});await workerRow.click().catch(async e=>{console.error(await page.locator('body').innerText());throw e;});}await page.locator('[data-final-answer]').waitFor();
   assert.equal(await trigger.getAttribute('aria-expanded'),'true');
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   if(screenshots)await page.screenshot({path:`${screenshots}/${chat?'chat':'worker'}-${width}-${theme}.png`,animations:'disabled'});
   if(!chat){await page.goto(origin+'/function/tasks/detail?id=501&tab=sessions&section=chat&session=intent:201&activity=1');await page.getByText('完整推理第一页。',{exact:true}).waitFor();}
   assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
   console.log(width,theme,chat?'独立会话':'Worker','默认展开、按需读取、重试续读、流式、去重、折叠保持、终态及刷新通过');
   await context.close();
  }
 }
}finally{await browser.close();}
