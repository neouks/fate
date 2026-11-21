// Shared composer UI: real persistence when an isolated conversation is supplied,
// otherwise browser mock only. No model requests are sent by this script.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHmac} from 'node:crypto';
import {readFileSync,mkdirSync} from 'node:fs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const live=!!process.env.FATE_TEST_CONVERSATION,id=process.env.FATE_TEST_CONVERSATION||'1';
const origin=process.env.FATE_TEST_ORIGIN||(live?'http://127.0.0.1:8787':'http://127.0.0.1:3001');
let token='';
if(live){const key=readFileSync(process.env.FATE_TEST_JWT_KEY_FILE,'utf8').trim(),now=Math.floor(Date.now()/1000),payload=[{alg:'HS256',typ:'JWT'},{sub:'SERIES',iat:now,exp:now+3600}].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');token=payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');}
async function api(body){const r=await fetch(`${origin}/api/conversations/${id}/controls`,{method:body?'PATCH':'GET',headers:{'X-Series-Token':token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});assert.equal(r.status,200);return r.json();}
const original=live?await api():null,out=process.env.FATE_SCREENSHOTS;if(out)mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 for(const [width,theme] of [[1440,'light'],[390,'light'],[1440,'dark']]){
  const ctx=await browser.newContext({viewport:{width,height:900},colorScheme:theme});
  await ctx.addCookies([{name:'theme_mode',value:theme,url:origin},...(token?[{name:'series_token',value:token,url:origin}]:[])]);
  if(token)await ctx.addInitScript(token=>localStorage.setItem('series_token',token),token);
  const page=await ctx.newPage(),errors=[];page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${origin}/chat?c=${id}`);await page.addStyleTag({content:'nextjs-portal{display:none!important}'});
  const thinking=page.getByRole('combobox',{name:'切换推理强度',exact:true}),tools=page.getByRole('combobox',{name:'切换工具预设',exact:true});
  await page.getByRole('textbox',{name:'会话消息',exact:true}).fill('配置切换期间保留草稿');
  if(width<768)await page.getByRole('button',{name:'更多控件',exact:true}).click();
  await page.waitForFunction(()=>{const el=document.querySelector('[aria-label="切换推理强度"]');return el&&!el.disabled;});
  if(width<768&&!await thinking.isVisible())await page.getByRole('button',{name:'更多控件',exact:true}).click();
  await thinking.click();
  await page.getByRole('option').filter({hasText:'中等强度推理'}).click();
  await page.getByText('已保存，当前会话的下次执行生效',{exact:true}).first().waitFor();
  await page.waitForFunction(()=>!document.querySelector('[aria-label="切换推理强度"]').disabled);
  assert.equal(await page.getByRole('textbox',{name:'会话消息',exact:true}).inputValue(),'配置切换期间保留草稿');
  if(live){assert.equal((await api()).thinking_level,'medium');await page.reload();if(width<768)await page.getByRole('button',{name:'更多控件',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[aria-label="切换推理强度"]')?.disabled);}
  await thinking.click();const menu=page.locator('.pi-config-menu');
  await page.getByText('使用 pi 默认设置',{exact:true}).waitFor();
  assert.equal(await menu.locator('[data-state="checked"]').filter({hasText:'中等强度推理'}).count(),1);
  await menu.evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished.catch(()=>{}))));
  const row=page.getByRole('option').filter({hasText:'中等强度推理'});
  assert.equal(Math.round((await row.boundingBox()).height),32);
  assert.equal(await row.evaluate(e=>getComputedStyle(e).fontSize),'12px');
  const bounds=await menu.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.pi-config-menu')).opacity==='1');
  if(out)await page.screenshot({path:`${out}/reasoning-${width}-${theme}.png`,animations:'disabled'});
  await page.keyboard.press('Home');await page.waitForFunction(()=>document.activeElement===document.querySelector('[role=option]'));await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('[aria-label="切换推理强度"]')?.textContent==='auto');
  await tools.click();assert.equal(await page.getByRole('option').count(),5);
  if(out)await page.screenshot({path:`${out}/tools-${width}-${theme}.png`,animations:'disabled'});
  await page.getByRole('option').filter({hasText:'chat-only'}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="切换工具预设"]')?.textContent==='chat-only');
  if(live)assert.equal((await api()).tool_preset,'none');
  await page.getByRole('button',{name:'开启完成提示音',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'关闭完成提示音',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.evaluate(()=>localStorage.getItem('series:completion-sound')),'true');
  await page.getByRole('button',{name:'关闭完成提示音',exact:true}).click();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.equal(await page.locator('.conversation-composer select:visible').count(),0);
  assert.deepEqual(errors,[]);console.log(`PASS ${live?'live':'mock'} pi composer ${width}px ${theme}`);await ctx.close();
 }
}finally{if(original)await api({thinking_level:original.thinking_level,tool_preset:original.tool_preset});await browser.close();}
