// Opt-in integration regression against the running authenticated server and real DB.
// Only session model overrides are changed, and every original value is restored.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.FATE_TEST_ORIGIN||'http://127.0.0.1:8787';
const task=process.env.FATE_TEST_TASK;
const sessions=(process.env.FATE_TEST_SESSIONS||'').split(',').filter(Boolean);
assert.ok(task&&sessions.length,'Set FATE_TEST_TASK and FATE_TEST_SESSIONS');
let token=process.env.FATE_TEST_TOKEN;
if(!token&&process.env.FATE_TEST_JWT_KEY_FILE){
 const key=readFileSync(process.env.FATE_TEST_JWT_KEY_FILE,'utf8').trim();
 const now=Math.floor(Date.now()/1000);
 const body=[{alg:'HS256',typ:'JWT'},{sub:'SERIES',iat:now,exp:now+3600}].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
 token=body+'.'+createHmac('sha256',key).update(body).digest('base64url');
}
assert.ok(token,'Provide test authentication');
const out=process.env.FATE_SCREENSHOTS;
if(out)mkdirSync(out,{recursive:true});
async function api(path,body){
 const r=await fetch(origin+'/api'+path,{method:body?'PATCH':'GET',headers:{'X-Series-Token':token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 assert.equal(r.status,200,path);return r.json();
}
const modelURL=s=>`/tasks/${task}/session-model?${new URLSearchParams({session:s})}`;
const profiles=(await api('/llm/profiles')).profiles;
const originals=new Map(await Promise.all(sessions.map(async s=>[s,await api(modelURL(s))])));
const changed=new Set();
const chatID=process.env.FATE_TEST_CONVERSATION;
const originalChat=chatID?(await api('/conversations')).conversations.find(c=>String(c.id)===chatID):null;
if(chatID)assert.ok(originalChat&&!originalChat.running&&!originalChat.read_only,'Use an idle writable conversation');
let chatChanged=false;
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 for(const [width,theme] of [[1440,'light'],[390,'light'],[1440,'dark']]){
  const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme});
  await context.addCookies([{name:'series_token',value:token,url:origin},{name:'theme_mode',value:theme,url:origin}]);
  await context.addInitScript(token=>localStorage.setItem('series_token',token),token);
  const page=await context.newPage(),errors=[],failures=[];
  page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(120000);
  page.on('pageerror',e=>errors.push(e.message));
  const record=r=>{if(/\/api\/.*(?:session-model|session-usage|\/usage|llm\/profiles)/.test(r.url())&&r.status()>=400)failures.push([r.status(),new URL(r.url()).pathname]);};
  page.on('response',record);
  const model=()=>page.getByRole('combobox',{name:'会话模型',exact:true});
  const usage=()=>page.getByRole('button',{name:'当前上下文使用情况',exact:true});
  const shot=async name=>{if(out)await page.screenshot({animations:'disabled',path:`${out}/${name}-${width}-${theme}.png`});};
  async function ready(){
   await model().waitFor();
   await page.waitForFunction(()=>{const e=document.querySelector('[aria-label="会话模型"]');return e&&!e.textContent.includes('读取')&&!e.textContent.includes('选择模型');});
   await page.waitForFunction(()=>{const e=document.querySelector('[aria-label="当前上下文使用情况"]');return e&&!e.textContent.includes('读取');});
  }
  if(chatID){
   await page.goto(origin+`/chat?c=${chatID}`);await ready();
   await usage().click();await page.getByText('缓存命中率',{exact:true}).waitFor();
   await shot('live-independent');await page.keyboard.press('Escape');
   await model().click();await page.getByRole('combobox',{name:'筛选模型',exact:true}).fill('no-matching-profile-for-regression');
   await page.getByText('没有匹配的模型',{exact:true}).waitFor();await page.keyboard.press('Escape');
   if(width===1440&&theme==='light'&&process.env.FATE_TEST_ALLOW_MODEL_WRITES==='1'){
    const label=await model().innerText();
    const target=profiles.find(p=>!label.includes(p.model))||profiles[0];
    chatChanged=true;await model().click();
    await page.getByRole('combobox',{name:'筛选模型',exact:true}).fill(target.model);
    await page.getByTitle(target.name,{exact:true}).click();
    await page.waitForFunction(m=>document.querySelector('[aria-label="会话模型"]')?.textContent.includes(m),target.model);
    assert.equal((await api('/conversations')).conversations.find(c=>String(c.id)===chatID).llm_profile_id,Number(target.id));
    await page.reload();await ready();assert.ok((await model().innerText()).includes(target.model));
    await api(`/conversations/${chatID}/profile`,{llm_profile_id:originalChat.llm_profile_id});chatChanged=false;
   }
   assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   console.log(`PASS live independent conversation ${width}px ${theme}`);
   if(process.env.FATE_TEST_ONLY_CHAT==='1'){await context.close();continue;}
  }
  for(const session of sessions){
   await page.goto(origin+`/function/tasks/detail?id=${task}`);
   const name=session.startsWith('main:')?`主 Agent · 会话 #${Number(session.split(':')[1])+1}`:session==='plan'?'目标与规划 · Goals / Planner':new RegExp('^#'+session.split(':')[1]+' ');
   const targetSession=page.getByRole('button',{name,exact:typeof name==='string'});
   await ready();
   if(await page.getByRole('button',{name:'执行过程',exact:true}).getAttribute('aria-expanded')!=='true')await page.getByRole('button',{name:'执行过程',exact:true}).click();
   try { await targetSession.click(); } catch (e) {
    await shot('failed-session');
    console.log('Navigation diagnostics',page.url(),await page.getByRole('button',{name:'执行过程',exact:true}).getAttribute('aria-expanded'));
    throw e;
   }
   await page.addStyleTag({content:'nextjs-portal{display:none!important}'});
   await ready();
   const original=originals.get(session);
   assert.ok((await model().innerText()).includes(original.resolution.model));
   const data=await api(`/tasks/${task}/session-usage?${new URLSearchParams({session})}`);
   assert.ok(data.total&&data.context,'complete usage shape');
   if(data.context.tokens!==null)assert.match(await usage().innerText(),/%/);
   await usage().click();await page.getByText('缓存命中率',{exact:true}).waitFor();
   await shot('live-'+session.replace(':','-'));
   await page.keyboard.press('Escape');
   if(width===1440&&theme==='light'&&process.env.FATE_TEST_ALLOW_MODEL_WRITES==='1'&&!await model().isDisabled()){
    const target=profiles.find(p=>Number(p.id)!==Number(original.resolution.profile_id))||profiles[0];
    await model().click();await page.getByTitle(target.name,{exact:true}).click();changed.add(session);
    await page.getByText('已保存，仅此会话的下次执行使用新模型。',{exact:true}).waitFor();
    const saved=await api(modelURL(session));
    assert.equal(saved.profile_id,Number(target.id));assert.equal(saved.resolution.profile_id,Number(target.id));
    await page.reload();
    await ready();
   if(await page.getByRole('button',{name:'执行过程',exact:true}).getAttribute('aria-expanded')!=='true')await page.getByRole('button',{name:'执行过程',exact:true}).click();
    await targetSession.click();await ready();assert.ok((await model().innerText()).includes(target.model));
    for(const other of sessions.filter(s=>s!==session))assert.equal((await api(modelURL(other))).profile_id,originals.get(other).profile_id,'session isolation');
    await api(`/tasks/${task}/session-model`,{session,profile_id:original.profile_id});changed.delete(session);
   }
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow');
  }
  assert.deepEqual(failures,[],'real API failures');
  page.off('response',record);
  // Simulate the exact stale-server failure without changing the real server.
  const modelRoute=`**/api/tasks/${task}/session-model*`, usageRoute=`**/api/tasks/${task}/session-usage*`;
  await page.route(modelRoute,r=>r.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'not found'})}));
  await page.route(usageRoute,r=>r.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'internal database detail'})}));
  await page.reload();
  const lastSession=page.getByRole('button',{name:new RegExp('^#'+sessions.at(-1).split(':')[1]+' ')});
  await model().waitFor();
  if(await page.getByRole('button',{name:'执行过程',exact:true}).getAttribute('aria-expanded')!=='true')await page.getByRole('button',{name:'执行过程',exact:true}).click();
  await lastSession.click();
  await page.getByText('当前服务尚未提供会话模型接口，请更新并重启后端后重试。',{exact:true}).waitFor();
  assert.equal(await model().isDisabled(),true);
  assert.equal(await usage().innerText(),'用量暂不可用');
  await shot('stale-server');
  await page.unroute(modelRoute);await page.unroute(usageRoute);
  await page.getByRole('button',{name:'重试模型',exact:true}).click();
  await usage().click();await page.getByRole('button',{name:'重试用量',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="当前上下文使用情况"]')?.textContent.includes('%'));
  await page.keyboard.press('Escape');await ready();
  assert.equal(await page.getByText('会话模型暂不可用',{exact:true}).count(),0);
  // A failed save must not claim success or change the persisted selection.
  const last=sessions.at(-1), before=await api(modelURL(last));
  await page.route(modelRoute,r=>r.request().method()==='PATCH'?r.fulfill({status:500,contentType:'application/json',body:'{"error":"database offline"}'}):r.continue());
  await model().click();await page.getByTitle(profiles[0].name,{exact:true}).click();
  await page.getByText('会话模型读取或保存失败，请检查服务连接后重试。',{exact:true}).waitFor();
  assert.equal((await api(modelURL(last))).profile_id,before.profile_id);
  assert.equal(await page.getByText('已保存，仅此会话的下次执行使用新模型。',{exact:true}).count(),0);
  await page.unroute(modelRoute);await page.getByRole('button',{name:'重试模型',exact:true}).click();await ready();
  assert.deepEqual(errors,[]);
  console.log(`PASS live sessions + 404/500/retry/save failure ${width}px ${theme}`);
  await context.close();
 }
}finally{
 if(chatChanged)await api(`/conversations/${chatID}/profile`,{llm_profile_id:originalChat.llm_profile_id});
 for(const session of changed)await api(`/tasks/${task}/session-model`,{session,profile_id:originals.get(session).profile_id});
 await browser.close();
}
for(const session of sessions)assert.equal((await api(modelURL(session))).profile_id,originals.get(session).profile_id,'original model restored');
if(chatID)assert.equal((await api('/conversations')).conversations.find(c=>String(c.id)===chatID).llm_profile_id,originalChat.llm_profile_id);
console.log('PASS all original session model settings restored');
