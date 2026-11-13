// Synthetic UI checks: intercept every API call, never call a model or production backend.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.FATE_TEST_ORIGIN;assert.ok(origin);
const browser=await chromium.launch({channel:'chrome',headless:true});
try {for(const [width,theme] of [[1440,'light'],[390,'dark']]){
 const writes=[],errors=[];let enabled=false;
 const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme});
 await context.addCookies([{name:'series_token',value:'fixture',url:origin},{name:'theme_mode',value:theme,url:origin}]);await context.addInitScript(()=>localStorage.setItem('series_token','fixture'));
 const rule={attempts:0,interval_ms:0};
 const profile={id:'1',name:'DeepSeek 合成配置',format:'openai',model:'deepseek-flash',base_url:'http://fixture.invalid',api_key_hint:'configured',thinking_type:'medium',reasoning_effort:'',context_window_k:258,is_default:true,streaming:true,retry:{connect:rule,empty:rule,stream:rule}};
 await context.route('**/*',route=>{
  const r=route.request(),u=new URL(r.url()),p=u.pathname,ok=json=>route.fulfill({json});
  if(u.origin!==origin)return route.abort();if(!p.startsWith('/api/'))return route.continue();
  if(r.method()!=='GET')writes.push({path:p,body:r.postDataJSON()});
  if(p==='/api/llm/profiles')return ok(r.method()==='GET'?{profiles:[profile,{...profile,id:'2',name:'备用合成配置',is_default:false}]}:{id:1});
  if(p==='/api/llm/models')return ok({ok:true,models:['deepseek-flash']});
  if(p==='/api/llm/pool')return ok({enabled,bind_fallback:false,chain:[]});
  if(p==='/api/settings'){if(r.method()!=='GET')enabled=r.postDataJSON().llm_pool_enabled??enabled;return ok({workers:2});}
  if(p==='/api/llm/retry-policy')return ok({connect:rule,breaker:rule,empty:rule,stream:rule,intent:rule});
  if(p==='/api/llm/preview')return ok({mode:'enabled',effort:'max',contextWindow:258000,outputLimit:null,streaming:true,minRequestIntervalMs:0,outputField:'max_tokens'});
  if(p==='/api/llm/test')return ok({ok:true,latency_ms:1,model:'deepseek-flash',reply:'synthetic pong'});
  if(p.includes('status'))return ok({initialized:true,running:false});
  return ok({items:[],tasks:[],categories:[],agents:[],conversations:[]});
 });
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 try {
  await page.goto(origin+'/system/llm');await page.getByText('DeepSeek 合成配置',{exact:true}).click();
  const dialog=page.getByRole('dialog').last();
  await dialog.getByTitle('从 API 加载可用模型').click();await page.getByRole('button',{name:'deepseek-flash',exact:true}).click();
  await dialog.getByRole('button',{name:'预览实际配置',exact:true}).click();await page.getByText('实际配置 · 下次会话装配生效',{exact:true}).waitFor();
  await dialog.getByRole('combobox').filter({hasText:'high'}).click();await page.getByRole('option',{name:'max',exact:true}).click();
  await dialog.getByRole('button',{name:/测试连接/}).click();
  assert.equal(writes.find(x=>x.path==='/api/llm/test').body.reasoning_effort,'max');assert.equal(writes.find(x=>x.path==='/api/llm/test').body.context_window_k,258);
  if(process.env.FATE_SCREENSHOTS){mkdirSync(process.env.FATE_SCREENSHOTS,{recursive:true});await page.screenshot({path:`${process.env.FATE_SCREENSHOTS}/model-editor-${width}-${theme}.png`});}
  await dialog.getByRole('button',{name:'保存',exact:true}).click();
  const saved=writes.find(x=>x.path==='/api/llm/profiles');assert.equal(saved.body.reasoning_effort,'max');assert.deepEqual(Object.keys(saved.body.retry),['connect']);
  await page.getByRole('button',{name:'设为激活',exact:true}).click();await page.getByRole('button',{name:'删除配置',exact:true}).last().click();
  assert.ok(writes.some(x=>x.path==='/api/llm/profiles/active'&&x.body.id===2));assert.ok(writes.some(x=>x.path==='/api/llm/profiles/2'));
  await page.getByRole('tab',{name:'重试与退避'}).click();assert.equal(await page.getByText('空响应重试',{exact:true}).count(),0);
  await page.getByRole('button',{name:'全部恢复默认'}).click();await page.getByRole('button',{name:'保存',exact:true}).click();
  assert.deepEqual(Object.keys(writes.find(x=>x.path==='/api/llm/retry-policy').body).sort(),['breaker','connect']);
  await page.getByRole('button',{name:'候补配置',exact:true}).click();await page.getByRole('switch',{name:'LLM 候补开关'}).click();await page.getByRole('switch',{name:'绑定配置失败兜底开关'}).waitFor();assert.equal(await page.getByRole('switch',{name:'LLM 候补开关'}).getAttribute('aria-checked'),'true');
  assert.ok(writes.some(x=>x.path==='/api/settings'&&x.body.llm_pool_enabled===true));assert.deepEqual(errors,[]);
  if(process.env.FATE_SCREENSHOTS){mkdirSync(process.env.FATE_SCREENSHOTS,{recursive:true});await page.screenshot({path:`${process.env.FATE_SCREENSHOTS}/model-config-${width}-${theme}.png`});}
  console.log(JSON.stringify({width,theme,passed:true,writes:writes.map(x=>x.path)}));
 }catch(e){console.error(await page.locator('body').innerText());throw e;}finally{await context.close();}
}}finally{await browser.close();}
