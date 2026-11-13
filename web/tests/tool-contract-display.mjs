// All API calls use synthetic data. No backend, model or business tool executes.
// FATE_TEST_ORIGIN=http://127.0.0.1:15197 PLAYWRIGHT_MODULE=/path/to/playwright node web/tests/tool-contract-display.mjs
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.FATE_TEST_ORIGIN;
assert.ok(origin,'FATE_TEST_ORIGIN is required');
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 for(const [width,theme] of [[1440,'light'],[390,'dark']]){
  const tool={key:'context_get',system:true,kind:'builtin',source:'platform',implementation_status:'active',description:'默认说明',description_source:'builtin',schema:{},schema_source:'role_specific',schema_read_only:true,agents:['reader','reviewer'],enabled:true};
  const schema=limit=>({type:'object',properties:{items:{type:'array',items:{type:'object',properties:{options:{type:'object',properties:{limit:{type:'integer',maximum:limit},mode:{enum:['summary','detail']}},required:['mode']}},required:['options']}}},required:['items']});
  const roles=['reader','reviewer'].map((role,i)=>({role,scope:'task_bound',policy_version:'fixture',resident:[tool.key],deferred:[],compatibility:[],schema_bytes:{before:100,resident:100,registered:100},schemas:{[tool.key]:schema(i?12:24)},descriptions:{[tool.key]:role+' 实际说明'}}));
  const writes=[],errors=[];
  const context=await browser.newContext({viewport:{width,height:950},colorScheme:theme});
  await context.addCookies([{name:'series_token',value:'fixture',url:origin},{name:'theme_mode',value:theme,url:origin}]);
  await context.addInitScript(()=>{localStorage.setItem('series_token','fixture');window.EventSource=class extends EventTarget{readyState=1;close(){this.readyState=2;}};});
  await context.route('**/*',route=>{
   const req=route.request(),url=new URL(req.url()),p=url.pathname,ok=json=>route.fulfill({status:200,json});
   if(url.origin!==origin)return route.abort();
   if(!p.startsWith('/api/'))return route.continue();
   if(p==='/api/tools'&&req.method()==='GET')return ok({tools:[tool],roles});
   if(p==='/api/tools/context_get'&&req.method()==='PUT'){
    const body=req.postDataJSON();writes.push({method:'PUT',body});Object.assign(tool,body);
    if('description' in body)tool.description_source=body.description?'custom':'builtin';
    return ok({ok:true});
   }
   if(p==='/api/tools/context_get/reset'&&req.method()==='POST'){
    writes.push({method:'POST'});tool.description='默认说明';tool.description_source='builtin';return ok({ok:true});
   }
   if(req.method()!=='GET')return route.abort();
   if(p==='/api/agents')return ok({agents:roles.map((r,i)=>({id:i+1,key:r.role,name:r.role,enabled:true}))});
   if(p==='/api/settings')return ok({traffic_capture:false});
   if(p==='/api/tasks')return ok({tasks:[],total:0});
   if(p.endsWith('/status'))return ok({running:false,initialized:true});
   return ok({items:[],tasks:[],total:0,agents:[],profiles:[],models:[],conversations:[],rows:[]});
  });
  const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/function/tasks?settings=true&settingsTab=tools');
  // Development-only badge can overlap the mobile drawer footer.
  await page.addStyleTag({content:'nextjs-portal { display: none !important; }'});
  const open=()=>page.getByRole('button',{name:/^context_get 平台/}).click();
  await open();
  const params=page.getByLabel('参数 Schema',{exact:true});
  assert.equal(JSON.parse(await params.innerText()).properties.items.items.properties.options.properties.limit.maximum,24);
  await page.getByLabel('查看角色契约').click();await page.getByRole('option',{name:'reviewer',exact:true}).click();
  const shown=JSON.parse(await params.innerText());
  assert.equal(shown.properties.items.items.properties.options.properties.limit.maximum,12);
  assert.deepEqual(shown.properties.items.items.properties.options.required,['mode']);
  assert.deepEqual(shown.properties.items.items.properties.options.properties.mode.enum,['summary','detail']);
  await page.getByText('reviewer 实际说明',{exact:true}).waitFor();
  await page.screenshot({path:`/tmp/fate-tool-contract-${width}.png`});
  assert.equal(await page.getByLabel('自定义说明（留空使用默认）').inputValue(),'');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  assert.deepEqual(writes[0],{method:'PUT',body:{agents:['reader','reviewer'],enabled:true}});
  await open();await page.getByLabel('自定义说明（留空使用默认）').fill('合成自定义说明');
  await page.getByRole('button',{name:'保存',exact:true}).click();assert.equal(writes[1].body.description,'合成自定义说明');
  await open();await page.getByRole('button',{name:'恢复默认说明',exact:true}).click();
  await open();assert.equal(await page.getByLabel('自定义说明（留空使用默认）').inputValue(),'');
  assert.equal(writes[2].method,'POST');assert.equal(tool.enabled,true);assert.deepEqual(tool.agents,['reader','reviewer']);
  assert.deepEqual(errors,[]);
  console.log(`PASS ${width}px ${theme}: role schemas, constraints, description save/reset`);
  await context.close();
 }
}finally{await browser.close();}
