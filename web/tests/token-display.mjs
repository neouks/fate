// Isolated frontend preview only. Every API response is synthetic; writes and
// external requests are blocked. No model, backend or real task is contacted.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.FATE_TEST_ORIGIN;
assert.ok(origin,'FATE_TEST_ORIGIN is required');
if(process.env.FATE_SCREENSHOTS)mkdirSync(process.env.FATE_SCREENSHOTS,{recursive:true});
const ts='2026-11-18T00:00:00Z';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 for(const [width,theme] of [[1440,'light'],[390,'dark']])for(const known of [true,false]){
  const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme});
  await context.addCookies([{name:'series_token',value:'fixture',url:origin},{name:'theme_mode',value:theme,url:origin}]);
  await context.addInitScript(()=>{localStorage.setItem('series_token','fixture');window.EventSource=class extends EventTarget{static CLOSED=2;readyState=1;close(){this.readyState=2;}};});
  const usage={input_tokens:980,uncached_input_tokens:100,cache_read_tokens:800,cache_write_tokens:80,output_tokens:20,
    input_semantics:known?'inclusive_cache':'unknown',input_complete:known,usage_complete:known,calls:2,calls_complete:true,source:'usage_ledger'};
  const task={id:'501',name:'Token 展示合成任务',description:'只核对本地展示',goal:'核对合成文本',status:'paused',paused:true,created_at:ts,updated_at:ts,exploration_id:301,tokens:usage};
  const node={id:'201',type:'intent',state:'done',payload:JSON.stringify({summary:'核对合成文件'}),origin:'planner',ts};
  const activity={seq:1,kind:'text',summary:'合成结果',detail:'合成结果',ts,worker:'work#1',intent_id:'201',turn_id:'fixture-turn',metadata:{turn_id:'fixture-turn',final_answer:true}};
  const errors=[],writes=[];
  await context.route('**/*',route=>{
   const req=route.request(),u=new URL(req.url()),p=u.pathname,ok=json=>route.fulfill({status:200,json});
   if(u.origin!==origin)return route.abort();
   if(!p.startsWith('/api/'))return route.continue();
   if(req.method()!=='GET'){writes.push(p);return route.abort();}
   if(p==='/api/tasks/501')return ok(task);
   if(p==='/api/tasks')return ok({tasks:[task],total:1});
   if(p==='/api/tasks/summary')return ok({total:1,by_status:{paused:1}});
   if(p==='/api/assets/counts')return ok({});
   if(p==='/api/exploration/main-sessions')return ok({sessions:[{seq:0,created_at:ts}],current:0});
   if(p.includes('/intents'))return ok({items:[node],completed_count:1});
   if(p==='/api/exploration/activity/history')return ok({items:[activity],snapshot_cursor:1,cursor:1,earliest_cursor:1,latest_cursor:1,has_more:false,running:false});
   if(p.endsWith('/turns'))return ok({items:[{turn_id:'fixture-turn',role:'worker',worker:'work#1',status:'completed',revision:1,started_at:ts,finished_at:ts,models:['fixture'],steps:2,tool_calls:0,failed_tool_calls:0,final_activity:activity,
    usage:{input:980,...known?{uncached_input:100}:{},output:20,cache_read:800,cache_write:80,total:1000,incomplete:!known,source:'usage_ledger',compaction_requests:0,compaction_tokens:0,failed_requests:0,failed_request_tokens:0}}]});
   if(p==='/api/exploration/tokens')return ok({total:usage,workers:[],sessions:[{session:'intent:201',...usage}]});
   if(p==='/api/llm/records/by-model')return ok({models:[{model:'fixture-model',...usage}]});
   if(p==='/api/tokens/usage')return ok({total:usage,by_profile:[],daily:[{date:'2026-11-18',profile_id:null,profile_name:'fixture',...usage}]});
   if(p.includes('/findings'))return ok([]);
   if(p.endsWith('/agents'))return ok({agents:[]});
   if(p.includes('/llm')||p.includes('/profiles'))return ok([]);
   if(p.endsWith('/status'))return ok({running:false,initialized:true});
   return ok({items:[],total:0,goals:[],constraints:[],conversations:[],sources:[],assets:[],rows:[],scope:[],servers:[],skills:[],tools:[],counts:{}});
  });
  const page=await context.newPage();page.setDefaultTimeout(20000);page.setDefaultNavigationTimeout(120000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/function/tasks/detail?id=501&tab=sessions&section=chat&intent=201');
  const worker=page.getByRole('button',{name:/#201.*核对合成文件/});
  await worker.waitFor({timeout:5000}).catch(async()=>{await page.getByRole('button',{name:'执行过程',exact:true}).click();});
  await worker.click();
  await page.getByText('非缓存输入',{exact:true}).first().waitFor();
  for(const label of ['缓存读取','缓存写入','输出',known?'总量':'总量（已记录）'])await page.getByText(label,{exact:true}).first().waitFor();
  const body=await page.locator('body').innerText();
  assert.ok(body.includes(known?'100':'未知'));
  await page.getByRole('button',{name:'执行详情',exact:true}).click();
  const popover=page.locator('[data-slot="popover-content"]');
  await popover.getByText('非缓存输入',{exact:true}).waitFor();
  assert.match(await popover.innerText(),known?/非缓存输入\s+100/:/非缓存输入\s+未知/);
  assert.match(await popover.innerText(),/总量\s+1,000/);
  await page.keyboard.press('Escape');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'session mobile layout overflows');
  if(process.env.FATE_SCREENSHOTS)await page.screenshot({path:`${process.env.FATE_SCREENSHOTS}/sessions-${width}-${known}.png`});
  await page.goto(origin+'/function/tasks/detail?id=501&section=overview');
  await page.getByText('LLM Token 用量',{exact:false}).first().waitFor();
  const model=page.getByRole('row').filter({hasText:'fixture-model'});
  await model.waitFor();
  const values=await model.locator('td').allTextContents();
  assert.equal(values[2],known?'100':'未知');
  assert.ok(values.includes('800')&&values.includes('80')&&values.includes('20'));
  assert.match(values[6],/^1\.0k/);
  if(process.env.FATE_SCREENSHOTS)await model.screenshot({path:`${process.env.FATE_SCREENSHOTS}/model-${width}-${known}.png`});
  await page.goto(origin+'/dashboard');
  await page.getByText('非缓存输入',{exact:true}).first().waitFor();
  assert.ok(!(await page.locator('body').innerText()).includes('未缓存输入'));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'dashboard mobile layout overflows');
  if(process.env.FATE_SCREENSHOTS)await page.screenshot({path:`${process.env.FATE_SCREENSHOTS}/dashboard-${width}-${known}.png`});
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
  console.log(`PASS token display ${width}px ${theme} ${known?'complete':'unknown'}`);
  await context.close();
 }
}finally{await browser.close();}
