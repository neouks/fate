import {makeModelResolver,resolveModelProfiles} from "./src/pi/modelResolver.js";
import {AgentRunner} from "./src/pi/runner.js";
import { describe,it,expect,beforeAll,afterAll,vi } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { fauxProvider,fauxAssistantMessage,fauxToolCall } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { openDatabase,type Database } from './src/db/index.js';
import { Engine,defaultEngineConfig } from './src/engine/engine.js';
import { RetestService } from './src/engine/retests.js';
import { buildApp } from './src/http/app.js';
import { signJWT } from './src/http/auth.js';
import { interceptGate } from './src/intercept/gate.js';
import { buildGraphOverview } from './src/tools/overview.js';
import { runContext } from './src/tools/context.js';
import { compactColdGraph } from './src/agent/coldgraph.js';
import { runMainChat,runGoalsDecompose } from './src/agent/roles.js';
import { insertAssetsTool } from './src/tools/assets.js';
import { proveGoalTool, reportFindingTool } from './src/tools/findings.js';
import { addIntentTool } from './src/tools/intents.js';
import { listFindingsTool } from './src/tools/findings.js';
import { listAssetsTool } from './src/tools/assets.js';
import { customWorkerTools } from './src/tools/custom.js';
let db:Database;
const dbName='series_review_'+process.pid;
const dir=mkdtempSync(path.join(tmpdir(),'fate-review-'));
const engines:Engine[]=[];
const apps:ReturnType<typeof buildApp>[]=[];
const key='review-only-signing-key';
beforeAll(async()=>{
 process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${dbName}?sslmode=disable`;
 process.env.SERIES_LOG_LEVEL='silent';
 db=await openDatabase();
});
afterAll(async()=>{
 for(const engine of engines)await engine.shutdown();
 for(const app of apps)await app.close();
 await db.close();
 const client=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres?sslmode=disable'});
 await client.connect();await client.query(`DROP DATABASE ${dbName}`);await client.end();
 rmSync(dir,{recursive:true,force:true});
});
async function fixture(){
 const t=await db.tasks().createTaskWithOptions('review fixture','',{});
 const faux=fauxProvider({provider:'review'+t.id});
 const modelRuntime=await ModelRuntime.create({refreshOnCreate:false});await modelRuntime.registerNativeProvider(faux.provider);
 faux.setResponses(Array.from({length:20},()=>fauxAssistantMessage('fixture complete')));
 const source={modelRuntime,model:faux.getModel() as never};
 const e=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:2},async()=>source,dir);engines.push(e);
 const app=buildApp({db,engine:e,version:'review',startedAt:Date.now(),jwtKey:key,skillsRoot:dir,dataDir:dir});apps.push(app);
 const post=(url:string,payload:unknown)=>app.inject({method:'POST',url,payload,headers:{'X-Series-Token':signJWT(key)}});
 return {t,s:db.exploration(t.exploration_id),faux,source,e,app,post};
}
async function until(fn:()=>Promise<boolean>){for(let i=0;i<150;i++){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw new Error('condition timeout');}
describe('migration invariants',()=>{
 it('enforces trigger role concurrency across two conversation executors at the next claim',async()=>{
  const {e,faux,source}=await fixture();const remote=new Engine(db,{...defaultEngineConfig(),workers:1},async()=>source,dir);engines.push(remote);
  const saved=(await db.query("SELECT trigger_run_mode,trigger_max_parallel FROM agents WHERE key='auto'")).rows[0]!;
  await db.query("UPDATE agents SET trigger_run_mode='serial',trigger_max_parallel=2 WHERE key='auto'");
  const trigger=Number((await db.query("INSERT INTO agent_triggers(agent_key,enabled) VALUES('auto',true) RETURNING id")).rows[0]!.id);
  const conversations:number[]=[],signals:AbortSignal[]=[];
  faux.setResponses(Array.from({length:3},()=>async(_context,options)=>{signals.push(options.signal!);await new Promise<void>(resolve=>options.signal?.addEventListener('abort',()=>resolve(),{once:true}));return fauxAssistantMessage('',{stopReason:'aborted'});}));
  try{
   for(let i=0;i<3;i++){const c=await e.conversations.create('auto','LOCAL trigger concurrency');conversations.push(Number(c.id));await db.query('INSERT INTO conversation_runs(conversation_id,message,trigger_id) VALUES($1,$2,$3)',[c.id,'wait until cancelled',trigger]);}
   await until(async()=>{await Promise.all([e.conversations.pump(),remote.conversations.pump()]);return signals.length===1;});
   const running=async()=>Number((await db.query("SELECT count(*) n FROM conversation_runs WHERE trigger_id=$1 AND status='running'",[trigger])).rows[0]!.n);
   expect(await running()).toBe(1);
   await db.query("UPDATE agents SET trigger_run_mode='parallel',trigger_max_parallel=2 WHERE key='auto'");
   await until(async()=>{await Promise.all([e.conversations.pump(),remote.conversations.pump()]);return signals.length===2;});
   expect(await running()).toBe(2);
   expect(Number((await db.query("SELECT count(*) n FROM conversation_runs WHERE trigger_id=$1 AND status='queued'",[trigger])).rows[0]!.n)).toBe(1);
  }finally{
   await Promise.all(conversations.flatMap(id=>[e.conversations.stop(id),remote.conversations.stop(id)]));
   await db.query('UPDATE agents SET trigger_run_mode=$1,trigger_max_parallel=$2 WHERE key=\'auto\'',[saved.trigger_run_mode,saved.trigger_max_parallel]);
  }
 });
 it('projects acknowledged pause and disabled coverage consistently in task list and detail',async()=>{
  const {t,app}=await fixture();await db.query('UPDATE tasks SET status=\'running\',coverage_enabled=false WHERE id=$1',[t.id]);
  const pause=await db.tasks().applyTaskPause(t.id);
  const get=(url:string)=>app.inject({method:'GET',url,headers:{'X-Series-Token':signJWT(key)}});
  const pending=(await get(`/api/tasks/${t.id}`)).json();expect(pending).toMatchObject({status:'running',pause_pending:true,execution_status:'waiting_for_executor',coverage:{enabled:false}});
  await db.query("UPDATE runtime_task_commands SET status='acknowledged',acknowledged_at=now() WHERE id=$1",[pause.commandID]);
  expect((await get(`/api/tasks/${t.id}`)).json()).toMatchObject({status:'paused',pause_pending:false,coverage:{enabled:false}});
  expect((await get('/api/tasks')).json().tasks.find((row:{id:string})=>row.id===String(t.id))).toMatchObject({status:'paused'});
 });
 it('R1 UI dispatch must reactivate a paused task',async()=>{
  const {t,s,post}=await fixture();const id=await s.addIntent({summary:'dispatch fixture'},5,[],'user');
  await db.query("UPDATE tasks SET paused=true,status='paused' WHERE id=$1",[t.id]);
  const response=await post(`/api/tasks/${t.id}/intents/dispatch`,{intent_ids:[id]});
  expect(response.statusCode).toBe(200);
  expect((await db.tasks().getTask(t.id))?.paused).toBe(false);
 });
 it('R2 Worker resume cannot implicitly start its inactive task',async()=>{
  const {t,s,post}=await fixture();const id=await s.addIntent({summary:'paused fixture'},5,[],'user');await s.setIntentState(id,'paused');
  const response=await post(`/api/tasks/${t.id}/intents/${id}/control`,{action:'resume'});
  expect(response.statusCode).toBe(409);expect((await s.getNode(id))?.state).toBe('paused');
 });
 it('pauses Goals during bootstrap and resumes with a new fenced decomposition and scheduler',async()=>{
  const {t,e,faux,s}=await fixture();await db.tasks().setExecutionMode(t.exploration_id,'manual');let entered=false;
  faux.setResponses([async(_context,options)=>{entered=true;await new Promise<void>(resolve=>options.signal?.addEventListener('abort',()=>resolve(),{once:true}));return fauxAssistantMessage('',{stopReason:'aborted'});}]);
  const starting=e.run(t.id,{decompose:{description:'LOCAL bootstrap fixture'}});await until(async()=>entered);
  await db.tasks().applyTaskPause(t.id);expect((await e.pause(t.id)).status).toBe('paused');await starting;
  expect((await s.listByKind('goal',20))).toHaveLength(0);
  faux.setResponses([fauxAssistantMessage([fauxToolCall('set_goals',{goals:[{text:'resumed bootstrap marker'}]})]),fauxAssistantMessage('goals saved')]);
  await e.admitTask(t.id);
  expect((await s.listByKind('goal',20)).map(n=>n.payload.text)).toContain('resumed bootstrap marker');
  const status=await db.tasks().getTask(t.id);expect(status).toMatchObject({paused:false,queued:false,queue_mode:''});
  expect((await db.query("SELECT id FROM activity WHERE exploration_id=$1 AND worker='goals' AND kind='tool_result'",[t.exploration_id])).rowCount).toBeGreaterThan(0);
  await e.stop(t.id);
 });
 it('R3 selecting a task after restart must not execute a paused task',async()=>{
  const {t,s,post,e,faux}=await fixture();await s.addIntent({summary:'must remain paused'},5,[],'user');
  await db.query("UPDATE tasks SET paused=true,status='paused' WHERE id=$1",[t.id]);
  await post('/api/active',{id:t.id});
  for(let i=0;i<25&&faux.state.callCount===0;i++)await new Promise(r=>setTimeout(r,20));await e.stop(t.id);
  expect(faux.state.callCount).toBe(0);
 });
 it('R4 manual mode must not call the planner',async()=>{
  const {t,s,e,faux}=await fixture();await s.addGoal({text:'manual goal'},'user');await s.addIntent({summary:'waiting manual dispatch'},5,[],'user');
  await db.tasks().setExecutionMode(t.exploration_id,'manual');
  await e.run(t.id);for(let i=0;i<25&&faux.state.callCount===0;i++)await new Promise(r=>setTimeout(r,20));await e.stop(t.id);
  expect(faux.state.callCount).toBe(0);
 });
 it('R5 HTTP custom tools must not bypass a blocked host by passing a URL',async()=>{
  const {t}=await fixture();
  await db.query("INSERT INTO task_asset_blocks(task_id,asset_key,asset_type,host_key) VALUES($1,'review:blocked','subdomain','blocked.review.test')",[t.id]);
  await expect(db.taskScope().validateWorkerHosts(t.id,['blocked.review.test'])).rejects.toThrow();
  const fetch=vi.fn().mockResolvedValue(new Response('fixture',{status:200}));vi.stubGlobal('fetch',fetch);
  try{
   const proxy={platform:()=>({listTools:async()=>[{key:'review_http',kind:'http',exec:{url:'https://blocked.review.test/'},schema:{type:'object',properties:{}},description:'fixture',agents:['worker'],enabled:true,system:false}]}),taskScope:()=>db.taskScope()} as unknown as Database;
   const tool=(await customWorkerTools(runContext(proxy,t.id,t.exploration_id,'worker'),dir))[0]!;
   await expect(tool.execute('fixture',{},undefined,undefined,{} as never)).rejects.toThrow();
   expect(fetch).not.toHaveBeenCalled();
  }finally{vi.unstubAllGlobals();}
 });
 it('R5 an explicitly linked service asset limits egress to its approved port',async()=>{
  const {t}=await fixture();
  await db.assets().upsertHTTPService({url:'http://port.review.test:9080/',taskID:t.id});
  await db.taskScope().addAgentScope(t.id,'subdomain','port.review.test','single-port acceptance fixture','manual');
  await expect(db.taskScope().validateWorkerHostPort(t.id,'port.review.test',9080)).resolves.toBeUndefined();
  await expect(db.taskScope().validateWorkerHostPort(t.id,'port.review.test',9081)).rejects.toThrow('port is not approved');
 });
 it('R6 newly saved deny rules must apply to the worker gate',async()=>{
  const {t,post,app}=await fixture();await db.query('DELETE FROM intercept_rules');await app.interceptor.setEnabledTools(['bash']);
  const gate=interceptGate(db,{taskID:t.id,agentName:'worker'});
  const input={toolName:'bash',toolCallId:'fixture',args:{command:'echo review_cache_marker'}};
  expect(await gate(input)).toBeUndefined();
  const res=await post('/api/intercept/rules',{name:'review deny',enabled:true,priority:999999,match_target:'tool_input',match_type:'string',pattern:'review_cache_marker',action:'deny',message:'fixture'});
  expect(res.statusCode).toBe(201);expect((await gate(input))?.block).toBe(true);
 });
 it('R7 cancellation must not mutate an intent in a different task',async()=>{
  const a=await fixture(),b=await fixture();const id=await b.s.addIntent({summary:'other task'},5,[],'user');
  await a.post(`/api/tasks/${a.t.id}/intents/${id}/control`,{action:'cancel'});
  expect((await b.s.getNode(id))?.payload.cancelled_by_user).not.toBe(true);
 });
 it('R8 graph overview must expose every hidden block or an expansion index',async()=>{
  const {t,s}=await fixture();
  for(let i=0;i<16;i++){
   const intent=await s.addNode('intent',{summary:'block '+i},1,'done','worker',[]);
   const fact=await s.addNode('fact',{summary:'fact '+i},1,'confirmed','worker',[]);await s.link(intent,'yields',fact);
  }
  for(let i=0;i<7;i++)await compactColdGraph(db,t.exploration_id);
  const overview=await buildGraphOverview(runContext(db,t.id,t.exploration_id,'planner'));
  expect((overview.recent_facts as unknown[]).length).toBe(0);
  expect((overview.cold_digests as unknown[]).length).toBe(16);
 });
 it('R9 inherited source blackboard must be present in planner context',async()=>{
  const source=await fixture();await source.s.addNode('fact',{summary:'inherited-evidence-marker'},1,'confirmed','worker',[]);
  const t=await db.tasks().createTaskWithOptions('dependent task','',{sourceTaskIDs:[source.t.id]});
  const overview=await buildGraphOverview(runContext(db,t.id,t.exploration_id,'planner'));
  expect(JSON.stringify(overview)).toContain('inherited-evidence-marker');
 });
 it('R9 node_detail pages inherited graph edges with a persistent cursor',async()=>{
  const {nodeDetailTool}=await import('./src/tools/graph.js');const source=await fixture();
  const root=await source.s.addNode('intent',{summary:'source edge cursor'},1,'done','worker',[]);
  for(let i=0;i<13;i++){const fact=await source.s.addNode('fact',{summary:`source fact ${i}`},1,'confirmed','worker',[]);await source.s.link(root,'yields',fact);}
  const t=await db.tasks().createTaskWithOptions('readonly linked graph','',{sourceTaskIDs:[source.t.id]});
  const tool=nodeDetailTool(runContext(db,t.id,t.exploration_id,'mainagent'));
  const first=await tool.execute('edges-1',{node_id:root});expect(first.isError).not.toBe(true);
  const a=JSON.parse((first.content[0] as {text:string}).text);expect(a).toMatchObject({inherited:true,source_task_id:source.t.id});expect(a.edges).toHaveLength(10);
  const second=await tool.execute('edges-2',{node_id:root,after_edge:a.next_edge});expect(second.isError).not.toBe(true);
  const b=JSON.parse((second.content[0] as {text:string}).text);expect(b.edges).toHaveLength(3);expect(b.next_edge).toBeNull();
  expect(new Set([...a.edges,...b.edges].map(e=>e.id)).size).toBe(13);
 });
 it('R9 HTTP graph and node pages expose only direct authorized sources as read-only',async()=>{
  const parent=await fixture(),source=await fixture(),{app}=source;
  const hiddenAncestor=await parent.s.addNode('fact',{summary:'grandparent must not leak'},1,'confirmed','worker',[]);
  await db.query('INSERT INTO task_relations(task_id,source_task_id) VALUES($1,$2)',[source.t.id,parent.t.id]);
  const asset=await db.assets().upsertRootDomain({domain:'source-projection.review.test',taskID:source.t.id});
  const intent=await source.s.addIntent({summary:'source readonly'},1,[asset],'user');await source.s.setIntentState(intent,'done');
  const fact=await source.s.addNode('fact',{summary:'source visible'},1,'confirmed','worker',[asset]);await source.s.link(intent,'yields',fact);
  const child=await db.tasks().createTaskWithOptions('child projection','',{sourceTaskIDs:[source.t.id]});
  const get=(url:string)=>app.inject({url,headers:{'X-Series-Token':signJWT(key)}});
  const graph=(await get(`/api/exploration/graph?task=${child.id}`)).json();
  expect(graph.nodes.find((n:{id:string})=>n.id===String(fact))).toMatchObject({inherited:true,source_task_id:String(source.t.id)});
  expect(graph.nodes.some((n:{id:string})=>n.id===String(hiddenAncestor))).toBe(false);
  expect(graph.edges).toContainEqual({src:String(intent),dst:String(fact),rel:'yields'});
  const page=(await get(`/api/exploration/nodes?task=${child.id}&kind=fact&size=1`)).json();expect(page.items).toHaveLength(1);expect(page.total).toBeGreaterThan(1);
  expect((await get(`/api/exploration/intents?task=${child.id}`)).json().items).toHaveLength(0);
  const cancel=await app.inject({method:'POST',url:`/api/tasks/${child.id}/intents/${intent}/cancel`,payload:{},headers:{'X-Series-Token':signJWT(key)}});expect(cancel.statusCode).not.toBe(200);expect((await source.s.getNode(intent))?.state).toBe('done');
  await db.query("INSERT INTO task_asset_blocks(task_id,asset_key,asset_type,host_key) VALUES($1,'source:block','root_domain','source-projection.review.test')",[source.t.id]);
  const revoked=(await get(`/api/exploration/graph?task=${child.id}`)).json();expect(revoked.nodes.some((n:{id:string})=>n.id===String(fact))).toBe(false);
  expect((await get(`/api/exploration/nodes/${fact}?task=${child.id}`)).statusCode).toBe(404);
 });
 it('R10 UI feedback is retained without forwarding Worker prose to Main',async()=>{
  const {t,s,source,faux}=await fixture();const id=await s.addIntent({summary:'feedback task'},1,[],'user');
  await s.appendActivity({node_id:id,kind:'result',worker:'work#1',summary:'worker-feedback-marker'});
  let system='';faux.setResponses([(context)=>{system=JSON.stringify(context);return fauxAssistantMessage('done');}]);
  await runMainChat({db,taskID:t.id,expID:t.exploration_id,goal:'',model:source,dataDir:dir,hooks:{},message:'progress?',segment:0,maxTurns:5,onActivity:()=>{}});
  expect(system).not.toContain('worker-feedback-marker');
 });
 it('R11 compaction must not deadlock worker state writes',async()=>{
  const {t,s}=await fixture();const id=await s.addIntent({summary:'lock fixture'},1,[],'user');
  const writer=await db.pool.connect();await writer.query('BEGIN');
  await writer.query('SELECT pg_advisory_xact_lock($1)',[-t.exploration_id]);
  await writer.query('SELECT id FROM exploration_nodes WHERE id=$1 FOR UPDATE',[id]);
  const compress=compactColdGraph(db,t.exploration_id).then(()=>null,e=>e.code);
  await new Promise(r=>setTimeout(r,100));
  let writerCode=null;
  try{await writer.query("UPDATE exploration_nodes SET state='running' WHERE id=$1",[id]);await writer.query('COMMIT');}
  catch(e){writerCode=(e as any).code;await writer.query('ROLLBACK');}finally{writer.release();}
  expect([await compress,writerCode]).toEqual([null,null]);
 });
 it('R12 direct intent pause must abort its active pi session',async()=>{
  const {t,s,e,faux,post}=await fixture();const id=await s.addIntent({summary:'inflight fixture',dispatch_requested:true},1,[],'user');
  let signal:AbortSignal|undefined;
  faux.setResponses([async(_context,options)=>{signal=options?.signal;await new Promise<void>(resolve=>signal?.addEventListener('abort',()=>resolve(),{once:true}));return fauxAssistantMessage('',{stopReason:'aborted'});}]);
  try{
   await db.query("UPDATE tasks SET execution_mode='manual' WHERE id=$1",[t.id]);await e.run(t.id);await until(async()=>!!signal);
   const r=await post(`/api/tasks/${t.id}/intents/${id}/pause`,{});expect(r.statusCode).toBe(200);
   expect(signal?.aborted).toBe(true);
  }finally{await e.stop(t.id);}
 });
 it('R21 cross-instance task pause waits for the task-lease owner to stop pi and acknowledge',async()=>{
  const {t,s,e,faux,source}=await fixture();const id=await s.addIntent({summary:'remote pause fixture'},1,[],'user');
  await db.tasks().setExecutionMode(t.exploration_id,'manual');
  let signal:AbortSignal|undefined;
  faux.setResponses([async(_context,options)=>{signal=options?.signal;await new Promise<void>(resolve=>signal?.addEventListener('abort',()=>resolve(),{once:true}));return fauxAssistantMessage('',{stopReason:'aborted'});}]);
  const remote=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:2},async()=>source,dir);engines.push(remote);
  try{
   await e.run(t.id);await e.dispatchIntent(t.id,id);await until(async()=>!!signal);
   await db.tasks().applyTaskPause(t.id);
   const result=await remote.pause(t.id);
   expect(result.status).toBe('paused');expect(signal?.aborted).toBe(true);
   const row=await db.query('SELECT status,executor_owner FROM runtime_task_commands WHERE id=$1',[result.command_id]);
   expect(row.rows[0]?.status).toBe('acknowledged');expect(row.rows[0]?.executor_owner).toBeTruthy();
  }finally{await e.stop(t.id);}
 });
 it('R22 explicit resume supersedes a pending cross-instance pause command',async()=>{
  const {t,e}=await fixture();
  await db.tasks().setExecutionMode(t.exploration_id,'manual');
  const paused=await db.tasks().applyTaskPause(t.id);
  try{
   await e.admitTask(t.id);
   const row=await db.query('SELECT status,detail FROM runtime_task_commands WHERE id=$1',[paused.commandID]);
   expect(row.rows[0]).toMatchObject({status:'acknowledged',detail:'superseded by explicit task resume'});
  }finally{await e.stop(t.id);}
 });
 it('G6 retest completion changes only the finding triage version captured at start',async()=>{
  const {t}=await fixture();const retests=new RetestService(db,async()=>{throw new Error('not used');},dir,1);
  const create=async(manualChange:boolean)=>{
   const f=(await db.query("INSERT INTO findings(task_id,name,status) VALUES($1,'retest fixture','pending') RETURNING *",[t.id])).rows[0]!;
   const token='fixture-'+String(f.id),snapshot=JSON.stringify(f);
   const row=await db.query(`INSERT INTO finding_retests(finding_id,status,verdict,snapshot,lease_token,lease_until)
    VALUES($1,'running','fixed',$2::jsonb,$3,now()+interval '1 minute') RETURNING id`,[f.id,snapshot,token]);
   if(manualChange)await db.query("UPDATE findings SET status='confirmed' WHERE id=$1",[f.id]);
   await retests.finish(Number(row.rows[0]!.id),token,'completed');
   return (await db.query('SELECT status FROM findings WHERE id=$1',[f.id])).rows[0]!.status;
  };
  expect(await create(false)).toBe('fixed');
  expect(await create(true)).toBe('confirmed');
 });
 it('G5 an admitted Planner actually executing a model request starts the task deadline',async()=>{
  const {t,s,e,faux}=await fixture();await s.addGoal({text:'planner-only fixture'},'user');
  let signal:AbortSignal|undefined;
  faux.setResponses([async(_context,options)=>{signal=options?.signal;await new Promise<void>(resolve=>signal?.addEventListener('abort',()=>resolve(),{once:true}));return fauxAssistantMessage('',{stopReason:'aborted'});}]);
  try{
   await e.run(t.id);
   await until(async()=>!!signal);
   // A task lease plus actual planning is execution, as in B. Merely resolving
   // a profile or waiting in admission still must not stamp first_run_at.
   expect((await db.tasks().getTask(t.id))?.first_run_at).toBeTruthy();
  }finally{await e.stop(t.id);}
 });
 it('R13 Main commits a new intent before the host issues its one-intent dispatch grant',async()=>{
  const {t,e}=await fixture();await db.tasks().setExecutionMode(t.exploration_id,'manual');
  const worker=(await db.query("SELECT enabled FROM agents WHERE key='worker'")).rows[0]?.enabled;
  await db.query("UPDATE agents SET enabled=false WHERE key='worker'");
  try{
   const tool=addIntentTool(runContext(db,t.id,t.exploration_id,'mainagent',{hooks:{dispatchIntent:async(_expID,id)=>{await e.dispatchIntent(t.id,id);}}}));
   const result=await tool.execute('main-add',{intents:[{summary:'committed before grant'}]},undefined,undefined,{} as never);
   expect(result.isError).not.toBe(true);
   const intent=(await db.query("SELECT payload->>'dispatch_requested' requested,payload->'pending_asset_execution' AS execution_grant FROM exploration_nodes WHERE exploration_id=$1 AND kind='intent' ORDER BY id DESC LIMIT 1",[t.exploration_id])).rows[0];
   expect(intent).toMatchObject({requested:'true'});expect(intent?.execution_grant?.issuer).toBe('mainagent');
  }finally{await db.query("UPDATE agents SET enabled=$1 WHERE key='worker'",[worker]);await e.stop(t.id);}
 });
 it('G2 model request audit accepts an unbound platform conversation',async()=>{
  const row=await db.query(`INSERT INTO llm_request_attempts(task_id,role,profile_id,model,status,conversation_id)
   VALUES(NULL,'auto',NULL,'fixture','running',NULL) RETURNING id`);
  expect(row.rowCount).toBe(1);
  await db.query("DELETE FROM llm_request_attempts WHERE id=$1",[row.rows[0]!.id]);
 });
 it('R14 graph and asset tools hide records after authorization is revoked',async()=>{
  const {t,s,app}=await fixture();const asset=await db.assets().upsertRootDomain({domain:'projection.review.test',taskID:t.id});
  const node=await s.addNode('finding',{summary:'projection marker'},0,'confirmed','worker',[asset]);
  const findingID=Number((await db.query(`INSERT INTO findings(task_id,node_id,name,vulnclass,severity,summary,asset_ids) VALUES($1,$2,'projection','fixture','low','projection marker',$3::jsonb) RETURNING id`,[t.id,node,JSON.stringify([asset])])).rows[0]!.id);
  const {recordExchange,bindEvidence}=await import('./src/evidence/store.js');
  const traffic=await recordExchange(db,{taskID:t.id,intentID:node,url:'https://projection.review.test/fixture',method:'GET',status:200,reqHead:'GET /fixture HTTP/1.1',respHead:'HTTP/1.1 200',request:Buffer.alloc(0),response:Buffer.from('authorized evidence')});
  await db.transaction(tx=>bindEvidence(tx,findingID,[{traffic_id:traffic,role:'proof'}],t.id));
  const headers={'X-Series-Token':signJWT(key)};
  const bindingResponse=await app.inject({url:`/api/exploration/findings/${findingID}/traffic`,headers});
  expect(bindingResponse.json().bindings).toHaveLength(1);
  const bindingID=bindingResponse.json().bindings[0].id;
  const activityID=await s.appendActivity({node_id:node,worker:'work#fixture',kind:'tool_result',summary:'projection marker',detail:'projection full evidence'});
  expect((await app.inject({url:`/api/exploration/findings/${findingID}/traffic/${bindingID}/body`,headers})).statusCode).toBe(200);
  const ctx=runContext(db,t.id,t.exploration_id,'planner');
  const findings=listFindingsTool(ctx),assets=listAssetsTool(ctx);
  const visible=async(tool:ReturnType<typeof listFindingsTool>|ReturnType<typeof listAssetsTool>)=>JSON.parse((await tool.execute('projection',{},undefined,undefined,{} as never)).content[0]!.text);
  expect((await visible(findings)).findings).toHaveLength(1);
  expect((await visible(assets)).assets.some((a:{id:number})=>a.id===asset)).toBe(true);
  await db.query(`INSERT INTO task_asset_blocks(task_id,asset_key,asset_type,host_key) VALUES($1,'projection:block','root_domain','projection.review.test')`,[t.id]);
  expect((await app.inject({url:`/api/exploration/findings/${findingID}/traffic/${bindingID}/body`,headers})).statusCode).toBe(403);
  expect((await app.inject({url:`/api/exploration/findings/${findingID}/traffic`,headers})).statusCode).toBe(403);
  expect((await visible(findings)).findings).toHaveLength(0);
  expect((await visible(assets)).assets.some((a:{id:number})=>a.id===asset)).toBe(false);
  expect((await app.inject({url:`/api/exploration/graph?task=${t.id}`,headers})).json().nodes.some((n:{id:string})=>Number(n.id)===node)).toBe(false);
  expect((await app.inject({url:`/api/exploration/${t.exploration_id}/nodes`,headers})).json().items.some((n:{id:number})=>n.id===node)).toBe(false);
  expect((await app.inject({url:`/api/exploration/activity?task=${t.id}&since=0`,headers})).json().items.some((n:{seq:number})=>n.seq===activityID)).toBe(false);
  expect((await app.inject({url:`/api/exploration/activity/${activityID}`,headers})).statusCode).toBe(404);
  expect((await app.inject({url:`/api/exploration/findings/${node}`,headers})).statusCode).toBe(404);
 });
 it('G4 activity forward cursor never skips events beyond the requested page',async()=>{
  const {t,s,app}=await fixture(),headers={'X-Series-Token':signJWT(key)},expected:number[]=[];
  for(let i=0;i<21;i++)expected.push(await s.appendActivity({worker:'system',kind:'text',summary:`cursor-${i}`}));
  let cursor=0;const seen:number[]=[];
  for(let i=0;i<5;i++){
   const result=(await app.inject({url:`/api/exploration/activity?task=${t.id}&since=${cursor}&limit=7`,headers})).json();
   seen.push(...result.items.map((item:{seq:number})=>item.seq));cursor=result.cursor;
   if(!result.items.length)break;
  }
  expect(seen).toEqual(expected);
 });
 it('R13 explicit main dispatch of pending assets must issue a trusted execution grant',async()=>{
  const {t,s,e,faux}=await fixture();
  await db.query("UPDATE tasks SET asset_approval_template='explicit_targets' WHERE id=$1",[t.id]);
  const asset=await db.assets().upsertRootDomain({domain:'pending.review.test',taskID:t.id});
  await db.query("UPDATE task_asset_links SET approval_state='pending',source='agent' WHERE task_id=$1 AND asset_id=$2",[t.id,asset]);
  const id=await s.addIntent({summary:'explicit dispatch'},1,[asset],'user');
  expect((await db.taskScope().taskAssetApprovalStates(t.id,[asset])).get(asset)).toBe('pending');
  faux.setResponses([fauxAssistantMessage([fauxToolCall('dispatch_intents',{intent_ids:[id]})]),fauxAssistantMessage('dispatched')]);
  try{
   await e.mainChat(t.id,'execute');const node=await s.getNode(id);
   expect(await s.hasOpenIntent()||['running','done'].includes(node?.state??'')).toBe(true);
  }finally{await e.stop(t.id);}
 });
 it('R14 prove_goal must reject evidence whose asset was blocked',async()=>{
  const {t,s}=await fixture();const asset=await db.assets().upsertRootDomain({domain:'proof.review.test',taskID:t.id});
  const fact=await s.addNode('fact',{summary:'restricted evidence'},1,'confirmed','worker',[asset]);const goal=await s.addGoal({text:'prove fixture'},'user');
  await db.query("INSERT INTO task_asset_blocks(task_id,asset_key,asset_type,host_key) VALUES($1,'review:proof','root_domain','proof.review.test')",[t.id]);
  const tool=proveGoalTool(runContext(db,t.id,t.exploration_id,'planner'));
  await tool.execute('fixture',{goal_id:goal,evidence_node_id:fact},undefined,undefined,{} as never);
  expect((await s.getNode(goal))?.state).toBe('open');
 });
 it('R15 report_finding failure must roll back its graph node',async()=>{
  const {t,s}=await fixture();const id=await s.addIntent({summary:'write fixture'},1,[],'user');
  const tool=reportFindingTool(runContext(db,t.id,t.exploration_id,'worker',{intentID:id}));
  const result=await tool.execute('fixture',{vulnclass:'fixture',severity:'medium',summary:'nul'+String.fromCharCode(0),evidence:'fixture'},undefined,undefined,{} as never);
  expect(result.isError).toBe(true);
  expect((await s.listByKind('finding')).length).toBe(0);
 });

 it('R16 worker discoveries must obey the explicit approval template',async()=>{
  const {t,s}=await fixture();await db.query("UPDATE tasks SET asset_approval_template='explicit_targets' WHERE id=$1",[t.id]);
  const intentID=await s.addIntent({summary:'discovery fixture'},1,[],'user');
  const tool=insertAssetsTool(runContext(db,t.id,t.exploration_id,'worker',{intentID,workerName:'work#1'}));
  const out=await tool.execute('fixture',{items:[{type:'root_domain',domain:'new-discovery.review.test'}]},undefined,undefined,{} as never);
  expect(out.isError).not.toBe(true);
  const row=(await db.query("SELECT approval_state,source FROM task_asset_links WHERE task_id=$1",[t.id])).rows[0];
  expect(row).toMatchObject({approval_state:'pending',source:'agent'});
 });
 it('R17 related-assets grants must not extend to another tenant on a private suffix',async()=>{
  const {t}=await fixture();await db.query("UPDATE tasks SET asset_approval_template='related_assets' WHERE id=$1",[t.id]);
  await db.taskScope().addAgentScope(t.id,'subdomain','alice.github.io','fixture authorization','manual');
  await expect(db.taskScope().validateTaskHostsApproved(t.id,['unrelated.github.io'])).rejects.toThrow();
 });

 it('R18 deleting an intent must leave it stopped',async()=>{
  const {t,s,app}=await fixture();const id=await s.addIntent({summary:'delete fixture'},1,[],'user');
  const response=await app.inject({method:'DELETE',url:`/api/tasks/${t.id}/intents/${id}`,headers:{'X-Series-Token':signJWT(key)}});
  expect(response.statusCode).toBe(200);expect((await s.getNode(id))?.state).toBe('stopped');
 });
 it('R19 goal decomposition must receive the explicit task goal',async()=>{
  const {t,source,faux}=await fixture();await db.query("UPDATE tasks SET goal='explicit-acceptance-marker' WHERE id=$1",[t.id]);
  let contextText='';faux.setResponses([(context)=>{contextText=JSON.stringify(context);return fauxAssistantMessage([fauxToolCall('set_goals',{goals:[{text:'explicit-acceptance-marker'}]})]);},fauxAssistantMessage('saved')]);
  await runGoalsDecompose({db,taskID:t.id,expID:t.exploration_id,model:source,dataDir:dir,description:'background only'});
  expect(contextText).toContain('explicit-acceptance-marker');
 });
 it('R20 restarting a timed out task must reset its expired deadline',async()=>{
  const {t,post,e}=await fixture();
  await db.query("UPDATE tasks SET status='timeout',timeout_seconds=60,first_run_at=now()-interval '2 minutes',deadline_at=now()-interval '1 minute' WHERE id=$1",[t.id]);
  try{
   const response=await post(`/api/tasks/${t.id}/start`,{});expect(response.statusCode).toBe(200);
   const r=await db.query<{future:boolean}>('SELECT (deadline_at IS NULL OR deadline_at>now()) AS future FROM tasks WHERE id=$1',[t.id]);
   expect(r.rows[0]?.future).toBe(true);
  }finally{await e.stop(t.id);}
 });

});

describe('model chain integration',()=>{
 it.each(['429 rate limit','stream interrupted before completion'])('retries %s at the model boundary without replaying a committed tool',async error=>{
  const {t}=await fixture();const profile=await db.platform().saveProfile({name:'retry fixture '+t.id,model:'retry-fake',format:'openai',apiKey:'fixture',retry:{connect:{attempts:1,interval_ms:1}}});
  await db.query('INSERT INTO task_llm_profiles(task_id,profile_id,position) VALUES($1,$2,0)',[t.id,profile]);
  let writes=0;const faux=fauxProvider({provider:'retry'+t.id,api:'retry'+t.id});
  faux.setResponses([fauxAssistantMessage([fauxToolCall('fixture_commit',{})]),fauxAssistantMessage('',{stopReason:'error',errorMessage:error}),fauxAssistantMessage('complete')]);
  const runtime=await ModelRuntime.create({refreshOnCreate:false});await runtime.registerNativeProvider(faux.provider);
  const resolver=makeModelResolver(db,async()=>({modelRuntime:runtime,model:faux.getModel() as never}));
  const {domainTool}=await import('./src/tools/define.js');
  const runner=await AgentRunner.create({...await resolver(t.id,'mainagent'),cwd:dir,agentDir:path.join(dir,'retry-pi'),inMemory:true,maxTurns:8,toolAllowlist:['fixture_commit'],customTools:[domainTool({name:'fixture_commit',description:'local fixture',parameters:{type:'object'},async run(){writes++;return {committed:true};}},runContext(db,t.id,t.exploration_id,'mainagent'))]});
  try{expect((await runner.prompt('commit once then summarize')).lastAssistantText).toBe('complete');}finally{await runner.dispose();}
  expect(writes).toBe(1);expect(faux.state.callCount).toBe(3);
  expect((await db.query('SELECT status FROM llm_request_attempts WHERE task_id=$1 ORDER BY id',[t.id])).rows.map(r=>r.status)).toEqual(['completed','failed','completed']);
 });
 it('uses native pi continuation for 401 failover and audits each physical request',async()=>{
  const {t}=await fixture();
  const a=await db.platform().saveProfile({name:'bad fixture',model:'fake-a',format:'openai',apiKey:'fixture-a'});
  const b=await db.platform().saveProfile({name:'good fixture',model:'fake-b',format:'openai',apiKey:'fixture-b'});
  await db.query(`INSERT INTO task_llm_profiles(task_id,profile_id,position) VALUES($1,$2,0),($1,$3,1)`,[t.id,a,b]);
  expect((await resolveModelProfiles(db,t.id,'worker')).profiles.map(p=>p.id)).toEqual([a,b]);
  const calls:number[]=[];
  const resolver=makeModelResolver(db,async p=>{
   const faux=fauxProvider({provider:'chain'+p.id,api:'chain'+p.id});
   faux.setResponses([()=>{calls.push(p.id);return p.id===a?fauxAssistantMessage('',{stopReason:'error',errorMessage:'401 invalid api key'}):fauxAssistantMessage('fallback-success');}]);
   const runtime=await ModelRuntime.create({refreshOnCreate:false});await runtime.registerNativeProvider(faux.provider);
   return {modelRuntime:runtime,model:faux.getModel() as never};
  });
  const source=await resolver(t.id,'mainagent');
  expect(source.model.api).toBe('pi-virtual');
  const runner=await AgentRunner.create({...source,cwd:dir,agentDir:path.join(dir,'test-pi'),inMemory:true,toolAllowlist:[],maxTurns:5});
  try{expect((await runner.prompt('ping')).lastAssistantText).toBe('fallback-success');}finally{await runner.dispose();}
  expect(calls).toEqual([a,b]);
  expect((await resolveModelProfiles(db,t.id,'worker')).resolution.profile_id).toBe(b);
  const audit=await db.query('SELECT profile_id,status FROM llm_request_attempts WHERE task_id=$1 ORDER BY id',[t.id]);
  expect(audit.rows.map(r=>r.status)).toEqual(['failed','completed']);
 });
});

describe('restored feature contracts',()=>{
 it('failed uploads with dot filenames preserve the data directory and remove uncommitted blobs',async()=>{
  const {app,t}=await fixture();const fs=await import('node:fs/promises'),{createHash}=await import('node:crypto');
  const marker=path.join(dir,'keep-existing-data');await fs.writeFile(marker,'preserve');
  await db.query("CREATE FUNCTION reject_acceptance_upload() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture upload failure'; END $$");
  await db.query('CREATE TRIGGER reject_acceptance_upload BEFORE INSERT ON chat_artifacts FOR EACH ROW EXECUTE FUNCTION reject_acceptance_upload()');
  const body='unique upload rollback fixture',hash=createHash('sha256').update(body).digest('hex');
  try{
   const response=await app.inject({method:'POST',url:`/api/chat/upload?scope=task&id=${t.id}`,headers:{'X-Series-Token':signJWT(key),'Content-Type':'multipart/form-data; boundary=acceptance'},payload:`--acceptance\r\nContent-Disposition: form-data; name="file"; filename=".."\r\nContent-Type: text/plain\r\n\r\n${body}\r\n--acceptance--\r\n`});
   expect(response.statusCode).toBe(500);expect(await fs.readFile(marker,'utf8')).toBe('preserve');
   expect((await db.query('SELECT id FROM chat_artifacts WHERE task_id=$1',[t.id])).rowCount).toBe(0);
   expect((await db.query('SELECT hash FROM evidence_blobs WHERE hash=$1',[hash])).rowCount).toBe(0);
   await expect(fs.stat(path.join(dir,'evidence',hash.slice(0,2),hash))).rejects.toMatchObject({code:'ENOENT'});
  }finally{await db.query('DROP TRIGGER reject_acceptance_upload ON chat_artifacts');await db.query('DROP FUNCTION reject_acceptance_upload()');}
 });
 it('exposes effective and pending runtime configuration and enforces tool disablement before execution',async()=>{
  const {t,source,faux,app}=await fixture();const {createTrackedRunner}=await import('./src/engine/runtime-config.js');
  const {domainTool}=await import('./src/tools/define.js');let executed=0;
  await db.query("INSERT INTO tools(key,description,kind,enabled,agents) VALUES('runtime_fixture','before','builtin',true,'[\"mainagent\"]')");
  faux.setResponses([fauxAssistantMessage([fauxToolCall('runtime_fixture',{})]),fauxAssistantMessage('disabled')]);
  const runner=await createTrackedRunner(db,t.id,'mainagent',{...source,systemPrompt:'LOCAL runtime fixture',cwd:dir,agentDir:path.join(dir,'runtime-pi'),inMemory:true,maxTurns:4,toolAllowlist:['runtime_fixture'],customTools:[domainTool({name:'runtime_fixture',description:'fixture',parameters:{type:'object'},async run(){executed++;return {ok:true};}},runContext(db,t.id,t.exploration_id,'mainagent'))]});
  try{
   await db.query("UPDATE tools SET description='after',enabled=false WHERE key='runtime_fixture'");
   const response=await app.inject({url:`/api/tasks/${t.id}/runtime-config`,headers:{'X-Series-Token':signJWT(key)}});
   expect(response.statusCode).toBe(200);expect(response.json().active[0]).toMatchObject({effective:{tools:['runtime_fixture']},pending:{changed_fields:expect.arrayContaining(['tools_hash'])}});
   await runner.prompt('invoke fixture');expect(executed).toBe(0);
  }finally{await runner.dispose();await db.query("DELETE FROM tools WHERE key='runtime_fixture'");}
 });
 it('a remote Retester stop stays pending until the executor acknowledges or its lease expires',async()=>{
  const {t}=await fixture();const service=new RetestService(db,async()=>{throw new Error('unused');},dir,1);
  const fid=Number((await db.query("INSERT INTO findings(task_id,name) VALUES($1,'LOCAL stop fixture') RETURNING id",[t.id])).rows[0]!.id);
  const cid=Number((await db.query("INSERT INTO conversations(agent_key,title) VALUES('retester','LOCAL stop fixture') RETURNING id")).rows[0]!.id);
  const rid=Number((await db.query("INSERT INTO finding_retests(finding_id,conversation_id,snapshot,status,lease_token,lease_until) VALUES($1,$2,'{}','running','other-instance',now()+interval '15 seconds') RETURNING id",[fid,cid])).rows[0]!.id);
  expect(await service.stop(cid)).toEqual({status:'stopping'});
  expect((await db.query('SELECT status,stop_requested FROM finding_retests WHERE id=$1',[rid])).rows[0]).toEqual({status:'running',stop_requested:true});
  expect(await service.finish(rid,'other-instance','completed')).toBeUndefined();
  await db.query("UPDATE finding_retests SET lease_until=now()-interval '1 second' WHERE id=$1",[rid]);
  await service.pump();expect(await service.stop(cid)).toEqual({status:'stopped'});
 });
 it('a bound native Pentest writes facts with conversation provenance without creating runnable intents',async()=>{
  const {t,e,faux,post}=await fixture();
  faux.setResponses([fauxAssistantMessage([fauxToolCall('record_conversation_fact',{summary:'LOCAL bound conversation evidence',evidence:'offline fixture'})]),fauxAssistantMessage('saved')]);
  const response=await post('/api/conversations',{agent_key:'pentest',task_id:t.id,title:'LOCAL bound fixture'});
  expect(response.statusCode).toBe(201);const cid=response.json().id;
  expect((await post(`/api/conversations/${cid}/messages`,{message:'保存本地事实，不访问网络'})).statusCode).toBe(202);
  await until(async()=>!!(await db.query("SELECT id FROM conversation_runs WHERE conversation_id=$1 AND status='completed'",[cid])).rowCount);
  const facts=(await db.query("SELECT * FROM exploration_nodes WHERE exploration_id=$1 AND kind='fact' AND state='confirmed'",[t.exploration_id])).rows;
  expect(facts).toHaveLength(1);expect(facts[0]!.payload).toMatchObject({source_conversation_id:cid});
  expect((await db.query("SELECT id FROM exploration_nodes WHERE exploration_id=$1 AND kind='intent'",[t.exploration_id])).rowCount).toBe(0);
  const other=await fixture();const {recordFactTool}=await import('./src/tools/graph.js');
  const wrong=await recordFactTool(runContext(db,other.t.id,other.t.exploration_id,'pentest',{conversationID:cid})).execute('cross-task',{summary:'must be rejected'});
  expect(wrong.isError).toBe(true);await e.conversations.shutdown();
 });
 it('retains every oversized tool result byte with a scoped continuation and raw download',async()=>{
  const {t,s,app}=await fixture(),other=await fixture();
  const {domainTool,MAX_TOOL_OUTPUT}=await import('./src/tools/define.js');
  const {toolOutputTool}=await import('./src/tools/output.js');
  const intent=await s.addIntent({summary:'long result'},1,[],'user');
  const ctx=runContext(db,t.id,t.exploration_id,'worker',{intentID:intent});
  const payload={items:Array.from({length:140},(_,i)=>({id:i,body:'证据😀"\\'.repeat(50)})),next_cursor:141};
  const tool=domainTool({name:'fixture_output',description:'fixture',parameters:{type:'object'},async run(){return payload;}},ctx);
  let page=JSON.parse((await tool.execute('large-result',{})).content[0]!.text!);
  const ref=page.output_ref;expect(ref).toBeTruthy();let body='';
  for(let i=0;i<200;i++){
   expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(MAX_TOOL_OUTPUT);
   body+=page.content;if(page.next_offset===null)break;
   page=JSON.parse((await toolOutputTool(ctx).execute('read-page',{output_ref:ref,offset:page.next_offset})).content[0]!.text!);
  }
  expect(JSON.parse(body)).toEqual(payload);
  const denied=await toolOutputTool(runContext(db,other.t.id,other.t.exploration_id,'worker')).execute('wrong-task',{output_ref:ref});
  expect(denied.isError).toBe(true);
  const download=await app.inject({url:`/api/tool-outputs/${ref}?download=1`,headers:{'X-Series-Token':signJWT(key)}});
  expect(download.statusCode).toBe(200);expect(download.json()).toEqual(payload);
 });
 it('checks a directed retest scope again on redirects before sending a second request',async()=>{
  const {t}=await fixture();const {evidenceRequest}=await import('./src/evidence/http.js');
  const fetch=vi.fn().mockResolvedValue(new Response('',{status:302,headers:{location:'http://other.review.test:9080/'}}));vi.stubGlobal('fetch',fetch);
  try{
   const ctx=runContext(db,t.id,t.exploration_id,'retester',{networkTargets:[{host:'only.review.test',port:9080}]});
   await expect(evidenceRequest(ctx,{url:'http://only.review.test:9080/'})).rejects.toThrow('定向复测范围');
   expect(fetch).toHaveBeenCalledTimes(1);
  }finally{vi.unstubAllGlobals();}
 });
 it('requires an intent-specific pending grant on HTTP egress',async()=>{
  const {t,s}=await fixture();await db.query("UPDATE tasks SET asset_approval_template='explicit_targets' WHERE id=$1",[t.id]);
  const asset=await db.assets().upsertRootDomain({domain:'pending-http.review.test',taskID:t.id});
  await db.query("UPDATE task_asset_links SET approval_state='pending',source='agent' WHERE task_id=$1",[t.id]);
  const intent=await s.addIntent({summary:'pending egress fixture'},1,[asset],'user');
  const {evidenceRequest}=await import('./src/evidence/http.js');const fetch=vi.fn().mockResolvedValue(new Response('allowed'));vi.stubGlobal('fetch',fetch);
  const ctx=runContext(db,t.id,t.exploration_id,'worker',{intentID:intent});
  try{
   await expect(evidenceRequest(ctx,{url:'https://pending-http.review.test/'})).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
   await db.query(`UPDATE exploration_nodes SET payload=payload||'{"pending_asset_execution":{"issuer":"mainagent"}}'::jsonb WHERE id=$1`,[intent]);
   await expect(evidenceRequest(ctx,{url:'https://pending-http.review.test/'})).resolves.toMatchObject({status:200});expect(fetch).toHaveBeenCalledTimes(1);
  }finally{vi.unstubAllGlobals();}
 });
 it('fences proxy requests from an expired task lease and a paused intent',async()=>{
  const {t,s}=await fixture();const {Coordinator}=await import('./src/engine/coordinator.js');const {authorizeTaskRequest}=await import('./src/egress/gateway.js');
  const coordinator=new Coordinator(db,1),token=(await coordinator.acquire(t.id))!;
  const intent=await s.addIntent({summary:'proxy lease fixture'},1,[],'user');await s.setIntentState(intent,'running');
  await db.query("UPDATE tasks SET status='running' WHERE id=$1",[t.id]);
  const scope=`worker:${intent}:${token}`;
  await expect(authorizeTaskRequest(db,t.id,'scope.review.test',443,scope)).resolves.toBeUndefined();
  await s.setIntentState(intent,'paused');await expect(authorizeTaskRequest(db,t.id,'scope.review.test',443,scope)).rejects.toThrow('意图已停止');
  await s.setIntentState(intent,'running');await db.query("UPDATE engine_task_leases SET expires_at=now()-interval '1 second' WHERE task_id=$1",[t.id]);
  await expect(authorizeTaskRequest(db,t.id,'scope.review.test',443,scope)).rejects.toThrow('租约已失效');
 });
 it('preserves immutable HTTP evidence after inbox deletion and rejects stale edits',async()=>{
  const {t,s,app,post}=await fixture();const intent=await s.addIntent({summary:'evidence fixture',dispatch_requested:true},1,[],'user');await s.claimNextWorker('work#1');
  const {recordExchange,evidenceBody}=await import('./src/evidence/store.js');
  const traffic=await recordExchange(db,{taskID:t.id,intentID:intent,url:'https://example.test/fixture',method:'GET',status:200,reqHead:'GET /fixture HTTP/1.1',respHead:'HTTP/1.1 200',request:Buffer.alloc(0),response:Buffer.from('x'.repeat(40000)+'evidence-tail')});
  const tool=reportFindingTool(runContext(db,t.id,t.exploration_id,'worker',{intentID:intent,workerName:'work#1'}));
  const input={vulnclass:'fixture',severity:'low' as const,summary:'verified fixture',evidence:'local test only',traffic_refs:[{traffic_id:traffic,role:'proof'}]};
  const first=await tool.execute('idempotent-call',input,undefined,undefined,{} as never);
  expect(first.isError,JSON.stringify(first)).toBeFalsy();
  const again=await tool.execute('idempotent-call',input,undefined,undefined,{} as never);
  expect(again).toEqual(first);
  const finding=JSON.parse((first.content[0] as {text:string}).text).finding_id;
  const bindings=await app.inject({url:`/api/exploration/findings/${finding}/traffic`,headers:{'X-Series-Token':signJWT(key)}});
  expect(bindings.statusCode).toBe(200);expect(bindings.json().bindings).toHaveLength(1);
  const bid=bindings.json().bindings[0].id;
  const stale=await app.inject({method:'PATCH',url:`/api/exploration/findings/${finding}/traffic/${bid}`,payload:{version:0,role:'proof',note:'stale'},headers:{'X-Series-Token':signJWT(key)}});
  expect(stale.statusCode).toBe(409);
  await app.inject({method:'DELETE',url:'/api/traffic/all',headers:{'X-Series-Token':signJWT(key)}});
  expect((await evidenceBody(db,traffic,'response',40000)).content).toBe('evidence-tail');
  const retained=await app.inject({url:`/api/exploration/findings/${finding}/traffic/${bid}/body?offset=40000`,headers:{'X-Series-Token':signJWT(key)}});
  expect(retained.statusCode).toBe(200);expect(retained.json().content).toBe('evidence-tail');
  expect((await db.query('SELECT id FROM findings WHERE task_id=$1',[t.id])).rowCount).toBe(1);
 });
 it('accepts uploaded text, rejects cross-task references and keeps attachment metadata',async()=>{
  const {t,app,post,faux}=await fixture();const other=await fixture();
  const boundary='fixture-boundary',payload=`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\nattachment-fixture-marker\r\n--${boundary}--\r\n`;
  const uploaded=await app.inject({method:'POST',url:`/api/chat/upload?scope=task&id=${t.id}`,headers:{'X-Series-Token':signJWT(key),'content-type':`multipart/form-data; boundary=${boundary}`},payload});
  expect(uploaded.statusCode).toBe(200);const attachments=uploaded.json().attachments;
  let messages='';faux.setResponses([context=>{messages=JSON.stringify(context);return fauxAssistantMessage('attachment read');}]);
  expect((await post(`/api/tasks/${t.id}/chat`,{message:'read',attachments})).statusCode).toBe(200);
  expect(messages).toContain('attachment-fixture-marker');
  expect((await other.post(`/api/tasks/${other.t.id}/chat`,{message:'read',attachments})).statusCode).toBe(404);
  const activity=await db.query("SELECT metadata FROM activity WHERE exploration_id=$1 AND kind='user'",[t.exploration_id]);
  expect(activity.rows[0]?.metadata.attachments[0].path).toBe(attachments[0].path);
 });
 it('runs an independent native pi retest and retains the original finding status',async()=>{
  const {t,post,faux}=await fixture();
  const row=await db.query("INSERT INTO findings(task_id,name,status) VALUES($1,'fixture','confirmed') RETURNING id",[t.id]);
  const fid=Number(row.rows[0]!.id);
  faux.setResponses([fauxAssistantMessage([fauxToolCall('record_finding_retest_result',{verdict:'inconclusive',summary:'fixture has no target',evidence:'offline fixture'})]),fauxAssistantMessage('recorded')]);
  const started=await post(`/api/exploration/findings/${fid}/retests`,{notes:'do not access network'});
  expect(started.statusCode).toBe(200);const retestID=Number(started.json().retest.id);
  await until(async()=>!(await db.query("SELECT id FROM finding_retests WHERE id=$1 AND status IN ('pending','running')",[retestID])).rowCount);
  const retest=(await db.query('SELECT status,verdict,error FROM finding_retests WHERE id=$1',[retestID])).rows[0];
  expect(retest).toMatchObject({status:'completed',verdict:'inconclusive',error:''});
  expect((await db.query('SELECT status FROM findings WHERE id=$1',[fid])).rows[0]?.status).toBe('confirmed');
 });
 it('prevents a second engine from resetting another owner’s running intent',async()=>{
  const {t,s,e,faux,source}=await fixture();await db.tasks().setExecutionMode(t.exploration_id,'manual');
  const id=await s.addIntent({summary:'single owner',dispatch_requested:true},1,[],'user');
  let signal:AbortSignal|undefined;faux.setResponses([async(_c,o)=>{signal=o?.signal;await new Promise<void>(resolve=>signal?.addEventListener('abort',()=>resolve(),{once:true}));return fauxAssistantMessage('',{stopReason:'aborted'});}]);
  const second=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:2},async()=>source,dir);engines.push(second);
  try{await e.run(t.id);await until(async()=>!!signal);await second.run(t.id);expect((await s.getNode(id))?.state).toBe('running');expect(faux.state.callCount).toBe(1);}finally{await e.stop(t.id);await second.stop(t.id);}
 });
 it('shares the worker concurrency limit across tasks',async()=>{
  const a=await fixture(),b=await fixture();
  for(const f of [a,b]){await db.tasks().setExecutionMode(f.t.exploration_id,'manual');await f.s.addIntent({summary:'global slot',dispatch_requested:true},1,[],'user');}
  let signal:AbortSignal|undefined;a.faux.setResponses([async(_c,o)=>{signal=o?.signal;await new Promise<void>(resolve=>signal?.addEventListener('abort',()=>resolve(),{once:true}));return fauxAssistantMessage('',{stopReason:'aborted'});}]);
  try{await a.e.run(a.t.id);await until(async()=>!!signal);await b.e.run(b.t.id);await new Promise(r=>setTimeout(r,120));expect(b.faux.state.callCount).toBe(0);await a.e.stop(a.t.id);await until(async()=>b.faux.state.callCount>0);}finally{await a.e.stop(a.t.id);await b.e.stop(b.t.id);}
 });
 it('queues task admission FIFO and fences an expired owner',async()=>{
  for(const engine of engines)await engine.shutdown();
  await db.query("UPDATE tasks SET status='done'");
  const {Coordinator}=await import('./src/engine/coordinator.js');
  const a=await fixture(),b=await fixture(),c=await fixture();
  const coordinator=new Coordinator(db,1),other=new Coordinator(db,1);
  await db.platform().setSetting('task_concurrency_enabled','true');await db.platform().setSetting('task_concurrency_limit','1');
  try{
   expect(await db.transaction(tx=>coordinator.admit(tx,a.t.id))).toBe(true);
   expect(await db.transaction(tx=>coordinator.admit(tx,b.t.id))).toBe(false);
   expect(await db.transaction(tx=>coordinator.admit(tx,c.t.id))).toBe(false);
   const token=(await coordinator.acquire(a.t.id))!;expect(await other.acquire(a.t.id)).toBeUndefined();
   await db.query("UPDATE engine_task_leases SET expires_at=now()-interval '1 second' WHERE task_id=$1",[a.t.id]);
   expect(await other.acquire(a.t.id)).toBeTruthy();await expect(coordinator.assert(a.t.id,token)).rejects.toThrow();
   await db.query("UPDATE tasks SET status='done' WHERE id=$1",[a.t.id]);
   expect(await coordinator.promote()).toEqual([b.t.id]);expect((await db.tasks().getTask(c.t.id))?.queued).toBe(true);
  }finally{await db.platform().setSetting('task_concurrency_enabled','false');}
 });
});
