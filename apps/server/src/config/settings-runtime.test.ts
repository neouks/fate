import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import http from 'node:http';
import net from 'node:net';
import Fastify from 'fastify';
import {openDatabase} from '../db/index.js';
import {registerConfigRoutes} from '../http/routes/config.js';
import {registerCustomToolRoutes} from '../http/routes/custom-tools.js';
import {pythonInterpreter,resolveShell} from './execution.js';
import {targetFetch} from '../evidence/target-transport.js';
import {evidenceRequest} from '../evidence/http.js';
import {startEgressGateway} from '../egress/index.js';
import {executionTools,configureAgentEnv} from '../agent/roles.js';
import {runContext} from '../tools/context.js';
import {createTrackedRunner} from '../engine/runtime-config.js';
import {ConstraintBoundary} from '../agent/constraint-boundary.js';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {reporterTrafficTools} from '../tools/reporter-traffic.js';
import {applyToolBindings} from '../agent/tool-bindings.js';
import {trafficSearchTool} from '../tools/traffic-search.js';
import {systemLogs,registerLogRoutes} from '../http/routes/logs.js';
import {roleContextPolicy} from '../agent/context-policy.js';
const dsn=process.env.TEST_SETTINGS_RUNTIME_DSN;
test('settings drive native PI execution, task egress and live revocation',{skip:!dsn&&'isolated PostgreSQL required',timeout:120000},async t=>{
 assert.match(new URL(dsn!).pathname,/^\/test_[a-z0-9_]+$/);process.env.SERIES_PG_DSN=dsn;
 const db=await openDatabase(),dir=await mkdtemp(path.join(tmpdir(),'settings-runtime-'));
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
 const app=Fastify();app.decorate('db',db);app.decorate('dataDir',dir);registerConfigRoutes(app);registerCustomToolRoutes(app);registerLogRoutes(app);t.after(()=>app.close());
 const save=async(body:object)=>{const r=await app.inject({method:'PUT',url:'/api/settings',payload:body});assert.equal(r.statusCode,200,r.body);return r.json();};
 const exp=await db.createExploration('local fixture','local fixture');
 const task=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,status,paused) VALUES('fixture','fixture',$1,'running',false) RETURNING id",[exp])).rows[0]!.id);
 let proxyCalls=0,targetCalls=0;
 const target=http.createServer((_q,r)=>{targetCalls++;r.end('local-target-ok');});
 await new Promise<void>(r=>target.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(target.address() as net.AddressInfo).port}/fixture`;
 const proxy=http.createServer();const sockets=new Set<net.Socket>();
 proxy.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 proxy.on('request',(q,r)=>{proxyCalls++;const upstream=http.request(q.url!,{method:q.method,headers:{host:new URL(q.url!).host}},res=>{r.writeHead(res.statusCode!,res.headers);res.pipe(r);});q.pipe(upstream);});
 proxy.on('connect',(q,s,head)=>{proxyCalls++;const u=new URL('http://'+q.url);const remote=net.connect(Number(u.port),u.hostname,()=>{s.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)remote.write(head);s.pipe(remote);remote.pipe(s);});remote.on('error',()=>s.destroy());s.on('close',()=>remote.destroy());});
 await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));const proxyURL=`http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
 t.after(()=>{for(const s of sockets)s.destroy();proxy.close();target.closeAllConnections();target.close();});
 await t.test('save returns complete configuration and rejects invalid or unknown fields before writes',async()=>{
  const settings=await save({traffic_capture:false,global_proxy:proxyURL,constraints_inject_worker:true,shell_mode:'bash'});
  assert.equal(settings.global_proxy,proxyURL);assert.equal(settings.traffic_capture,false);assert.equal(settings.shell_detected.ok,true);assert.equal(settings.constraints_inject_planner,true);
  for(const body of [{traffic_capture:'false'},{global_proxy:'garbage'},{workers:0,traffic_capture:true},{unimplemented:true},{shell_mode:'not-a-shell'}])assert.equal((await app.inject({method:'PUT',url:'/api/settings',payload:body})).statusCode,400);
  assert.equal(await db.platform().getBool('traffic_capture',false),false);
 });
 await t.test('explicit evidence HTTP uses current upstream and continues saving intentional evidence when capture is off',async()=>{
  const before=proxyCalls;const response=await evidenceRequest(runContext(db,task,exp,'worker'),{url});assert.equal(response.status,200);assert.ok(proxyCalls>before);assert.ok(response.traffic_id);
  await save({global_proxy:''});const count=proxyCalls;assert.equal((await evidenceRequest(runContext(db,task,exp,'mainagent'),{url})).status,200);assert.equal(proxyCalls,count);
  await save({global_proxy:proxyURL});
 });
 const gateway=await startEgressGateway(db,'127.0.0.1:0',dir);configureAgentEnv({caFile:gateway.caFile});t.after(()=>gateway.close());
 const runtime=await ModelRuntime.create({authPath:dir+'/auth.json',modelsPath:dir+'/models.json',refreshOnCreate:false});
 const faux=fauxProvider({provider:'settings-native'});await runtime.registerNativeProvider(faux.provider);
 const py=path.join(dir,'chosen python');await writeFile(py,`#!/bin/sh\nexport FATE_TEST_PYTHON=chosen\nexec '${pythonInterpreter().replaceAll("'","'\\''")}' "$@"\n`);await chmod(py,0o700);
 await save({python_interpreter:py});
 await db.query(`INSERT INTO tools(key,system,description,schema,agents,enabled,kind,exec) VALUES('local_python',false,'Local fixture','{"type":"object","properties":{}}','["worker","mainagent"]',true,'script',$1)`,[{code:'import os,json,sys; print(os.environ["FATE_TEST_PYTHON"]); print(json.load(sys.stdin))'}]);
 await t.test('script test actually executes configured Python and rejects unknown kinds',async()=>{
  const r=await app.inject({method:'POST',url:'/api/tools/custom/test',payload:{kind:'script',exec:{code:'import os; print(os.environ["FATE_TEST_PYTHON"])'}}});assert.equal(r.json().is_error,false,r.body);assert.match(r.json().output,/chosen/);
  const unknown=await app.inject({method:'POST',url:'/api/tools/custom/test',payload:{kind:'unknown'}});assert.equal(unknown.json().is_error,true);
  assert.ok((await app.inject({method:'POST',url:'/api/settings/python/detect'})).json().python_interpreter);
 });
 for(const role of ['worker','mainagent'] as const)await t.test(`${role}: PI invokes native Bash alongside configured Python and interactive terminal`,async()=>{
  const ctx=runContext(db,task,exp,role);await db.query('UPDATE agents SET interactive_shell=true WHERE key=$1',[role]);
  const execution=await executionTools(ctx,dir,{egressAddr:gateway.addr,egressScope:'fixture'});const events:any[]=[];
  const runner=await createTrackedRunner(db,task,role,{cwd:dir,agentDir:dir,inMemory:true,modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Only local synthetic fixtures.',customTools:execution.tools,toolAllowlist:['bash',...execution.tools.map(t=>t.name),...execution.names],extensionFactories:execution.extensions,onActivity:a=>{events.push(a);}});
  const count=async()=>Number((await db.query('SELECT count(*) n FROM traffic_exchanges WHERE task_id=$1',[task])).rows[0]!.n);
  try{
   await save({traffic_capture:false});const before=await count(),proxied=proxyCalls;
   faux.setResponses([fauxAssistantMessage([fauxToolCall('bash',{command:`curl --noproxy '*' -fsS '${url}'`})]),fauxAssistantMessage([fauxToolCall('local_python',{})]),fauxAssistantMessage([fauxToolCall('tool_search',{query:'shell_open'})]),fauxAssistantMessage([fauxToolCall('shell_open',{command:'printf terminal-ok',mode:'interactive',quiet_ms:100,timeout_ms:3000})]),fauxAssistantMessage('done')]);
   await runner.prompt('Run local fixtures');assert.equal(await count(),before);assert.equal(proxyCalls,proxied);assert.ok(events.some(a=>a.kind==='tool_end'&&a.text?.includes('chosen')));assert.ok(events.some(a=>a.kind==='tool_end'&&a.text?.includes('terminal-ok')),JSON.stringify(events.filter(a=>a.kind==='tool_end').map(a=>({name:a.toolName,error:a.isError,text:a.text}))));
   await save({traffic_capture:true});faux.setResponses([fauxAssistantMessage([fauxToolCall('bash',{command:`curl --noproxy '*' -fsS '${url}'`})]),fauxAssistantMessage('done')]);await runner.prompt('Run native Bash again');assert.equal(await count(),before);
  }finally{await runner.dispose();}
 });
 for(const role of ['planner','worker'] as const)await t.test(`${role}: injection changes actual PI request context and blocks stale tool batches`,async()=>{
  await db.query("INSERT INTO task_constraints(exploration_id,kind,text) VALUES($1,'deny','synthetic-constraint-marker')",[exp]);
  const boundary=new ConstraintBoundary(db,exp,()=>{},role);const seen:string[]=[];
  const runner=await createTrackedRunner(db,task,role,{cwd:dir,agentDir:dir,inMemory:true,modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Synthetic context fixture.',toolAllowlist:[],boundaryContext:()=>boundary.context()});
  try{for(const flag of [true,false,true]){await save({[`constraints_inject_${role}`]:flag});assert.ok(await boundary.guard('http_request'));faux.setResponses([context=>{seen.push(JSON.stringify(context));return fauxAssistantMessage('done');}]);await runner.prompt('check');assert.equal(seen.at(-1)!.includes('synthetic-constraint-marker'),flag);assert.equal(await boundary.guard('http_request'),undefined);}}
  finally{await runner.dispose();}
  const policy=roleContextPolicy(role,128000,'16000');assert.equal(policy.thresholdTokens,16000);assert.equal(roleContextPolicy(role,128000,'0').mode,'capacity');
 });
 await t.test('Reporter loads automatic binding tools only when enabled, uses same-task evidence, and revocation stops writes',async()=>{
  const finding=Number((await db.query("INSERT INTO findings(task_id,name,vulnclass,severity,status,evidence) VALUES($1,'fixture','fixture','low','confirmed','local') RETURNING id",[task])).rows[0]!.id);
  const traffic=String((await db.query('SELECT id FROM traffic_exchanges WHERE task_id=$1 LIMIT 1',[task])).rows[0]!.id);
  const ctx=runContext(db,task,exp,'reporter');await save({agent_traffic_binding:false});assert.equal((await applyToolBindings(db,'reporter',reporterTrafficTools(ctx))).length,0);
  await save({agent_traffic_binding:true});const tools=await applyToolBindings(db,'reporter',reporterTrafficTools(ctx));assert.equal(tools.length,2);
  const events:any[]=[];const runner=await createTrackedRunner(db,task,'reporter',{cwd:dir,agentDir:dir,inMemory:true,modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Use existing fixture evidence only.',toolAllowlist:tools.map(t=>t.name),customTools:tools,onActivity:a=>{events.push(a);}});
  try{
   const version=Number((await db.query('SELECT evidence_version FROM findings WHERE id=$1',[finding])).rows[0]!.evidence_version);
   faux.setResponses([fauxAssistantMessage([fauxToolCall('search_finding_traffic',{finding_id:finding,query:'fixture'})]),fauxAssistantMessage([fauxToolCall('bind_finding_traffic',{finding_id:finding,evidence_version:version,traffic_id:traffic})]),fauxAssistantMessage('done')]);await runner.prompt('bind fixture');
   assert.equal((await db.query('SELECT 1 FROM finding_traffic_bindings WHERE finding_id=$1',[finding])).rowCount,1);assert.ok(events.filter(a=>a.kind==='tool_end').every(a=>!a.isError));
   await save({agent_traffic_binding:false});faux.setResponses([fauxAssistantMessage([fauxToolCall('bind_finding_traffic',{finding_id:finding,evidence_version:version+1,traffic_id:traffic})]),fauxAssistantMessage('blocked')]);await runner.prompt('check revocation');assert.equal(events.filter(a=>a.kind==='tool_end').at(-1).isError,true);
  }finally{await runner.dispose();}
 });
 await t.test('Planner can discover and read captured traffic without target execution',async()=>{
  const ctx=runContext(db,task,exp,'planner'),tool=trafficSearchTool(ctx);const result=await tool.execute('fixture',{query:'fixture'},undefined,undefined,{} as never);assert.match(JSON.stringify(result),/traffic:.*:response/);
 });
 await t.test('system logs persist, paginate, replay and stream real events with credential redaction',async()=>{
  const logs=systemLogs(db);logs.write('warn','fixture','fixture Bearer secret-token https://user:password@example.com/?token=secret');await logs.flush();
  const history=await app.inject({url:'/api/logs/history?limit=1'});assert.equal(history.statusCode,200);assert.equal(history.json().items.length,1);assert.match(history.json().items[0].text,/redacted/);assert.doesNotMatch(history.json().items[0].text,/secret|password/);
  const address=await app.listen({host:'127.0.0.1',port:0}),abort=new AbortController();
  const response=await fetch(address+'/api/logs/stream?since=0',{signal:abort.signal});assert.equal(response.status,200);const reader=response.body!.getReader();let body='';
  try{logs.write('info','fixture','stream-live-marker');await logs.flush();while(!body.includes('stream-live-marker')){const next=await reader.read();if(next.done)break;body+=new TextDecoder().decode(next.value);}assert.match(body,/stream-live-marker/);assert.match(body,/id: /);}finally{abort.abort();await reader.cancel().catch(()=>{});}
 });
 assert.ok(targetCalls>0);assert.equal(resolveShell('bash').mode,'bash');
});
