// Built UI only. Every API request is intercepted; no task, model or live backend runs.
// FATE_TEST_STATIC_DIR=/path/to/out PLAYWRIGHT_MODULE=/path/to/playwright node web/tests/human-input.mjs
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,existsSync,statSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(process.env.FATE_TEST_STATIC_DIR||'web/out');
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://local');let file=path.resolve(root,'.'+decodeURIComponent(u.pathname));
 if(!file.startsWith(root+'/')||!['GET','HEAD'].includes(req.method)){res.writeHead(403).end();return;}
 if(existsSync(file)&&statSync(file).isDirectory())file=path.join(file,'index.html');
 if(!existsSync(file)&&existsSync(file+'.html'))file+='.html';
 if(!existsSync(file)){res.writeHead(404).end();return;}
 const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2','.txt':'text/plain'};
 res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream'}).end(readFileSync(file));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 for(const [width,theme] of [[1440,'light'],[1440,'dark'],[390,'light'],[390,'dark']]){
  const ts=new Date().toISOString(),writes=[],errors=[];
  const task={id:'501',description:'人工协助合成任务',goal:'核对本地样本',status:'running',paused:false,exploration_id:301,created_at:ts,updated_at:ts};
  const node={id:'201',type:'intent',state:'running',payload:JSON.stringify({summary:'本地样本'}),origin:'planner',ts};
  const requests=[['mainagent','input','请输入手机号',true],['planner','confirm','是否继续当前计划？',false],['worker','select','选择当前方向的方法',false]].map(([role,kind,question,sensitive],i)=>({
   id:`00000000-0000-4000-8000-00000000000${i}`,task_id:'501',role,kind,question,sensitive,options:kind==='select'?['A','B']:undefined,
   turn_id:`fixture-${role}`,intent_id:role==='worker'?'201':undefined,main_seg:0,status:'pending',created_at:ts,updated_at:ts,activity_id:i+10,
  }));
  const activity=r=>({seq:r.activity_id,kind:'status',worker:r.role,main_seg:r.main_seg,intent_id:r.intent_id,summary:r.question,detail:'',ts:r.created_at,turn_id:r.turn_id,metadata:{turn_id:r.turn_id,event_type:'human_input',human_input_id:r.id}});
  const session=r=>r.role==='worker'?'intent:201':r.role==='planner'?'plan':'main:0';
  const safe=r=>({...r,answer:r.sensitive?undefined:r.answer});
  const snapshot=()=>requests.filter((r,i)=>r.status==='pending'||i>=requests.length-100).map(safe);
  const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme});
  await context.addCookies([{name:'series_token',value:'fixture',url:origin},{name:'theme_mode',value:theme,url:origin}]);
  await context.addInitScript(()=>{localStorage.setItem('series_token','fixture');window.fixtureStreams=[];
   window.EventSource=class extends EventTarget{static CLOSED=2;readyState=1;onmessage=null;
    constructor(url){super();this.url=url;window.fixtureStreams.push(this);setTimeout(()=>this.dispatchEvent(new Event('open')),0);}
    close(){this.readyState=2;}emit(type,data){const event=new MessageEvent(type,{data:JSON.stringify(data)});this.dispatchEvent(event);if(type==='message')this.onmessage?.(event);}
   };
  });
  await context.route('**/*',route=>{
   const req=route.request(),u=new URL(req.url()),p=u.pathname,ok=json=>route.fulfill({status:200,json});
   if(u.origin!==origin)return route.abort();if(!p.startsWith('/api/'))return route.continue();
   if(p.endsWith('/respond')){const r=requests.find(r=>p.includes(r.id));assert.ok(r);const body=req.postDataJSON();writes.push(body);assert.equal(r.status,'pending');
    r.status=body.action==='answer'?'answered':'cancelled';r.answer=body.answer;r.updated_at=new Date().toISOString();return ok(safe(r));}
   if(req.method()!=='GET'){errors.push(`Unexpected mutation: ${p}`);return route.abort();}
   if(p==='/api/tasks/501')return ok(task);
   if(p==='/api/tasks/501/input-requests')return ok({items:u.searchParams.has('request_id')?requests.filter(r=>r.id===u.searchParams.get('request_id')).map(safe):snapshot()});
   if(p==='/api/exploration/main-sessions')return ok({sessions:[{seq:0,created_at:ts}],current:0});
   if(p.includes('/intents'))return ok({items:[node],completed_count:0});
   if(p==='/api/exploration/nodes/201')return ok(node);
   if(p==='/api/exploration/activity/history'){
    const records=requests.filter(r=>session(r)===(u.searchParams.get('session')||'main:0')).map(activity);
    return ok({items:records,snapshot_cursor:100,earliest_cursor:records[0]?.seq||0,latest_cursor:records.at(-1)?.seq||0,has_more:false,has_newer:false});
   }
   if(p.endsWith('/turns'))return ok({items:[]});
   if(p.includes('/tokens'))return ok({models:[],workers:[],sessions:[],total:{input:0,output:0,total:0}});
   if(p.includes('/findings'))return ok([]);
   if(p.endsWith('/agents'))return ok({agents:[]});
   if(p.includes('/llm')||p.includes('/profiles'))return ok([]);
   if(p.endsWith('/status'))return ok({running:true,initialized:true});
   return ok({items:[],total:0,goals:[],constraints:[],conversations:[],sources:[],assets:[],rows:[],scope:[],servers:[],skills:[],tools:[],counts:{}});
  });
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  const emit=async()=>page.evaluate(items=>window.fixtureStreams.filter(s=>s.readyState!==2).forEach(s=>s.emit('human_inputs',{items})),snapshot());
  await page.goto(origin+'/function/tasks/detail/?id=501&tab=sessions&section=chat');
  await page.getByText('Need input · 3',{exact:true}).waitFor();
  // Native text answer, masked input, explicit submission and collapsed receipt.
  await page.getByRole('button',{name:'主 Agent · 会话 1',exact:true}).click();
  await page.getByRole('button',{name:'返回最新',exact:true}).filter({visible:true}).first().waitFor();
  let card=page.locator(`[data-human-input-id="${requests[0].id}"]`).filter({visible:true}).first();
  await page.locator('[data-run-status="等待人工输入"]').filter({visible:true}).first().waitFor();
  await card.getByLabel('请输入手机号').fill('13800001234');assert.equal(await card.locator('input').getAttribute('type'),'password');
  await page.waitForFunction(id=>Array.from(document.querySelectorAll(`[data-human-input-id="${id}"] button`)).some(b=>b.textContent.includes('回答并继续')&&!b.disabled),requests[0].id);
  assert.equal(await card.getByRole('button',{name:'回答并继续'}).isEnabled(),true);
  if(process.env.FATE_SCREENSHOTS){mkdirSync(process.env.FATE_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.FATE_SCREENSHOTS,`human-input-${width}-${theme}.png`)});}
  await card.getByRole('button',{name:'回答并继续'}).focus();await page.keyboard.press('Enter');
  await card.getByText('已回答',{exact:true}).waitFor();await card.getByRole('button',{name:'查看问题与回答'}).click();
  await card.getByText('敏感回答已隐藏',{exact:true}).waitFor();assert.ok(!(await card.innerText()).includes('13800001234'));assert.equal(writes.length,1);
  // The inbox opens the exact Planner question and keeps false distinct from cancel.
  await page.getByRole('button',{name:'Planner',exact:true}).click();
  card=page.locator(`[data-human-input-id="${requests[1].id}"]`).filter({visible:true}).first();
  await card.getByRole('radio',{name:'否',exact:true}).click();await card.getByRole('button',{name:'回答并继续'}).click();
  await card.getByText('已回答',{exact:true}).waitFor();assert.equal(writes[1].answer,false);
  // On mobile the detail sheet must be closed before navigating the main inbox.
  if(width===390)await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Worker #201',exact:true}).click();
  card=page.locator(`[data-human-input-id="${requests[2].id}"]`).filter({visible:true}).first();
  await card.getByRole('radio',{name:'B',exact:true}).click();await card.getByRole('button',{name:'回答并继续'}).click();
  await card.getByText('已回答',{exact:true}).waitFor();assert.equal(writes[2].answer,'B');
  // An expired owner's outstanding card disables immediately on SSE replacement.
  requests.push({...requests[2],id:'00000000-0000-4000-8000-000000000003',activity_id:20,question:'等待协助后再继续',kind:'input',status:'pending',answer:undefined,turn_id:'new-worker',updated_at:new Date().toISOString()});
  await emit();if(width===390)await page.keyboard.press('Escape');await page.getByRole('button',{name:'Worker #201',exact:true}).click();
  await page.reload();await page.getByText('Need input · 1',{exact:true}).waitFor();
  card=page.locator(`[data-human-input-id="${requests[3].id}"]`).filter({visible:true}).first();await card.getByLabel('等待协助后再继续').fill('尚未提交');
  requests[3].status='interrupted';requests[3].updated_at=new Date().toISOString();await emit();await card.getByText('已中断',{exact:true}).waitFor();
  assert.equal(await card.getByRole('button',{name:'回答并继续'}).count(),0);assert.equal(writes.length,3);
  await page.reload();await page.getByText('已中断',{exact:true}).first().waitFor();assert.equal(writes.length,3);assert.deepEqual(errors,[]);
  requests.push({...requests[3],id:'00000000-0000-4000-8000-000000000004',activity_id:21,question:'可以取消的问题',status:'pending',updated_at:new Date().toISOString()});
  await emit();if(width===390)await page.keyboard.press('Escape');await page.getByRole('button',{name:'Worker #201',exact:true}).click();
  card=page.locator(`[data-human-input-id="${requests[4].id}"]`).filter({visible:true}).first();await card.getByRole('button',{name:'取消回答'}).click();
  await card.getByText('已取消',{exact:true}).waitFor();assert.deepEqual(writes[3],{action:'cancel'});assert.deepEqual(errors,[]);
  const prefill='第一行\n  原第二行';
  const editor={...requests[0],id:'00000000-0000-4000-8000-000000000005',activity_id:22,
   question:'核对正文',sensitive:false,kind:'editor',prefill,status:'pending',answer:undefined,turn_id:'edit-text'};
  requests.push(editor);
  await emit();
  if(width===390)await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'主 Agent · 会话 1',exact:true}).click();
  card=page.locator(`[data-human-input-id="${editor.id}"]`).filter({visible:true}).first();
  const textarea=card.getByRole('textbox',{name:editor.question});
  assert.equal(await textarea.inputValue(),prefill);
  let expected=prefill;
  if(theme==='dark'){
   expected=width===390?'':'第一行\n  已修改第二行';
   await textarea.fill(expected);
   await emit();
   assert.equal(await textarea.inputValue(),expected);
  }
  const cancel=width===390&&theme==='light';
  await card.getByRole('button',{name:cancel?'取消回答':'回答并继续'}).click();
  await card.getByText(cancel?'已取消':'已回答',{exact:true}).waitFor();
  assert.deepEqual(writes[4],cancel?{action:'cancel'}:{action:'answer',answer:expected});
  if(width===1440&&theme==='light'){
   const old={...editor,id:'old-worker',role:'worker',intent_id:'201',turn_id:'offline-worker',activity_id:23,status:'pending'};
   const other={...editor,id:'old-main',turn_id:'offline-main',activity_id:24,status:'pending'};
   const fresh={...requests[1],id:'new-plan',turn_id:'offline-plan',activity_id:25,status:'pending'};
   requests.push(old,other);
   await emit();
   await page.getByText('Need input · 2',{exact:true}).waitFor();
   await page.getByRole('button',{name:'Worker #201',exact:true}).click();
   const oldCard=page.locator('[data-human-input-id="old-worker"]').filter({visible:true}).first();
   await oldCard.getByRole('textbox').fill('待提交');

   const reconnect=()=>page.evaluate(()=>{
    const stream=window.fixtureStreams.findLast(s=>s.readyState!==2);
    stream.readyState=0;stream.dispatchEvent(new Event('error'));
    stream.readyState=1;stream.dispatchEvent(new Event('open'));
   });
   const fullUrl=origin+'/api/tasks/501/input-requests';
   const stale=snapshot();
   const gate=Promise.withResolvers();
   await page.route(fullUrl,async route=>{
    await gate.promise;
    await route.fulfill({json:{items:stale}});
   },{times:1});
   try{
    await Promise.all([page.waitForRequest(fullUrl),reconnect()]);
    old.status='expired';
    requests.push(fresh);
    for(let i=0;i<100;i++)requests.push({...requests[1],id:`recent-${i}`,activity_id:100+i,status:'answered'});
    await emit();
    await page.getByRole('button',{name:'Planner',exact:true}).waitFor();
    // Details recover the actual terminal status outside the history window.
    await oldCard.getByText('已过期',{exact:true}).waitFor();
   }finally{
    const staleResponse=page.waitForResponse(fullUrl);
    gate.resolve();
    await (await staleResponse).finished();
   }
   // A stale REST list must not restore an old pending row over a newer SSE list.
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.equal(await page.getByText('Need input · 2',{exact:true}).count(),1);
   assert.equal(await page.getByRole('button',{name:'Planner',exact:true}).count(),1);
   // REST alone also removes an omitted request on a subsequent reconnect.
   other.status='cancelled';
   fresh.status='answered';
   await reconnect();
   await page.getByText(/^Need input · \d+$/).waitFor({state:'hidden'});
   assert.equal(writes.length,5);
  }
  assert.deepEqual(errors,[]);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await context.close();console.log(`PASS human input ${width} ${theme}: source routing, text/select/confirm/cancel, sensitive masking, keyboard, interruption, pending reload, editor prefill`);
 }
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
