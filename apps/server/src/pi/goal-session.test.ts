import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fauxAssistantMessage,fauxProvider,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import Fastify from 'fastify';
import {buildApp} from '../http/app.js';
import {registerTaskRoutes} from '../http/routes/tasks.js';
import {openDatabase} from '../db/index.js';
import {goalTools} from './goal-resources.js';
import {controlGoal,goalHistory,runGoalTurn,sendGoalMessage} from './goal-session.js';

test('目标任务使用 PI 恢复上下文，按需复核原文并按持久回复验收',{skip:!process.env.PI_GOAL_TEST_DSN},async()=>{
  const dsn=process.env.PI_GOAL_TEST_DSN!;
  assert.equal(new URL(dsn).pathname,'/pi_goal_fixture');
  process.env.SERIES_PG_DSN=dsn;
  const db=await openDatabase();
  const dir=await mkdtemp(path.join(tmpdir(),'pi-goal-test-'));
  const app=Fastify();
  app.decorate('db',db);
  app.decorate('dataDir',dir);
  try {
    const platform=buildApp({version:'fixture',startedAt:Date.now(),db,dataDir:dir,skillsRoot:dir,
      jwtKey:'local-fixture',engine:{conversations:{} as never,runtimeMetrics:()=>({})}});
    try {
      await platform.ready();
      assert.equal((await platform.inject({url:'/api/health'})).statusCode,200);
      assert.equal((await platform.inject({url:'/api/tasks'})).statusCode,401);
      for (const [method,url] of [['GET','/api/assets'],['GET','/api/exploration/graph'],['POST','/api/tasks/:id/intents/dispatch']] as const)
        assert.equal(platform.hasRoute({method,url}),false);
    } finally {await platform.close();}
    const graphs=async()=> (await db.query('SELECT count(*) FROM explorations')).rows[0]!.count;
    const before=await graphs();
    registerTaskRoutes(app,()=>model());
    const create=async(payload:Record<string,unknown>)=>app.inject({method:'POST',url:'/api/tasks',payload});
    assert.equal((await create({description:'缺少目标'})).statusCode,400);
    assert.equal((await create({goal:'示例',asset_ids:[1]})).statusCode,400);
    const created=await create({goal:'核对通知中的时间',description:'开会时间为九点。'});
    assert.equal(created.statusCode,201,created.body);
    const task={id:Number(created.json().id)};
    const url='/api/tasks/'+task.id;
    assert.equal(created.json().runtime,'pi');
    const detail=await app.inject({url});
    assert.deepEqual(detail.json().resources.map((r:{kind:string})=>r.kind),['mcp','skill','subagent','catalog']);
    assert.equal((await app.inject({url:url+'/messages'})).json().messages.length,0);
    assert.equal((await app.inject({method:'POST',url:url+'/chat',payload:{message:' ',request_id:randomUUID()}})).statusCode,400);
    assert.equal(await graphs(),before);
    assert.equal((await db.query('SELECT exploration_id FROM tasks WHERE id=$1',[task.id])).rows[0]!.exploration_id,null);
    const runtime=await ModelRuntime.create({authPath:path.join(dir,'auth.json'),modelsPath:path.join(dir,'models.json'),refreshOnCreate:false});
    const faux=fauxProvider({provider:'goal-local'});
    await runtime.registerNativeProvider(faux.provider);
    const model=async()=>({model:faux.getModel(),modelRuntime:runtime});
    faux.setResponses([context=>{
      assert.deepEqual(context.messages.flatMap(m=>m.role==='system' ? (m.toolsAdded??[]).map(t=>t.name) : []).sort(),['find_resource_bindings','mcp__materials__check_quote','read','review_material']);
      return fauxAssistantMessage([fauxToolCall('review_material',{})]);
    },context=>{
      assert.equal(context.messages.flatMap(m=>m.role==='system' ? m.toolsAdded??[] : []).length,0);
      assert.match(JSON.stringify(context.messages),/开会时间为九点/);
      return fauxAssistantMessage('原文为九点');
    },context=>{
      assert.match(JSON.stringify(context.messages),/原文为九点/);
      return fauxAssistantMessage('会议九点开始');
    }]);
    const send=(key:string,text:string)=>sendGoalMessage(db,dir,model,task.id,key,text);
    const key=randomUUID();
    const response=await app.inject({method:'POST',url:url+'/chat',payload:{request_id:key,message:'请复核'}});
    assert.equal(response.statusCode,200,response.body);
    const first=await send(key,'请复核');
    assert.equal(first.id,response.json().entry);
    assert.equal(first.text,'会议九点开始');
    assert.deepEqual(await send(key,'请复核'),first);
    await assert.rejects(send(key,'另一条消息'),/内容不同/);
    await controlGoal(db,task.id,'pause');
    await assert.rejects(send(randomUUID(),'还在吗'),/暂停/);
    await controlGoal(db,task.id,'resume');
    faux.setResponses([context=>{
      assert.match(JSON.stringify(context.messages),/会议九点开始/);
      return fauxAssistantMessage('已核对');
    }]);
    const second=await send(randomUUID(),'确认之前的结果');
    await assert.rejects(controlGoal(db,task.id,'finish','missing'),/验收/);
    await assert.rejects(db.query("UPDATE tasks SET status='done' WHERE id=$1",[task.id]),/验收/);
    const complete=await app.inject({method:'POST',url:url+'/control',payload:{action:'finish',entry:second.id}});
    assert.equal(complete.statusCode,200,complete.body);
    assert.equal(complete.json().status,'done');
    const list=await app.inject({url:'/api/tasks?page=1'});
    assert.equal(list.statusCode,200,list.body);
    assert.equal(list.json().tasks.find((t:{id:string})=>t.id===String(task.id)).goals_met,1);
    const catalogTask=await create({goal:'查询系统绑定'});
    const catalogURL='/api/tasks/'+catalogTask.json().id;
    const fixture='calendar-'+randomUUID();
    const agent=(await db.platform().getAgentByKey('mainagent'))!;
    const server=(await db.query("INSERT INTO mcp_servers(name,transport,command) VALUES($1,'stdio','fixture-must-never-run') RETURNING id",[fixture])).rows[0]!;
    await db.query("INSERT INTO agent_visibility(agent_id,resource_kind,resource_id) VALUES($1,'mcp',$2)",[agent.id,server.id]);
    await db.query('INSERT INTO agent_skill_visibility(agent_id,skill_name) VALUES($1,$2)',[agent.id,fixture]);
    const queryBindings=async(expected:{kind:string;name:string}[])=>{
      faux.setResponses([fauxAssistantMessage([fauxToolCall('find_resource_bindings',{query:fixture.toUpperCase()})]),context=>{
        const result=context.messages.filter(m=>m.role==='toolResult').at(-1);
        assert.equal(result?.isError,false);
        const content=result?.content[0];
        assert.deepEqual(JSON.parse(content?.type==='text'?content.text:''),{total:expected.length,bindings:expected});
        return fauxAssistantMessage('已查询绑定');
      }]);
      const response=await app.inject({method:'POST',url:catalogURL+'/chat',payload:{request_id:randomUUID(),message:'查询日程资源绑定'}});
      assert.equal(response.statusCode,200,response.body);
    };
    await queryBindings([{kind:'mcp',name:fixture},{kind:'skill',name:fixture}]);
    await db.query('UPDATE mcp_servers SET enabled=false WHERE id=$1',[server.id]);
    await db.query('DELETE FROM agent_skill_visibility WHERE agent_id=$1 AND skill_name=$2',[agent.id,fixture]);
    await queryBindings([]);
    const entries=(await app.inject({url:catalogURL+'/messages'})).json().messages;
    assert.equal(entries.filter((entry:{role:string;action:string})=>entry.role==='find_resource_bindings' && entry.action==='result').length,2);
    const bad=await create({goal:'验证模型失败原文'});
    const badURL='/api/tasks/'+bad.json().id;
    const badPayload={request_id:randomUUID(),message:'请求一次'};
    let failures=0;
    faux.setResponses([()=>{failures++;return fauxAssistantMessage('',{stopReason:'error',errorMessage:'fixture failure'});}]);
    const failure=await app.inject({method:'POST',url:badURL+'/chat',payload:badPayload});
    assert.match(failure.body,/fixture failure/);
    const receipt=await app.inject({url:badURL+'/requests/'+badPayload.request_id});
    assert.deepEqual(receipt.json(),{status:'failed',error:'fixture failure'});
    assert.equal((await app.inject({method:'POST',url:badURL+'/chat',payload:badPayload})).statusCode,409);
    assert.equal(failures,1);
    const legacy=(await db.query(`WITH e AS (INSERT INTO explorations(description,goal) VALUES('历史材料','旧目标') RETURNING id)
      INSERT INTO tasks(description,goal,exploration_id) SELECT '历史材料','旧目标',id FROM e RETURNING id`)).rows[0]!;
    const legacyURL='/api/tasks/'+legacy.id;
    assert.equal((await app.inject({url:legacyURL})).json().runtime,'legacy');
    const archived=await app.inject({url:legacyURL+'/messages'});
    assert.equal(archived.statusCode,200,archived.body);
    assert.equal((await app.inject({method:'POST',url:legacyURL+'/resume'})).statusCode,409);
    await assert.rejects(send(randomUUID(),'继续'),/只读/);
    assert.deepEqual(goalHistory(dir,task.id).filter(m=>m.role==='user').map(m=>m.text),['请复核','确认之前的结果']);
    assert.equal(Number(await graphs()),Number(before)+1);
  } finally {await app.close();await db.close();await rm(dir,{recursive:true,force:true});}
});

test('目标会话在首次请求声明资源，技能展开、MCP 和独立复核留下原生记录',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'pi-goal-resources-'));
  try {
    const task={id:1,goal:'确认时间',description:'日程\n会议九点开始'};
    const runtime=await ModelRuntime.create({authPath:path.join(dir,'auth.json'),modelsPath:path.join(dir,'models.json'),refreshOnCreate:false});
    const faux=fauxProvider({provider:'goal-resource-local'});
    await runtime.registerNativeProvider(faux.provider);
    const run=(message:string)=>runGoalTurn(dir,task,message,async()=>({modelRuntime:runtime,model:faux.getModel()}),new AbortController().signal,async()=>({total:0,bindings:[]}));
    faux.setResponses([context=>{
      const declarations=context.messages.flatMap(m=>m.role==='system'?m.toolsAdded??[]:[]);
      assert.deepEqual(declarations.map(t=>t.name).sort(),['find_resource_bindings','mcp__materials__check_quote','read','review_material']);
      const input=context.messages.filter(m=>m.role==='user').at(-1);
      assert.match(JSON.stringify(input),/<skill name=\\"material-review/);
      return fauxAssistantMessage([fauxToolCall('mcp__materials__check_quote',{text:task.description,quote:'九点'})]);
    },context=>{
      const result=context.messages.filter(m=>m.role==='toolResult').at(-1);
      assert.equal(result?.isError,false);
      assert.deepEqual(JSON.parse(result!.content[0].type==='text'?result!.content[0].text:''),{matched:true,line:2});
      return fauxAssistantMessage([fauxToolCall('review_material',{})]);
    },context=>{
      assert.equal(context.messages.flatMap(m=>m.role==='system'?m.toolsAdded??[]:[]).length,0);
      return fauxAssistantMessage('独立核对为九点');
    },context=>{
      assert.match(JSON.stringify(context.messages),/独立核对为九点/);
      return fauxAssistantMessage('已核对');
    }]);
    await run('/skill:material-review 核对日程');
    let history=goalHistory(dir,task.id);
    assert.equal(history.find(e=>e.role==='user')?.action,'skill:material-review');
    assert.deepEqual(history.filter(e=>e.action==='result').map(e=>[e.role,e.error]),[
      ['mcp__materials__check_quote',false],['review_material',false]]);
    for(const e of history.filter(e=>e.action==='call'))assert.ok(history.some(r=>r.action==='result'&&r.tool_call_id===e.tool_call_id));
    const skillPath=(goalTools.find(t=>t.name==='read')!.parameters.properties as {path:{enum:string[]}}).path.enum[0];
    faux.setResponses([fauxAssistantMessage([fauxToolCall('read',{path:skillPath})]),context=>{
      assert.match(JSON.stringify(context.messages.filter(m=>m.role==='toolResult').at(-1)?.content),/两段材料互相矛盾/);
      return fauxAssistantMessage([fauxToolCall('read',{path:path.join(dir,'auth.json')})]);
    },fauxAssistantMessage('资料核对完成')]);
    await run('读取核对指引');
    history=goalHistory(dir,task.id);
    assert.deepEqual(history.filter(e=>e.action==='result' && e.role==='read').map(e=>e.error),[false,true]);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('真实 PI 调用链复用同轮复核并向模型保留可定位的原文',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'goal-review-runtime-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const runtime=await ModelRuntime.create({authPath:path.join(dir,'auth.json'),modelsPath:path.join(dir,'models.json'),refreshOnCreate:false});
  const provider=fauxProvider({provider:'review-reuse-local'});
  await runtime.registerNativeProvider(provider.provider);
  const task={id:3,goal:'核对日程',description:'会议于周一举行。'};
  const run=()=>runGoalTurn(dir,task,'核对材料',async()=>({modelRuntime:runtime,model:provider.getModel()}),
    new AbortController().signal,async()=>({total:0,bindings:[]}));
  const original='材料注明会议在周一。'.repeat(128);
  const second='独立复核认为材料未说明会议地点。';
  let childCalls=0;
  provider.setResponses([
    fauxAssistantMessage([fauxToolCall('review_material',{}),fauxToolCall('review_material',{}),fauxToolCall('review_material',{fresh:true})]),
    ()=>{childCalls++;return fauxAssistantMessage(original);},
    ()=>{childCalls++;return fauxAssistantMessage(second);},
    context=>{
      const results=context.messages.filter(m=>m.role==='toolResult'&&m.toolName==='review_material');
      const texts=results.map(r=>r.content[0]?.type==='text'?r.content[0].text:null);
      assert.equal(results.length,3);
      assert.equal(texts[0],original);
      assert.deepEqual(JSON.parse(texts[1]!),{reused_review:results[0]!.toolCallId});
      assert.equal(texts[2],second);
      return fauxAssistantMessage('已记录两次独立复核。');
    },
  ]);
  await run();
  assert.equal(childCalls,2);
  assert.deepEqual(goalHistory(dir,task.id).filter(e=>e.action==='result').map(e=>e.text),[original,original,second]);
  provider.setResponses([fauxAssistantMessage([fauxToolCall('review_material',{})]),
    ()=>{childCalls++;return fauxAssistantMessage('本轮复核完毕');},fauxAssistantMessage('已完成')]);
  await run();assert.equal(childCalls,3);
});

test('压缩后保留首份可见原文，独立来源、错误和短结果按原样交付',async()=>{
  const {projectMaterialReviews}=await import('./goal-session.js');
  const text='独立材料结果'.repeat(50);
  const receipt=(call:string,content:string,parent?:string,isError=false)=>({
    role:'toolResult' as const,toolName:'review_material',toolCallId:call,isError,timestamp:1,
    details:parent?{reusedFrom:parent}:{},content:[{type:'text' as const,text:content}],
  });
  const input=[receipt('visible',text,'gone'),receipt('copy',text,'gone'),receipt('conflict','不同结论','gone'),
    receipt('error',text,'gone',true),receipt('independent',text),receipt('short','a'),receipt('short-copy','a','short')];
  const projected=projectMaterialReviews(input);
  assert.deepEqual(projected[1],{...input[1],content:[{type:'text',text:JSON.stringify({reused_review:'visible'})}]});
  for(const index of [0,2,3,4,5,6])assert.equal(projected[index],input[index]);
});
