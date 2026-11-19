// Isolated frontend test: synthetic API only, no backend or real Worker.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.FATE_TEST_ORIGIN;
assert.ok(origin,'FATE_TEST_ORIGIN is required');
if(process.env.FATE_SCREENSHOTS)mkdirSync(process.env.FATE_SCREENSHOTS,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:1000}});
  await context.addCookies([{name:'series_token',value:'fixture',url:origin}]);
  await context.addInitScript(()=>{localStorage.setItem('series_token','fixture');window.EventSource=class extends EventTarget{static CLOSED=2;readyState=1;close(){this.readyState=2;}};});
  const ts=new Date().toISOString(),requests=[],errors=[];
  let response='queued';
  const task={id:'501',name:'Worker 对话合成测试',goal:'核对本地文本',status:'running',paused:false,created_at:ts,updated_at:ts,exploration_id:301};
  const nodes=[['201','running'],['202','running'],['203','paused'],['204','done']].map(([id,state])=>({id,type:'intent',state,owner:`work#${id}`,payload:JSON.stringify({summary:`核对文本 ${id}`}),origin:'planner',ts}));
  const records=[];
  await context.route('**/*',route=>{
    const req=route.request(),u=new URL(req.url()),p=u.pathname,ok=json=>route.fulfill({status:200,json});
    if(u.origin!==origin)return route.abort();
    if(!p.startsWith('/api/'))return route.continue();
    if(req.method()!=='GET'){
      assert.match(p,/^\/api\/tasks\/501\/intents\/20[12]\/messages$/);
      const body=req.postDataJSON();requests.push({path:p,...body});
      if(response==='error')return route.fulfill({status:409,json:{error:'Worker 已退出，请刷新'}});
      const intent=p.split('/')[5];
      records.push({seq:records.length+1,kind:'status',tool:'steer_work',summary:body.message,detail:body.message,ts,worker:`work#${intent}`,intent_id:intent,
        metadata:{event_type:'steering',turn_id:`turn-${intent}`,source:'user',steering:{id:`s-${records.length}`,source:'user',intent_id:intent,target_turn_id:`turn-${intent}`,status:response==='handled'?'handled':'submitted'}}});
      return route.fulfill({status:202,json:{id:'receipt',intent_id:Number(intent),turn_id:`turn-${intent}`,status:response}});
    }
    if(p==='/api/tasks/501')return ok(task);
    if(p==='/api/tasks')return ok({tasks:[task],total:1});
    if(p==='/api/tasks/summary')return ok({total:1,by_status:{running:1}});
    if(p==='/api/exploration/main-sessions')return ok({sessions:[{seq:0,created_at:ts}],current:0});
    if(p.includes('/intents'))return ok({items:nodes,completed_count:1});
    if(p==='/api/exploration/activity/history')return ok({items:records,snapshot_cursor:records.length,cursor:records.length,earliest_cursor:1,latest_cursor:records.length,has_more:false,running:false});
    if(p.endsWith('/turns'))return ok({items:[]});
    if(p==='/api/exploration/tokens')return ok({workers:[],sessions:[]});
    if(p.includes('/findings'))return ok([]);
    if(p.endsWith('/agents'))return ok({agents:[]});
    if(p.includes('/llm')||p.includes('/profiles'))return ok([]);
    if(p.endsWith('/status'))return ok({running:false,initialized:true});
    return ok({items:[],total:0,goals:[],constraints:[],conversations:[],sources:[],assets:[],rows:[],scope:[],servers:[],skills:[],tools:[],counts:{}});
  });
  const page=await context.newPage();page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(120000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/function/tasks/detail?id=501&tab=sessions&section=chat&intent=201');
  async function select(id){
    const button=page.getByRole('button',{name:new RegExp(`#${id}.*核对文本`)});
    await button.waitFor({timeout:3000}).catch(()=>{});
    if(!await button.isVisible()){
      const back=page.getByRole('button',{name:'返回列表',exact:true});
      if(await back.isVisible())await back.click();
      else await page.getByRole('button',{name:'执行过程',exact:true}).click();
    }
    await button.click().catch(async error=>{console.error(await page.locator('body').innerText());throw error;});
  }
  await select('201');
  let composer=page.getByRole('form',{name:'直接对话 Worker #201'}),input=composer.getByRole('textbox');
  await input.fill('201 的独立草稿');
  await select('202');
  await page.getByRole('form',{name:'直接对话 Worker #202'}).getByRole('textbox').fill('202 的独立草稿');
  await select('201');
  assert.equal(await input.inputValue(),'201 的独立草稿');
  response='error';await composer.getByRole('button',{name:'发送给 Worker'}).click();
  await composer.getByRole('alert').waitFor();assert.equal(await input.inputValue(),'201 的独立草稿');
  response='queued';await composer.getByRole('button',{name:'发送给 Worker'}).click();
  await composer.getByText(/消息已排队/).waitFor();assert.equal(await input.inputValue(),'');
  assert.equal(requests.at(-1).path,'/api/tasks/501/intents/201/messages');
  await page.getByRole('note',{name:'用户 纠偏提醒'}).first().waitFor();
  response='handled';await input.fill('扩展处理消息');await input.press('Enter');
  await composer.getByText('消息已由 PI 扩展处理。',{exact:true}).waitFor();
  await input.fill('过'.repeat(4001));assert.equal(await composer.getByRole('button',{name:'发送给 Worker'}).isDisabled(),true);
  await input.fill('下次发送的草稿');
  await composer.getByRole('button',{name:'发送给 Worker'}).click({trial:true});
  assert.equal(await input.getAttribute('aria-invalid'),'false');
  await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',keyCode:229,isComposing:true});
  assert.equal(requests.length,3,'IME confirmation must not send');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile layout overflow');
  if(process.env.FATE_SCREENSHOTS)await page.screenshot({path:`${process.env.FATE_SCREENSHOTS}/worker-steering-${width}.png`});
  for(const id of ['203','204']){
    await select(id);
    assert.equal(await page.getByRole('form',{name:`直接对话 Worker #${id}`}).getByRole('textbox').isDisabled(),true);
  }
  assert.deepEqual(errors,[]);assert.equal(requests.length,3);
  console.log(`PASS Worker direct steering ${width}px: drafts, failure, queued, handled, limits, read-only`);
  await context.close();
}}finally{await browser.close();}
