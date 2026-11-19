// Local fixtures only: every API call is intercepted; no production writes or models.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.FATE_TEST_ORIGIN;assert.ok(origin);assert.notEqual(new URL(origin).port,'8787');
const browser=await chromium.launch({channel:'chrome',headless:true});
try{for(const [width,theme] of [[1440,'light'],[390,'dark']]){
 let failUsage=false,failTools=false,emptyTools=false;
 const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme});const writes=[],errors=[];
 await context.addCookies([{name:'series_token',value:'fixture',url:origin},{name:'theme_mode',value:theme,url:origin}]);await context.addInitScript(()=>localStorage.setItem('series_token','fixture'));
 // The development toolbar is not part of the application and can cover
 // mobile footer buttons. Runtime errors still fail via pageerror below.
 await context.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{
  const style=document.createElement('style');style.textContent='nextjs-portal { pointer-events: none !important; }';document.head.append(style);
 }));
 const counts={calls:9,tasks:1,conversations:3,succeeded:6,failed:1,pending:1,unknown:1,usage_agents:['worker','reporter']};
 const recent=[{call_id:'fixture:one',ts:'2026-11-12T01:00:00Z',tool_name:'echo',agent_key:'reporter',task_id:42,conversation_id:8,intent_id:3,outcome:'unknown',source:'native-v1'}];
 const server={id:1,name:'local-fixture',transport:'stdio',command:'node',args:['/tmp/path with spaces/server.mjs','x y'],env:{},enabled:true};
 await context.route('**/*',route=>{
  const r=route.request(),u=new URL(r.url()),p=u.pathname,ok=json=>route.fulfill({json});
  if(u.origin!==origin)return route.abort();if(!p.startsWith('/api/'))return route.continue();
  if(p.endsWith('/usage')&&failUsage)return route.fulfill({status:503,json:{error:'synthetic usage unavailable'}});
  if(r.method()!=='GET')writes.push({path:p,body:r.postDataJSON()});
  if(p==='/api/agents')return ok({agents:[{id:'77',key:'worker',name:'Worker 合成角色',enabled:true,mcp_supported:true},{id:'78',key:'reporter',name:'Reporter 合成角色',enabled:true,mcp_supported:false}]});
  if(p==='/api/skills'&&r.method()!=='GET')return ok({name:r.postDataJSON().name});
  if(p==='/api/skills/fixture/usage')return ok({calls:recent});
  if(p==='/api/mcp/1/tools')return failTools?route.fulfill({status:503,json:{error:'synthetic tools unavailable'}}):ok({tools:emptyTools?[]:[{name:'echo',description:'',calls:9,cached:false,discovered_at:null}]});
  if(p==='/api/mcp/1/usage')return ok({stats:[{...counts,tool_name:'echo',agents:['worker','reporter']}],calls:recent});
  if(p==='/api/skills')return ok({skills:[{...counts,name:'fixture',description:'Local: metadata # text',files:['SKILL.md'],loadable:false,diagnostics:['缺少有效 description']} ]});
  if(p==='/api/mcp')return ok(r.method()==='GET'?{servers:[server]}:{id:1});
  if(p.endsWith('/refresh'))return ok({tools:[],error:'fixture discovery failed'});
  if(p==='/api/mcp/test')return ok({ok:true,tools:[],tool_count:0,latency_ms:1});
  if(p.startsWith('/api/visibility'))return ok({agents:['worker'],ok:true});
  if(p.includes('status'))return ok({initialized:true,running:false});
  return ok({items:[],tasks:[],categories:[],agents:[],conversations:[],missing:[],tools:[],calls:[],stats:[]});
 });
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(origin+'/system/skills');await page.getByText('fixture',{exact:true}).first().click();
  await page.getByText('缺少有效 description',{exact:true}).waitFor();assert.ok(!(await page.locator('body').innerText()).includes('NaN'));
  await page.getByText('结果未知',{exact:true}).waitFor();
  assert.match(await page.locator('body').innerText(),/独立会话 3 · 成功 6 · 失败 1 · 进行中 1 · 未知 1/);
  const skillRole=page.getByRole('checkbox',{name:'Worker 合成角色'});assert.equal(await skillRole.getAttribute('aria-checked'),'true');await skillRole.click();
  await page.waitForTimeout(100);assert.equal(writes.find(w=>w.path==='/api/visibility/skill/toggle').body.agent_id,'worker');
  if(process.env.FATE_SCREENSHOTS){mkdirSync(process.env.FATE_SCREENSHOTS,{recursive:true});await page.screenshot({path:`${process.env.FATE_SCREENSHOTS}/skills-${width}-${theme}.png`});}
  if(width<768)await page.getByRole('button',{name:'返回 Skill 列表'}).click();
  await page.getByRole('button',{name:'新建 Skill',exact:true}).click();const create=page.getByRole('dialog').last();
  await create.locator('#sk-name').fill('created-fixture');await create.locator('#sk-desc').fill('Synthetic: description # only');
  await create.getByRole('tab',{name:'可见性',exact:true}).click();await create.getByRole('checkbox',{name:'Worker 合成角色'}).click();
  await create.getByRole('button',{name:'创建',exact:true}).click();await page.waitForTimeout(150);
  assert.equal(writes.find(w=>w.path==='/api/visibility/skill/toggle'&&w.body.skill_name==='created-fixture').body.agent_id,'worker');
  await page.goto(origin+'/system/mcp');await page.getByRole('button',{name:/local-fixture/}).click();
  const editor=page.getByRole('dialog').last();assert.deepEqual(JSON.parse(await editor.locator('#m-args').inputValue()),server.args);
  assert.equal(await editor.getByRole('checkbox',{name:'Reporter 合成角色（不支持 MCP）'}).isDisabled(),true);
  await editor.getByText(/新增授权和服务配置在新会话生效/).waitFor();
  const mcpRole=editor.getByRole('checkbox',{name:'Worker 合成角色'});assert.equal(await mcpRole.getAttribute('aria-checked'),'true');await mcpRole.click();await page.waitForTimeout(100);
  assert.equal(writes.find(w=>w.path==='/api/visibility/toggle').body.agent_id,'worker');
  await editor.getByRole('button',{name:/测试可用性/}).click();await page.waitForTimeout(100);
  assert.deepEqual(writes.find(w=>w.path==='/api/mcp/test').body.args,server.args);
  await editor.getByRole('button',{name:'保存',exact:true}).click();await page.waitForTimeout(100);assert.deepEqual(writes.find(w=>w.path==='/api/mcp').body.args,server.args);
  await editor.getByRole('tab',{name:/工具/}).click();await editor.getByText('echo',{exact:true}).first().waitFor();await editor.getByText('仅有历史调用记录，当前发现缓存未包含此工具').waitFor();await editor.getByText('缓存 0 个 · 另有历史记录 1 个').waitFor();await editor.getByRole('button',{name:/发现|刷新/}).first().click();await page.getByText(/fixture discovery failed/).first().waitFor();
  await editor.getByText('结果未知',{exact:true}).waitFor();assert.match(await editor.innerText(),/9 次 · 1 个任务 · 3 个独立会话/);
  if(process.env.FATE_SCREENSHOTS)await page.screenshot({path:`${process.env.FATE_SCREENSHOTS}/mcp-${width}-${theme}.png`});
  failUsage=true;failTools=true;
  await page.goto(origin+'/system/skills');await page.getByText('fixture',{exact:true}).first().click();
  await page.getByRole('alert').filter({hasText:'调用明细读取失败'}).waitFor();
  await page.goto(origin+'/system/mcp');await page.getByRole('button',{name:/local-fixture/}).click();
  const retryEditor=page.getByRole('dialog').last();await retryEditor.getByRole('tab',{name:/工具/}).click();
  await retryEditor.getByRole('alert').filter({hasText:'调用统计读取失败'}).waitFor();
  await retryEditor.getByRole('alert').filter({hasText:'工具列表读取失败'}).waitFor();assert.equal(await retryEditor.getByText(/暂无缓存或调用记录/).count(),0);
  failUsage=false;await retryEditor.getByRole('button',{name:'重试',exact:true}).click();await retryEditor.getByText('结果未知',{exact:true}).waitFor();
  failTools=false;emptyTools=true;
  await page.goto(origin+'/system/mcp');await page.getByRole('button',{name:/local-fixture/}).click();
  const emptyEditor=page.getByRole('dialog').last();await emptyEditor.getByRole('tab',{name:/工具/}).click();await emptyEditor.getByText(/暂无缓存或调用记录；不代表运行时没有工具/).waitFor();
  assert.deepEqual(errors,[]);console.log(JSON.stringify({width,theme,passed:true,writes:writes.map(w=>w.path)}));
 }catch(error){console.error(await page.locator('body').innerText());throw error;}finally{await context.close();}
}}finally{await browser.close();}
