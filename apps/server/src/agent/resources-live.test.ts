import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Fastify from 'fastify';
import {openDatabase} from '../db/index.js';
import {runWorkerIntent,runPlannerRound,runMainChat,configureAgentEnv} from './roles.js';
import {TodoStore} from '../tools/context.js';
import {buildModelSource} from '../pi/providerFromProfile.js';
import {roleResources} from './resources.js';
import {WORKER_COMPLETION_GUIDANCE} from './worker-fact-policy.js';
import {createTrackedRunner} from '../engine/runtime-config.js';
import {registerConfigRoutes} from '../http/routes/config.js';
import {registerSkillMgmtRoutes} from '../http/routes/skills-mgmt.js';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import type {RunnerActivity,AgentRunnerOptions} from '../pi/runner.js';
const dsn=process.env.TEST_RESOURCES_LIVE_DSN;
test('configured MCP and Skills are enforced inside live tracked PI role sessions',{skip:!dsn&&'isolated PostgreSQL required',timeout:180000},async t=>{
 assert.match(new URL(dsn!).pathname,/^\/test_/);process.env.SERIES_PG_DSN=dsn;
 const db=await openDatabase(),dir=await mkdtemp(path.join(tmpdir(),'fate-live-resources-')),skills=path.join(dir,'skills'),skill=path.join(skills,'fixture','SKILL.md');
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 await mkdir(path.dirname(skill),{recursive:true});await writeFile(skill,'---\nname: fixture\ndescription: resource-live-skill-description\n---\nresource-live-skill-body. Use tool_search to discover the fixture MCP echo tool, then call it with the requested text.');const alias=path.join(dir,'alias.md');await symlink(skill,alias);
 const app=Fastify();app.decorate('db',db);app.decorate('skillsRoot',skills);app.decorate('dataDir',dir);registerConfigRoutes(app);registerSkillMgmtRoutes(app);t.after(()=>app.close());
 const request=async(method:'POST'|'PUT',url:string,payload:object)=>{const r=await app.inject({method,url,payload});assert.ok(r.statusCode<300,r.body);return r.json();};
 const exp=await db.createExploration('resources fixture','resources fixture'),task=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,status,paused) VALUES('fixture','fixture',$1,'running',false) RETURNING id",[exp])).rows[0]!.id);
 const calls:string[]=[],streams=new Map<string,http.ServerResponse>();let sequence=0;
 const handle=(m:any)=>m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{},resources:{},prompts:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',description:'资源回显 resource echo local fixture',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}:m.method==='tools/call'?{content:[{type:'text',text:'rpc-result:'+m.params.arguments.text}]}:m.method==='resources/list'?{resources:[{uri:'fixture://local',name:'local'}]}:m.method==='resources/templates/list'?{resourceTemplates:[]}:m.method==='resources/read'?{contents:[{uri:'fixture://local',text:'resource-result'}]}:{prompts:[]};
 const server=http.createServer(async(req,res)=>{
  if(req.headers.authorization!=='Bearer fixture'){res.writeHead(401).end();return;}const url=new URL(req.url!,'http://local');
  if(req.method==='GET'&&url.pathname==='/sse'){const id=String(++sequence);streams.set(id,res);res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`event: endpoint\ndata: /messages?id=${id}\n\n`);req.on('close',()=>streams.delete(id));return;}
  if(req.method!=='POST'){res.writeHead(405).end();return;}let body='';for await(const c of req)body+=c;const m=JSON.parse(body);if(m.id===undefined){res.writeHead(202).end();return;}
  calls.push(m.method);const result=JSON.stringify({jsonrpc:'2.0',id:m.id,result:handle(m)});
  if(url.pathname==='/messages'){streams.get(url.searchParams.get('id')!)?.write(`event: message\ndata: ${result}\n\n`);res.writeHead(202).end();}else res.writeHead(200,{'Content-Type':'application/json'}).end(result);
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{for(const s of streams.values())s.end();server.closeAllConnections();server.close();});
 const endpoint=`http://127.0.0.1:${(server.address() as {port:number}).port}`,stdio=path.join(dir,'server.mjs'),counter=path.join(dir,'calls.jsonl');
 await writeFile(counter,'');await writeFile(stdio,`import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';const handle=${handle.toString()};for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;appendFileSync(${JSON.stringify(counter)},m.method+'\\n');process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:handle(m)})+'\\n');}`);
 const runtime=await ModelRuntime.create({authPath:dir+'/auth.json',modelsPath:dir+'/models.json',refreshOnCreate:false}),faux=fauxProvider({provider:'resources-live'});await runtime.registerNativeProvider(faux.provider);
 for(const role of ['worker','planner','mainagent'])for(const loading of ['deferred','direct'])for(const transport of ['http','sse','stdio'])await t.test(`${role}/${loading}/${transport}: discover, execute, disable, unbind, stale-session deny`,async()=>{
  await db.platform().setSetting('pi_mcp_loading',loading);
  const config={name:'fixture',transport,url:endpoint+(transport==='sse'?'/sse':'/mcp'),command:process.execPath,args:[stdio],env:transport==='stdio'?{}:{Authorization:'Bearer fixture'},enabled:true};
  const existing=(await db.query("SELECT id FROM mcp_servers WHERE name='fixture'")).rows[0];const saved=await request('POST','/api/mcp',{...config,id:existing?.id});const id=Number(saved.id??existing?.id);
  await db.query('DELETE FROM agent_visibility WHERE resource_id=$1',[id]);
  await request('PUT',`/api/agents/${role}/visibility`,{mcp:[id],skill:['fixture']});
  const agent=(await db.platform().getAgentByKey(role))!;const resources=await roleResources(db,role,skills);assert.equal(resources.mcpEntries?.length,1);assert.deepEqual(resources.allowedSkills,['fixture']);
  const events:RunnerActivity[]=[],file=path.join(dir,`${role}-${loading}-${transport}.jsonl`);
  const options:AgentRunnerOptions={cwd:dir,agentDir:dir,resumeSessionPath:file,modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Use local fixture resources only.',toolAllowlist:['read','mcp__*'],...resources,onActivity:a=>{events.push(a);}};
  let runner=await createTrackedRunner(db,task,role,options);
  const count=async()=>transport==='stdio'?(await readFile(counter,'utf8')).split('\n').filter(s=>s==='tools/call').length:calls.filter(s=>s==='tools/call').length;
  const step=async(tool:string,args:object)=>{faux.setResponses([fauxAssistantMessage([fauxToolCall(tool,args)]),fauxAssistantMessage('done')]);await runner.prompt('local fixture');return events.filter(a=>a.kind==='tool_end').at(-1)!;};
  try{
   if(loading==='deferred'){const r=await step('tool_search',{query:'资源回显'});assert.equal((r as any).isError,false,JSON.stringify(r));}
   const initial=await count();const result=await step('mcp__fixture__echo',{text:'enabled'});assert.equal((result as any).isError,false,JSON.stringify(result));assert.equal(await count(),initial+1);
   assert.equal((await step('read',{path:skill}) as any).isError,false);
   // Revoke between native model/tool turns, without rebuilding the runner.
   faux.setResponses([async()=>{await request('POST','/api/visibility/skill/toggle',{agent_id:role,skill_name:'fixture',visible:false});return fauxAssistantMessage([fauxToolCall('read',{path:'@'+skill})]);},ctx=>{const system=JSON.stringify(ctx.messages.filter(m=>m.role==='system'));assert.ok(!system.includes('resource-live-skill-description'),system);return fauxAssistantMessage('revoked');}]);
   await runner.prompt('revoke live Skill');assert.equal((events.filter(a=>a.kind==='tool_end').at(-1) as any).isError,true);
   assert.equal((await step('read',{path:alias}) as any).isError,true);
   for(const method of ['prompt','steer','followUp'] as const)await assert.rejects(()=>runner[method]('/skill:fixture hidden'),/Skill 已禁用/);
   await request('POST','/api/mcp',{...config,id,enabled:false});const before=await count();assert.equal((await step('mcp__fixture__echo',{text:'disabled'}) as any).isError,true);assert.equal(await count(),before);
   const discovery=await step('tool_search',{query:'资源回显'});assert.ok(!(discovery as any).text?.includes('mcp__fixture__echo'),JSON.stringify(discovery));
   const allBefore=transport==='stdio'?(await readFile(counter,'utf8')).length:calls.length;
   await step('list_mcp_resources',{server:'fixture'});assert.equal(transport==='stdio'?(await readFile(counter,'utf8')).length:calls.length,allBefore);
   await request('POST','/api/mcp',{...config,id});
   await db.query("INSERT INTO agent_visibility(agent_id,resource_kind,resource_id,mcp_tool_name,enabled) VALUES($1,'mcp',$2,'echo',true) ON CONFLICT(agent_id,resource_kind,resource_id,mcp_tool_name) DO UPDATE SET enabled=true",[agent.id,id]);
   await request('PUT',`/api/agents/${role}/visibility`,{mcp:[],skill:[]});
   assert.equal((await db.query('SELECT 1 FROM agent_visibility WHERE agent_id=$1 AND resource_id=$2 AND enabled',[agent.id,id])).rowCount,0);
   assert.equal((await roleResources(db,role,skills)).mcpEntries?.length,0);
   assert.equal((await step('mcp__fixture__echo',{text:'unbound'}) as any).isError,true);assert.equal(await count(),before);
   await runner.dispose();runner=await createTrackedRunner(db,task,role,{...options,...await roleResources(db,role,skills)});
   assert.equal((await step('mcp__fixture__echo',{text:'restored'}) as any).isError,true);assert.equal(await count(),before);
  }finally{await runner.dispose();}
 });

 await t.test('per-tool grants, whole-service toggle and stale registration enforce live authority',async()=>{
  const role='worker',id=Number((await db.query("SELECT id FROM mcp_servers WHERE name='fixture'")).rows[0]!.id),agent=(await db.platform().getAgentByKey(role))!;
  await request('POST','/api/mcp',{id,name:'fixture',transport:'http',url:endpoint+'/mcp',env:{Authorization:'Bearer fixture'},enabled:true});
  await db.query('DELETE FROM agent_visibility WHERE agent_id=$1 AND resource_id=$2',[agent.id,id]);
  await db.query("INSERT INTO agent_visibility(agent_id,resource_kind,resource_id,mcp_tool_name,enabled) VALUES($1,'mcp',$2,'echo',true)",[agent.id,id]);
  const resources=await roleResources(db,role,skills);assert.equal(resources.mcpEntries?.[0]?.config.exposure,'hidden');
  const events:RunnerActivity[]=[],options:AgentRunnerOptions={cwd:dir,agentDir:dir,inMemory:true,modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Local fixture.',toolAllowlist:['mcp__*'],...resources,onActivity:a=>{events.push(a);}};
  const runner=await createTrackedRunner(db,task,role,options);
  const step=async(tool:string,args:object)=>{faux.setResponses([fauxAssistantMessage([fauxToolCall(tool,args)]),fauxAssistantMessage('done')]);await runner.prompt('local fixture');};
  try{
   await step('tool_search',{query:'fixture echo'});const before=calls.filter(s=>s==='tools/call').length;await step('mcp__fixture__echo',{text:'tool-grant'});assert.equal(calls.filter(s=>s==='tools/call').length,before+1);
   const resourcesBefore=calls.filter(s=>s==='resources/list').length;await step('list_mcp_resources',{server:'fixture'});assert.equal(calls.filter(s=>s==='resources/list').length,resourcesBefore,'tool-only permission does not authorize reading server resources');
   await request('POST','/api/visibility/toggle',{agent_id:role,kind:'mcp',resource_id:id,visible:false});
   // Emulate historical residual granular permission; explicit service deny still wins.
   await db.query("UPDATE agent_visibility SET enabled=true WHERE agent_id=$1 AND resource_id=$2 AND mcp_tool_name='echo'",[agent.id,id]);
   assert.equal((await roleResources(db,role,skills)).mcpEntries?.length,0);await step('mcp__fixture__echo',{text:'revoked'});assert.equal(calls.filter(s=>s==='tools/call').length,before+1);
   const connects=calls.filter(s=>s==='initialize').length;const stale=await createTrackedRunner(db,task,role,options);try{faux.setResponses([fauxAssistantMessage([fauxToolCall('tool_search',{query:'fixture echo'})]),fauxAssistantMessage('done')]);await stale.prompt('stale registration');assert.equal(calls.filter(s=>s==='initialize').length,connects);}finally{await stale.dispose();}
  }finally{await runner.dispose();}
 });
 for(const role of ['worker','planner','mainagent'])await t.test(`${role}: complete task role entry loads Skill and invokes native MCP`,async()=>{
  configureAgentEnv({skillsDir:skills});await db.platform().setSetting('pi_mcp_loading','deferred');
  const id=Number((await db.query("SELECT id FROM mcp_servers WHERE name='fixture'")).rows[0]!.id);
  await request('POST','/api/mcp',{id,name:'fixture',transport:'http',url:endpoint+'/mcp',env:{Authorization:'Bearer fixture'},enabled:true});
  await request('PUT',`/api/agents/${role}/visibility`,{mcp:[id],skill:['fixture']});
  const prompt='本地功能验证：读取 fixture Skill，按其指引调用 fixture MCP echo，text 为 role-entry-'+role+'。必须实际使用工具；不操作其他目标、不创建意图或漏洞，完成后简短说明结果。';
  const expID=await db.createExploration(prompt,prompt),taskID=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,status,paused) VALUES($1,$1,$2,'running',false) RETURNING id",[prompt,expID])).rows[0]!.id);
  const events:RunnerActivity[]=[],before=calls.filter(s=>s==='tools/call').length;
  const source=process.env.FATE_RESOURCE_LIVE_PROFILE_FILE?await buildModelSource({...JSON.parse(await readFile(process.env.FATE_RESOURCE_LIVE_PROFILE_FILE,'utf8')),maxTokens:2048,thinkingType:'off',reasoningEffort:'off'}):{modelRuntime:runtime,model:faux.getModel()};
  if(!process.env.FATE_RESOURCE_LIVE_PROFILE_FILE)faux.setResponses([
   ctx=>{
    if(role==='worker'){
     const declared=ctx.messages.flatMap(m=>m.role==='system'?m.toolsAdded??[]:[]).map(t=>t.name);
     for(const name of ['insert_assets','report_finding'])assert.ok(!declared.includes(name));
     for(const name of ['context_get','record_fact'])assert.ok(declared.includes(name));
     assert.ok(JSON.stringify(ctx.messages.filter(m=>m.role==='system')).includes(WORKER_COMPLETION_GUIDANCE));
    }
    return fauxAssistantMessage([fauxToolCall('read',{path:skill})]);
   },
   fauxAssistantMessage([fauxToolCall('tool_search',{query:'资源回显',limit:1})]),
   fauxAssistantMessage([fauxToolCall('mcp__fixture__echo',{text:'role-entry-'+role})]),
   ...(role==='worker'?[
    fauxAssistantMessage([fauxToolCall('record_fact',{summary:'本地回显已完成',evidence:'rpc-result:role-entry-worker',observation_type:'observed',confidence:'high'})]),
   ]:[]),fauxAssistantMessage('done'),
  ]);
  const common={db,taskID,expID,goal:prompt,model:source,dataDir:dir,hooks:{},maxTurns:12,onActivity:(a:RunnerActivity)=>{events.push(a);}};
  if(role==='worker'){
   const intentID=await db.exploration(expID).addNode('intent',{summary:prompt,contract:{allowed_tools:['mcp__fixture__echo']}},0,'running','fixture',[]);
   await db.query("UPDATE exploration_nodes SET owner='work#fixture' WHERE id=$1",[intentID]);
   const completed=await runWorkerIntent({...common,intent:(await db.exploration(expID).getNode(intentID))!,workerName:'work#fixture',maxDurationMs:90000});
   assert.equal(completed.stopReason,'completed');
   if(!process.env.FATE_RESOURCE_LIVE_PROFILE_FILE){
    assert.equal(events.filter(e=>e.kind==='usage').length,5,'resident writeback needs no search or extra verification round');
    assert.ok(events.some(e=>e.kind==='tool_end'&&e.toolName==='record_fact'&&!e.isError));
   }
  }else if(role==='planner')await runPlannerRound({...common,todos:new TodoStore(db),triggersText:prompt});
  else await runMainChat({...common,message:prompt});
  const ends=events.filter(a=>a.kind==='tool_end');
  assert.ok(ends.some(a=>a.toolName==='read'&&!a.isError&&a.text?.includes('resource-live-skill-body')),JSON.stringify(ends));
  assert.ok(ends.some(a=>a.toolName==='mcp__fixture__echo'&&!a.isError&&a.text?.includes('role-entry-'+role)),JSON.stringify(ends));
  assert.equal(calls.filter(s=>s==='tools/call').length,before+1);
 });

});
