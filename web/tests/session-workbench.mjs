// Synthetic API only: no real model requests or backend writes.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.FATE_TEST_ORIGIN;
assert.ok(origin);
const screenshots=process.env.FATE_SCREENSHOTS;
if(screenshots)mkdirSync(screenshots,{recursive:true});
const ts='2026-11-21T00:00:00Z';
const usage={input_tokens:3100,uncached_input_tokens:1000,output_tokens:500,cache_read_tokens:2000,cache_write_tokens:100,input_semantics:'inclusive_cache',usage_complete:true,input_complete:true};
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  for(const [width,theme] of [[1440,'light'],[390,'light'],[1440,'dark']]) {
    const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme});
    await context.addCookies([{name:'series_token',value:'fixture',url:origin},{name:'theme_mode',value:theme,url:origin}]);
    await context.addInitScript(()=>{localStorage.setItem('series_token','fixture');window.EventSource=class extends EventTarget{static CLOSED=2;readyState=1;close(){this.readyState=2;}};});
    let conversations=[{id:1,title:'梳理应用架构与接口边界',agent_key:'auto',agent_name:'自动助手',created_at:ts,updated_at:ts},{id:2,title:'整理安全评估交付文档',agent_key:'auto',created_at:ts,updated_at:ts}];
    const messages=[{seq:1,kind:'user',summary:'请帮我梳理这个应用的架构，并列出接下来需要核对的内容。',detail:'请帮我梳理这个应用的架构，并列出接下来需要核对的内容。',ts,worker:'user',metadata:{attachments:[{name:'architecture.md',path:'uploads/architecture.md',size:2800}]}},{seq:2,kind:'text',summary:'应用由三个主要部分组成。',detail:'应用由三个主要部分组成。\n\n| 模块 | 职责 |\n| --- | --- |\n| Web 工作区 | 会话、任务与配置管理 |\n| 调度服务 | Agent 执行与状态同步 |\n| 请求账本 | 记录输入、输出和缓存用量 |\n\n建议先检查身份验证与任务边界，再核对模型配置和工具权限。',ts,worker:'assistant'}];
    const profile={id:'1',name:'测试模型',model:'fixture-model',context_window_k:128,reasoning_effort:'medium',is_default:true,format:'openai',rate_per_second:0,rate_per_minute:0};
    const errors=[];const writes=[];
    await context.route('**/*',route=>{
      const req=route.request(),u=new URL(req.url()),p=u.pathname,ok=json=>route.fulfill({status:200,json});
      if(u.origin!==origin)return route.abort();
      if(!p.startsWith('/api/'))return route.continue();
      if(req.method()!=='GET') {
        writes.push(p);
        if(p==='/api/conversations/1'&&req.method()==='PATCH'){conversations[0]={...conversations[0],...req.postDataJSON()};return ok(conversations[0]);}
        if(p==='/api/conversations/1/profile')return ok({ok:true});
        if(p==='/api/conversations') {const row={id:3,...req.postDataJSON(),created_at:ts,updated_at:ts};conversations=[row,...conversations];return ok(row);}
        if(p==='/api/conversations/1/messages')return ok({status:'accepted'});
        return route.abort();
      }
      if(p==='/api/conversations')return ok({conversations});
      if(p==='/api/conversations/1/usage')return ok({total:usage,models:[{model:'fixture-model',...usage}],context:{tokens:3600,model:'fixture-model',profile_id:1,at:ts}});
      if(p.endsWith('/usage'))return ok({total:usage,by_profile:[],daily:[]});
      if(p.match(/conversations\/\d+\/messages$/))return ok({items:p.includes('/1/')?messages:[],cursor:2,hasMore:false,running:false});
      if(p.match(/conversations\/\d+\/messages\/\d+$/))return ok({detail:messages[1].detail});
      if(p==='/api/agents')return ok({agents:[{id:'1',key:'auto',name:'自动助手',role:'assistant',enabled:true,builtin:true}]});
      if(p==='/api/llm/profiles')return ok({profiles:[profile]});
      if(p==='/api/tasks')return ok({tasks:[{id:'501',name:'应用安全评估',status:'paused',created_at:ts,updated_at:ts,description:'合成任务',goal:'梳理应用边界'}],total:1});
      if(p==='/api/tasks/501')return ok({id:'501',name:'应用安全评估',status:'paused',paused:true,created_at:ts,updated_at:ts,exploration_id:301,tokens:usage});
      if(p==='/api/tasks/501/session-model')return ok({profile_id:null,resolution:{profile_id:1}});
      if(p==='/api/tasks/501/llm/resolution')return ok({mainagent:{profile_id:1}});
      if(p==='/api/tasks/501/session-usage')return ok({total:usage,models:[{model:'fixture-model',...usage}],context:{tokens:3600,model:'fixture-model',profile_id:1,at:ts}});
      if(p==='/api/exploration/main-sessions')return ok({sessions:[{seq:0,created_at:ts}],current:0});
      if(p==='/api/exploration/activity/history')return ok({items:[],snapshot_cursor:0,cursor:0,has_more:false,running:false});
      if(p==='/api/exploration/tokens')return ok({total:usage,workers:[],sessions:[]});
      if(p.endsWith('/status'))return ok({running:false,initialized:true});
      if(p.includes('/findings'))return ok([]);
      if(p==='/api/tasks/summary')return ok({total:1,by_status:{paused:1}});
      if(p==='/api/auth/me')return ok({username:'SERIES'});
      if(p==='/api/stats')return ok({assets:24,findings:3,tasks:1,engine_mode:'idle'});
      return ok({items:[],total:0,agents:[],profiles:[profile],goals:[],constraints:[],sources:[],assets:[],rows:[],scope:[],servers:[],skills:[],tools:[],counts:{},categories:[]});
    });
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(120000);
    await page.goto(origin+'/chat?c=1');
    await page.addStyleTag({content:'nextjs-portal { display: none !important; }'});
    await page.getByRole('textbox',{name:'会话消息',exact:true}).fill('abcd你好');
    await page.getByRole('button',{name:'当前上下文使用情况',exact:true}).click();
    await page.getByText(/草稿 ≈ 4 tokens/).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'会话信息：上下文与消费预估'}).click();
    await page.getByText('累计费用估算 · USD').waitFor();
    await page.getByLabel('非缓存输入',{exact:true}).fill('3');
    await page.getByLabel('输出',{exact:true}).fill('15');
    await page.getByLabel('缓存读取',{exact:true}).fill('0.3');
    await page.getByLabel('缓存写入',{exact:true}).fill('5');
    await page.getByText('$0.01',{exact:true}).first().waitFor();
    assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'),'2.8125');
    await page.getByText('最近请求上下文 · 快照',{exact:true}).scrollIntoViewIfNeeded();
    if(screenshots)await page.screenshot({path:`${screenshots}/chat-usage-${width}-${theme}.png`});
    await page.getByRole('button',{name:'关闭会话信息',exact:true}).click();
    await page.getByRole('button',{name:'对话目录',exact:true}).click();
    await page.locator('.pi-web-outline-row').first().click();
    if(width>=1280)await page.getByRole('button',{name:'关闭侧栏',exact:true}).click();
    await page.getByRole('button',{name:'重命名',exact:true}).click();
    await page.getByRole('textbox',{name:'标题',exact:true}).fill('已重命名的架构会话');
    await page.getByRole('button',{name:'保存',exact:true}).click();
    await page.getByRole('heading',{name:'已重命名的架构会话',exact:true}).waitFor();
    if(width<768)await page.getByRole('button',{name:'切换会话列表',exact:true}).click();
    await page.getByRole('button',{name:'搜索会话',exact:true}).click();
    await page.getByRole('searchbox',{name:'搜索会话',exact:true}).fill('交付');
    await page.getByTitle('整理安全评估交付文档',{exact:true}).waitFor();
    assert.equal(await page.locator('.pi-web-session-row').count(),1);
    await page.getByRole('searchbox',{name:'搜索会话',exact:true}).fill('');
    if(width<768){await page.getByRole('button',{name:'关闭会话列表',exact:true}).click();await page.getByRole('dialog',{name:'会话列表',exact:true}).waitFor({state:'hidden'});}
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow');
    if(screenshots)await page.screenshot({path:`${screenshots}/chat-${width}-${theme}.png`});
    await page.getByRole('button',{name:'工具',exact:true}).click();
    await page.getByRole('dialog').getByRole('heading',{name:'工具',exact:true}).waitFor();
    await page.getByRole('button',{name:'关闭设置',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    await page.goto(origin+'/function/tasks');
    await page.addStyleTag({content:'nextjs-portal { display: none !important; }'});
    await page.getByRole('heading').first().waitFor();
    if(screenshots)await page.screenshot({path:`${screenshots}/tasks-${width}-${theme}.png`});
    if(width>=768){
      await page.getByRole('button',{name:'模型配置',exact:true}).click();
      await page.getByRole('dialog').getByRole('heading',{name:'模型配置',exact:true}).waitFor();
      await page.getByRole('dialog').getByText('fixture-model',{exact:true}).first().waitFor();
      if(screenshots)await page.screenshot({path:`${screenshots}/settings-${width}-${theme}.png`});
      await page.getByRole('button',{name:'关闭设置',exact:true}).click();
    }
    await page.goto(origin+'/function/tasks/detail?id=501&tab=sessions&section=chat');
    await page.getByRole('button',{name:'主对话',exact:true}).click();
    await page.getByRole('button',{name:'会话信息：上下文与消费预估'}).click();
    await page.getByRole('progressbar').waitFor();
    assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'),'2.8125');
    await page.getByText('$0.01',{exact:true}).first().waitFor();
    if(screenshots)await page.screenshot({path:`${screenshots}/task-usage-${width}-${theme}.png`});
    assert.deepEqual(errors,[]);
    assert.deepEqual(writes,['/api/conversations/1']);
    console.log(`PASS workbench ${width}px ${theme}`);
    await context.close();
  }
} finally {await browser.close();}
