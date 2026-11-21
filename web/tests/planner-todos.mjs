// Synthetic task API and SSE snapshots; never calls a model or writes backend data.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.FATE_TEST_ORIGIN;
assert.ok(origin);
const screenshots=process.env.FATE_SCREENSHOTS;
if(screenshots)mkdirSync(screenshots,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const ts='2026-11-21T00:00:00Z';
const initial=[{content:'确认登录入口与授权范围',status:'completed'},{content:'检查上传接口的访问控制',status:'in_progress'},{content:'等待普通用户测试账号',status:'pending',review:{state:'deferred',scope:'普通用户上传权限',reason:'当前只有管理员凭证',recovery:'提供普通用户测试账号后恢复',basis:[{node_id:42,version:1}]}}];
try{
 for(const [width,theme] of [[1440,'light'],[390,'light'],[1440,'dark']]){
  const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme});
  await context.addCookies([{name:'series_token',value:'fixture',url:origin},{name:'theme_mode',value:theme,url:origin}]);
  await context.addInitScript(()=>{
   localStorage.setItem('series_token','fixture');window.fixtureStreams=[];
   window.EventSource=class extends EventTarget{
    static CLOSED=2;readyState=1;
    constructor(url){super();this.url=url;window.fixtureStreams.push(this);setTimeout(()=>this.dispatchEvent(new Event('open')),0);}
    close(){this.readyState=2;}
   };
  });
  const profile={id:'1',name:'测试模型',model:'fixture',is_default:true};
  await context.route('**/*',route=>{
   const req=route.request(),url=new URL(req.url()),path=url.pathname,ok=json=>route.fulfill({status:200,json});
   if(url.origin!==origin)return route.abort();
   if(!path.startsWith('/api/'))return route.continue();
   assert.equal(req.method(),'GET','fixture must not write to the backend');
   if(path==='/api/tasks/501'||path==='/api/tasks/502')return ok({id:path.split('/').at(-1),name:'应用安全评估',status:'paused',paused:true,created_at:ts,updated_at:ts,exploration_id:301});
   if(path==='/api/llm/profiles')return ok({profiles:[profile]});
   if(path.endsWith('/llm/resolution'))return ok({mainagent:{profile_id:1},planner:{profile_id:1},worker:{profile_id:1}});
   if(path.endsWith('/session-model'))return ok({profile_id:1,resolution:{profile_id:1,name:'测试模型',model:'fixture',source:'global',available:true}});
   if(path==='/api/exploration/main-sessions')return ok({sessions:[{seq:0,created_at:ts}],current:0});
   if(path==='/api/exploration/activity/history')return ok({items:[],snapshot_cursor:0,cursor:0,has_more:false,running:false});
   if(path==='/api/exploration/tokens')return ok({total:{},workers:[],sessions:[]});
   if(path.endsWith('/status'))return ok({running:false,initialized:true});
   if(path.includes('/findings'))return ok([]);
   if(path==='/api/auth/me')return ok({username:'fixture'});
   return ok({items:[],total:0,tasks:[],agents:[],profiles:[],goals:[],constraints:[],sources:[],assets:[],rows:[],scope:[],servers:[],skills:[],tools:[],counts:{},categories:[]});
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(120000);
  await page.goto(origin+'/function/tasks/detail?id=501');
  await page.waitForFunction(()=>window.fixtureStreams.some(s=>s.url.includes('activity/stream')&&s.readyState===1));
  const emit=async items=>page.evaluate(items=>{
   const stream=window.fixtureStreams.findLast(s=>s.url.includes('activity/stream')&&s.readyState===1);
   stream.dispatchEvent(new MessageEvent('planner_todos',{data:JSON.stringify({items})}));
  },items);
  await emit(initial);
  // The Planner panel is selected on task open; both desktop process list and
  // the mobile Planner view must show the same committed snapshot.
  const list=page.getByRole('region',{name:'Planner 待办列表'}).first();
  try { await list.getByText(initial[1].content,{exact:true}).waitFor(); } catch(error) { await page.screenshot({path:'/tmp/fate-planner-todos-failure.png'}); console.log(await page.locator('body').innerText(), errors); throw error; }
  assert.equal(await list.getByRole('listitem').count(),3);
  await list.getByText('复核依据与恢复条件',{exact:true}).click();
  await list.getByText(initial[2].review.recovery,{exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
  if(screenshots)await page.screenshot({path:`${screenshots}/planner-todos-${width}-${theme}.png`});
  await emit([{content:'上传接口检查已完成',status:'completed'}]);
  await list.getByText('上传接口检查已完成',{exact:true}).waitFor();
  assert.equal(await list.getByRole('listitem').count(),1,'replacement removes old todos');
  await page.getByRole('button',{name:'收起 Planner 待办'}).first().click();
  await emit([{content:'折叠期间新增待办',status:'pending'}]);
  await page.getByRole('button',{name:'展开 Planner 待办'}).first().click();
  await list.getByText('折叠期间新增待办',{exact:true}).waitFor();
  await page.evaluate(()=>{const stream=window.fixtureStreams.findLast(s=>s.readyState===1);stream.readyState=2;stream.dispatchEvent(new Event('error'));});
  await page.getByText('连接恢复后自动同步',{exact:true}).first().waitFor();
  await page.waitForFunction(()=>window.fixtureStreams.filter(s=>s.url.includes('activity/stream')).length>=2&&window.fixtureStreams.at(-1).readyState===1);
  await emit([]);
  await page.getByText('暂无待办',{exact:true}).first().waitFor();
  assert.equal(await page.getByRole('region',{name:'Planner 待办列表'}).count(),0,'clear removes the list');
  const many=Array.from({length:50},(_,i)=>({content:`待办 ${i+1} ${'long-target-'.repeat(15)}`,status:'pending'}));
  await emit(many);
  await list.getByText(many[49].content,{exact:true}).scrollIntoViewIfNeeded();
  assert.equal(await list.getByRole('listitem').count(),50);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'long todos remain within the viewport');
  await emit(initial);
  await list.getByText(initial[0].content,{exact:true}).waitFor();
  await page.goto(origin+'/function/tasks/detail?id=502');
  await page.waitForFunction(()=>window.fixtureStreams.some(s=>s.url.includes('task=502')&&s.readyState===1));
  assert.equal(await page.getByText(initial[0].content,{exact:true}).count(),0,'task switch clears old snapshot');
  await emit([]);
  await page.getByText('暂无待办',{exact:true}).first().waitFor();
  assert.deepEqual(errors,[]);
  console.log(`PASS Planner todos ${width}px ${theme}: display, update, clear, collapse, reconnect, task switch`);
  await context.close();
 }
}finally{await browser.close();}
