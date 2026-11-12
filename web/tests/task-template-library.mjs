// Isolated UI contract: all API traffic is mocked; no tasks or real templates are created.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.FATE_TEST_ORIGIN;assert.ok(origin);
const browser=await chromium.launch({channel:'chrome',headless:true});
try{for(const [width,theme] of [[1440,'light'],[390,'light'],[1440,'dark'],[390,'dark']]){
 const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme});
 await context.addCookies([{name:'series_token',value:'fixture',url:origin},{name:'theme_mode',value:theme,url:origin}]);
 await context.addInitScript(()=>localStorage.setItem('series_token','fixture'));
 const sample=(id,name,description,goal)=>({id,name,description,goal,created_at:'2026-01-01',updated_at:'2026-01-01'});
 let rows=[sample(1,'文档整理','核对本地示例文档的章节。','列出缺失章节。'),sample(2,'数据核对','对照两份合成记录。','列出不同条目。')];let seq=2;const writes=[],errors=[];
 await context.route('**/*',route=>{
  const request=route.request(),u=new URL(request.url()),p=u.pathname,method=request.method(),ok=json=>route.fulfill({json});
  if(u.origin!==origin)return route.abort();if(!p.startsWith('/api/'))return route.continue();
  if(method!=='GET')writes.push({path:p,method});
  if(p==='/api/task-templates'&&method==='GET')return ok({templates:rows});
  if(p.startsWith('/api/task-templates')&&method!=='GET'){
   const id=Number(p.split('/').at(-1));
   if(method==='DELETE'){rows=rows.filter(r=>r.id!==id);return ok({deleted:1});}
   const body=request.postDataJSON();
   if(body.name==='重名')return route.fulfill({status:409,json:{error:'模板名称已存在'}});
   const row=sample(method==='POST'?++seq:id,body.name,body.description,body.goal);rows=[row,...rows.filter(r=>r.id!==row.id)];return ok(row);
  }
  if(p==='/api/task-categories')return ok({categories:[]});
  if(p.includes('status'))return ok({initialized:true,running:false});
  return ok({items:[],tasks:[],profiles:[],categories:[],companies:[],conversations:[]});
 });
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(origin+'/function/tasks/new');
  await page.locator('#description').fill('原草稿');await page.locator('#goal').fill('原目标');await page.locator('#name').fill('保留任务名');
  const list=page.getByRole('list',{name:'任务模板列表',exact:true});await list.getByRole('button',{name:'使用模板：文档整理',exact:true}).click();
  assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.locator('#description').inputValue(),'核对本地示例文档的章节。');assert.equal(await page.locator('#goal').inputValue(),'列出缺失章节。');assert.equal(await page.locator('#name').inputValue(),'保留任务名');assert.equal(writes.length,0);
  await page.locator('#description').fill('独立编辑的草稿');assert.equal(rows[0].description,'核对本地示例文档的章节。');
  await list.getByRole('button',{name:'使用模板：数据核对',exact:true}).focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#goal').inputValue(),'列出不同条目。');
  if(process.env.FATE_SCREENSHOTS){mkdirSync(process.env.FATE_SCREENSHOTS,{recursive:true});await list.scrollIntoViewIfNeeded();await page.screenshot({path:`${process.env.FATE_SCREENSHOTS}/template-list-${width}-${theme}.png`});}
  await page.getByRole('button',{name:'另存为模板',exact:true}).click();let dialog=page.getByRole('dialog');
  assert.equal(await dialog.getByLabel('任务说明',{exact:true}).inputValue(),'对照两份合成记录。');assert.equal(await dialog.getByLabel('验收目标',{exact:true}).inputValue(),'列出不同条目。');
  await dialog.getByLabel('模板名称',{exact:true}).fill('重名');await dialog.getByRole('button',{name:'保存模板',exact:true}).click();await dialog.getByText('模板名称已存在',{exact:true}).waitFor();assert.equal(await dialog.getByLabel('模板名称',{exact:true}).inputValue(),'重名');
  await dialog.getByLabel('模板名称',{exact:true}).fill('草稿副本');await dialog.getByRole('button',{name:'保存模板',exact:true}).click();await dialog.getByRole('button',{name:'保存修改',exact:true}).waitFor();
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();assert.equal(await page.locator('#description').inputValue(),'对照两份合成记录。');
  await page.getByRole('button',{name:'管理模板',exact:true}).click();dialog=page.getByRole('dialog');
  await dialog.getByRole('searchbox',{name:'搜索模板名称'}).fill('文档');await dialog.getByRole('list',{name:'模板列表',exact:true}).getByRole('button',{name:'文档整理',exact:true}).click();
  await dialog.getByLabel('任务说明',{exact:true}).fill('修改后的模板内容');await dialog.getByRole('button',{name:'保存修改',exact:true}).click();await page.getByText('模板已保存',{exact:true}).first().waitFor();
  if(process.env.FATE_SCREENSHOTS)await page.screenshot({path:`${process.env.FATE_SCREENSHOTS}/template-manager-${width}-${theme}.png`});
  await dialog.getByRole('button',{name:'删除模板',exact:true}).click();await page.getByRole('alertdialog').getByRole('button',{name:'取消',exact:true}).click();assert.equal(rows.length,3);
  await dialog.getByRole('button',{name:'删除模板',exact:true}).click();await page.getByRole('alertdialog').getByRole('button',{name:'确认删除',exact:true}).click();await page.getByRole('alertdialog').waitFor({state:'hidden'});assert.equal(rows.length,2);
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();assert.equal(await page.locator('#description').inputValue(),'对照两份合成记录。');
  assert.ok(writes.every(r=>r.path.startsWith('/api/task-templates')));assert.deepEqual(errors,[]);
  rows=[];await page.reload();await page.getByText('暂无任务模板',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:/使用模板/}).count(),0);
  console.log(JSON.stringify({width,theme,passed:true,templateRequests:writes.length}));
 }finally{await context.close();}
}}finally{await browser.close();}
