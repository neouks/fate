// Real DeepSeek + native pi + real HTTP API. The only execution target is the
// in-process synthetic HTTP fixture; no historical task or global profile is changed.
import pg from 'pg';
import http from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Database,openDatabase} from '../src/db/index.js';
import {postgresDSN} from '../src/config/index.js';
import {Engine,defaultEngineConfig} from '../src/engine/engine.js';
import {makeModelResolver} from '../src/pi/modelResolver.js';
import {resolveRolePrompt} from '../src/agent/prompts.js';
import {configureAgentEnv} from '../src/agent/roles.js';
import {AgentRunner} from '../src/pi/runner.js';
import {buildApp} from '../src/http/app.js';
import {signJWT} from '../src/http/auth.js';
import {configureEvidenceStore} from '../src/evidence/blobs.js';

const output=process.env.FATE_LIFECYCLE_OUTPUT!,ledgerPath=process.env.FATE_LIFECYCLE_LEDGER!;
if(!output||!ledgerPath||existsSync(output))throw new Error('fresh output and existing shared request ledger required');
const ledger=JSON.parse(readFileSync(ledgerPath,'utf8'));
assert.equal(ledger.baseline,72);assert.equal(ledger.allowance,500);
const lock=ledgerPath+'.lock';writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});
mkdirSync(path.dirname(output),{recursive:true});
const runID=randomUUID(),name=`fate_live_lifecycle_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-live-lifecycle-'));
const initialCalls=ledger.requests.length,maxCalls=Math.min(120,500-initialCalls),deadline=Date.now()+20*60_000;
const record:any={run_id:runID,started_at:new Date().toISOString(),status:'running',db:name,data_dir:dir,source_version:'worker-lifecycle-fixed-20261018',
  initial_used:initialCalls,physical_request_limit:maxCalls,calls:0,external_target_requests:0,fixture_requests:[],cases:[],runner_results:[]};
const save=()=>writeFileSync(output,JSON.stringify(record,null,2)+'\n');
const saveLedger=()=>writeFileSync(ledgerPath,JSON.stringify(ledger,null,2)+'\n');
const originalFetch=globalThis.fetch,originalPrompt=AgentRunner.prototype.prompt;
let db:Database|undefined,engine:Engine|undefined,app:ReturnType<typeof buildApp>|undefined,key='',base='',fixtureBase='';
let current:any;const samples=new Map<string,string>();
const redact=(e:unknown)=>String(e).split(key||'\0').join('[redacted]').replace(/(?:Bearer\s+|\bsk-)[\w.-]+/gi,'[redacted]');
const fixture=http.createServer((req,res)=>{
  const url=new URL(req.url!,fixtureBase),[_,kind,action]=url.pathname.split('/'),nonce=samples.get(kind!);
  const accepted=req.method==='GET'&&nonce&&(action==='sample'||action==='confirm'&&url.searchParams.get('token')===nonce);
  record.fixture_requests.push({at:new Date().toISOString(),method:req.method,path:url.pathname,action,case:kind,accepted:!!accepted});save();
  if(record.fixture_requests.length>30){res.writeHead(429);res.end('fixture request limit');return;}
  res.writeHead(accepted?200:400,{'content-type':'application/json'});
  res.end(JSON.stringify(accepted?(action==='sample'?{fixture:'SYNTHETIC',sample:'ALPHA',values:[4,7,9],token:nonce}:{fixture:'SYNTHETIC',verified:true,total:20,token:nonce}):{error:'invalid fixture request'}));
});
async function until(fn:()=>Promise<any>,label:string,ms=480_000){
  const end=Math.min(Date.now()+ms,deadline);
  while(Date.now()<end){const v=await fn();if(v)return v;if(record.denied_requests)throw new Error(`request budget exhausted: ${label}`);await new Promise(r=>setTimeout(r,100));}
  throw new Error(`timeout: ${label}`);
}
const api=async(url:string,body?:unknown,method=body===undefined?'GET':'POST')=>{
  const r=await originalFetch(base+url,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30_000)});
  const value=await r.json();assert.ok(r.ok,`${url}: ${r.status} ${JSON.stringify(value)}`);return value as any;
};
const jwtKey=randomUUID(),token=signJWT(jwtKey);
async function startHost(){
  engine=new Engine(db!,{...defaultEngineConfig(),workers:1,debounceMs:150},makeModelResolver(db!),dir);
  app=buildApp({version:'deepseek-lifecycle-acceptance',startedAt:Date.now(),db:db!,engine,jwtKey,skillsRoot:path.join(dir,'skills'),dataDir:dir});
  base=await app.listen({host:'127.0.0.1',port:0});engine.startScheduler();record.api_base=base;save();
}
try{
  const source=new Database(new pg.Pool({connectionString:postgresDSN().dsn}));
  const profileID=Number(process.env.FATE_LIFECYCLE_PROFILE_ID??453);
  const profile=await source.platform().profileByID(profileID);
  const prompts=await Promise.all(['goals','planner','worker','mainagent'].map(async role=>({role,...await resolveRolePrompt(source,role)})));
  const configs=(await source.query("SELECT key,max_turns,run_seconds,wrapup_max_turns,wrapup_prompt FROM agents WHERE key IN ('goals','planner','worker','mainagent')")).rows;
  await source.close();
  assert.ok(profile?.apiKey&&profile.model==='deepseek-flash'&&new URL(profile.baseURL).hostname==='api.deepseek.com','approved runtime profile required');
  key=profile.apiKey;
  process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}?sslmode=disable`;
  process.env.SERIES_LOG_LEVEL='silent';db=await openDatabase();configureEvidenceStore(db,dir);
  mkdirSync(path.join(dir,'skills'));configureAgentEnv({skillsDir:path.join(dir,'skills')});
  await new Promise<void>(resolve=>fixture.listen(0,'127.0.0.1',resolve));fixtureBase=`http://127.0.0.1:${(fixture.address() as any).port}`;
  globalThis.fetch=async(input,init)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    if(url.origin===fixtureBase){assert.equal(init?.method??'GET','GET');return originalFetch(input,init);}
    if(url.protocol!=='https:'||url.hostname!=='api.deepseek.com')throw new Error('acceptance denies all non-model, non-fixture outbound requests');
    if(record.calls>=maxCalls||ledger.requests.length>=ledger.allowance||Date.now()>=deadline){record.denied_requests=(record.denied_requests??0)+1;save();throw new Error('physical request budget exhausted');}
    const body=typeof init?.body==='string'?JSON.parse(init.body):{},names=(body.tools??[]).map((t:any)=>t.function.name);
    const role=names.includes('complete_intent')?'worker':names.includes('record_plan_decision')?'planner':names.includes('set_goals')?'goals':'compaction';
    let intent:any,facts:any[]=[];
    if(role==='worker'&&current?.task_id){
      const s=db!.exploration(current.exploration_id);intent=(await s.listByKind('intent')).find(n=>n.state==='running');
      if(intent)facts=(await s.listByKind('fact')).filter(n=>n.state==='confirmed'&&n.payload.from_intent===intent.id);
      if(current.resumed&&intent?.id===current.interrupted_intent&&!current.resumed_context){
        const messages=JSON.stringify(body.messages);
        current.resumed_context={intent_id:intent.id,has_prior_fact:current.saved_facts.every((n:any)=>messages.includes(String(n.id))),has_recovery:messages.includes('task_paused'),at:new Date().toISOString()};
      }
    }
    const req:any={number:ledger.requests.length+1,run_id:runID,role,task_id:current?.task_id,intent_id:intent?.id,at:new Date().toISOString(),bytes:Buffer.byteLength(JSON.stringify(body)),tools:names};
    ledger.requests.push(req);record.calls++;saveLedger();save();
    try{
      const response=await originalFetch(input,init);req.status=response.status;saveLedger();
      // The provider has received a real request and returned headers. Interrupt
      // before consuming its result, after the prior fact is already committed.
      if(current?.kind==='pause_restart'&&!current.pause_injected&&role==='worker'&&facts.length&&!intent.payload.execution_result&&response.ok){
        current.pause_injected=true;current.pause_ready=true;current.interrupted_intent=intent.id;current.saved_facts=facts;
        current.pause_boundary='real provider response headers received; result not delivered to pi';save();
        await new Promise<void>((resolve,reject)=>{
          if(init?.signal?.aborted)resolve();else init?.signal?.addEventListener('abort',()=>resolve(),{once:true});
          const timer=setTimeout(()=>reject(new Error('pause driver did not abort in time')),15_000);timer.unref();
        });
        await response.body?.cancel().catch(()=>{});req.interrupted=true;req.usage_unavailable=true;saveLedger();
        throw new DOMException('intentional acceptance pause','AbortError');
      }
      return response;
    }catch(e){req.error=redact(e);saveLedger();throw e;}
  };
  AgentRunner.prototype.prompt=async function(...args:Parameters<typeof originalPrompt>){
    const platform=(this as any).opts.platform,started=new Date().toISOString();
    try{const result=await originalPrompt.apply(this,args);record.runner_results.push({role:platform?.role,task_id:platform?.taskID,started_at:started,finished_at:new Date().toISOString(),...result});save();return result;}
    catch(e){record.runner_results.push({role:platform?.role,task_id:platform?.taskID,started_at:started,error:redact(e)});save();throw e;}
  };
  const pid=await db.platform().saveProfile({...profile,id:undefined,name:'LOCAL real DeepSeek lifecycle acceptance',isDefault:true,poolExclude:true,proxy:'',streaming:true});
  for(const p of prompts){const agent=await db.platform().getAgentByKey(p.role);assert.ok(agent);await db.platform().savePrompt(agent.id,p.template,'isolated copy of current runtime prompt','acceptance');}
  for(const c of configs)await db.query('UPDATE agents SET max_turns=$2,run_seconds=$3,wrapup_max_turns=$4,wrapup_prompt=$5 WHERE key=$1',[c.key,c.max_turns,c.run_seconds,c.wrapup_max_turns,c.wrapup_prompt]);
  record.prompt_versions=prompts.map(p=>({role:p.role,source:p.source,version:p.version}));record.role_budgets=configs.map(({wrapup_prompt,...c})=>c);
  const safe=['set_goals','set_constraints','register_user_target','add_task_scope','add_intent','checkpoint_intent','record_fact','complete_intent','prove_goal','record_plan_decision','context_search','context_get','graph_overview','list_findings','list_assets','todo_write','http_request','traffic_body','read_tool_output','node_detail','list_facts','expand_index','expand_digest'];
  await db.query('UPDATE tools SET enabled=key=ANY($1::text[])',[safe]);await db.platform().setSetting('workers','1');
  await startHost();
  for(const kind of (process.env.FATE_LIFECYCLE_CASES??'serial,pause_restart').split(',')){
    samples.set(kind,randomUUID());const sampleURL=`${fixtureBase}/${kind}/sample`;
    const asset=await db.assets().upsertHTTPService({url:sampleURL,pageTitle:'LOCAL SYNTHETIC fixture'});
    const goal='完成两阶段串行核验，保存两条有真实本地 HTTP 证据的事实及结果：先读取样本计算合计，再独立复核其 token 与合计，确认 verified=true。';
    const description=`这是本地平台调度验收，无漏洞目标。唯一授权资源是 ${fixtureBase} 的本组路径 /${kind}/sample 和 /${kind}/confirm?token=<sample 中返回的 token>，只允许 GET，每阶段最多两次请求。资产 ID=${asset}，所有意图、事实必须锚定该资产。禁止外部网络、扫描、命令、文件和 MCP。\n第一阶段：Planner 下发一个读取 sample 的意图；Worker 先保存检查点，用 http_request 获取 JSON，计算 values 合计，将 sample、values、合计、token 和 traffic_id 保存为 observed 事实，提交 complete_intent。第二阶段必须等第一意图 done 后，Planner 阅读第一条事实，以其为父节点和依据，下发一个独立复核意图；第二 Worker 读取该事实，GET confirm 的 token 必须来自第一条事实，核对返回 verified 和 total 与第一阶段计算结果一致，写一条新 observed 事实并提交验收。每个阶段只完成自己的意图，不代做下一阶段。\n总共两个串行意图，不并行，不重复下发，不探索其他方向。中断后根据已有检查点和事实继续同一意图，不重复已经成功的请求。Planner 等待两条意图结果均完成，再依据观察事实 prove_goal 并自然结束。最终交付是两阶段结果，不把操作步骤拆成额外目标。`;
    current={kind,asset_id:asset,sample_url:sampleURL,started_at:new Date().toISOString(),status:'running'};record.cases.push(current);save();
    const t=await api('/api/tasks',{name:`REAL-PI-LIFECYCLE-${kind}-${runID.slice(0,8)}`,description,goal,execution_mode:'managed',llm_profile_ids:[pid],asset_ids:[asset],coverage_enabled:false,timeout_seconds:600,plan_heartbeat_seconds:30});
    Object.assign(current,{task_id:Number(t.id),exploration_id:t.exploration_id});save();
    const s=db.exploration(t.exploration_id);
    if(kind==='pause_restart'){
      await until(async()=>current.pause_ready,'post-fact pause boundary');
      const start=Date.now();current.pause_response=await api(`/api/tasks/${t.id}/pause`,{});current.pause_latency_ms=Date.now()-start;
      assert.equal(current.pause_response.status,'paused');assert.ok(current.pause_latency_ms<10_000);
      const n=(await s.getNode(current.interrupted_intent))!;current.paused_node=n;
      assert.equal(n.state,'open');assert.equal((n.payload.execution_stop as any)?.reason,'task_paused');assert.ok(!n.payload.execution_result);
      const session=path.join(dir,'sessions',`exp${t.exploration_id}-worker-i${n.id}.jsonl`);
      current.session_before=JSON.parse(readFileSync(session,'utf8').split('\n')[0]!);
      await engine!.shutdown();await app!.close();engine=undefined;app=undefined;
      const calls=record.calls;await new Promise(r=>setTimeout(r,1000));assert.equal(record.calls,calls,'no requests while paused');
      await startHost();current.resumed=true;current.resume_response=await api(`/api/tasks/${t.id}/resume`,{});save();
    }
    await until(async()=>{const state=await db!.tasks().getTask(Number(t.id));if(state&&['failed','timeout'].includes(state.status))throw new Error(`unexpected task terminal: ${state.status}`);return state?.status==='done';},`${kind} natural completion`);
    await until(async()=>!(await db!.query('SELECT 1 FROM runtime_role_configs WHERE task_id=$1 AND finished_at IS NULL',[t.id])).rowCount,'runner disposal',20_000);
    const calls=record.calls;await new Promise(r=>setTimeout(r,5000));assert.equal(record.calls,calls,'no model calls after done');
    current.task=await api(`/api/tasks/${t.id}`);current.intents=await s.listByKind('intent');current.facts=(await s.listByKind('fact')).filter(n=>n.state==='confirmed');current.goals=await s.listByKind('goal');
    current.edges=(await db.query('SELECT * FROM exploration_edges WHERE exploration_id=$1 ORDER BY id',[t.exploration_id])).rows;
    current.anchors=(await db.query('SELECT a.* FROM exploration_anchors a JOIN exploration_nodes n ON n.id=a.node_id WHERE n.exploration_id=$1',[t.exploration_id])).rows;
    current.activity=(await db.query("SELECT id,node_id,worker,kind,tool,is_error,summary,detail,metadata,created_at FROM activity WHERE exploration_id=$1 AND kind NOT IN ('thinking','usage') ORDER BY id",[t.exploration_id])).rows;
    current.decisions=(await db.query('SELECT * FROM planner_decisions WHERE exploration_id=$1 ORDER BY id',[t.exploration_id])).rows;
    assert.equal(current.intents.length,2,'only two assigned stages');assert.ok(current.intents.every((n:any)=>n.state==='done'&&n.payload.execution_result?.outcome==='complete'));
    assert.equal(current.facts.length,2,'one distinct observation per stage');assert.ok(current.goals.length&&current.goals.every((n:any)=>n.state==='met'));
    for(const n of [...current.intents,...current.facts])assert.ok(current.anchors.some((a:any)=>Number(a.node_id)===n.id&&Number(a.asset_id)===asset),'both graphs remain anchored');
    const first=current.intents.toSorted((a:any,b:any)=>a.id-b.id)[0],second=current.intents.toSorted((a:any,b:any)=>a.id-b.id)[1];
    const firstFact=current.facts.find((n:any)=>n.payload.from_intent===first.id);
    assert.ok(current.edges.some((e:any)=>Number(e.src_id)===firstFact.id&&Number(e.dst_id)===second.id&&e.rel==='derived_from'),'Planner uses first-stage evidence');
    assert.ok(JSON.stringify(firstFact.payload).includes(samples.get(kind)!),'fact contains actual observed random token');
    for(const stage of ['sample','confirm'])assert.ok(record.fixture_requests.some((r:any)=>r.case===kind&&r.action===stage&&r.accepted),'actual Worker HTTP execution');
    const planners=record.runner_results.filter((r:any)=>r.task_id===Number(t.id)&&r.role==='planner');
    assert.ok(planners.length&&planners.at(-1).stopReason==='completed'&&!planners.at(-1).aborted,'final Planner naturally settles');
    current.remaining_leases=Number((await db.query('SELECT count(*) n FROM engine_task_leases WHERE task_id=$1',[t.id])).rows[0]!.n);
    current.remaining_slots=Number((await db.query('SELECT count(*) n FROM engine_worker_slots WHERE task_id=$1',[t.id])).rows[0]!.n);
    assert.equal(current.remaining_leases,0);assert.equal(current.remaining_slots,0);
    if(kind==='pause_restart'){
      const session=path.join(dir,'sessions',`exp${t.exploration_id}-worker-i${current.interrupted_intent}.jsonl`);
      current.session_after=JSON.parse(readFileSync(session,'utf8').split('\n')[0]!);assert.equal(current.session_after.id,current.session_before.id);
      assert.ok(current.resumed_context?.has_prior_fact&&current.resumed_context?.has_recovery);
      assert.equal(current.activity.filter((a:any)=>a.kind==='round'&&Number(a.node_id)===current.interrupted_intent).length,2,'same intent claimed again after restart');
    }
    current.status='passed';current.finished_at=new Date().toISOString();save();console.log(JSON.stringify({case:kind,status:'passed',task_id:t.id,calls:record.calls,db:name}));
  }
  record.status='passed';
}catch(e){record.status='failed';record.error=redact(e);}
finally{
  await engine?.shutdown().catch(e=>{record.shutdown_error=redact(e);});await app?.close();fixture.closeAllConnections();await new Promise<void>(resolve=>fixture.close(()=>resolve()));
  AgentRunner.prototype.prompt=originalPrompt;globalThis.fetch=originalFetch;
  if(db){
    record.audit=(await db.query('SELECT id,task_id,role,purpose,status,error,usage FROM llm_request_attempts ORDER BY id')).rows;
    record.activity=(await db.query("SELECT id,exploration_id,node_id,worker,kind,tool,is_error,summary,detail,metadata,created_at FROM activity WHERE kind NOT IN ('thinking','usage') ORDER BY id")).rows;
    record.nodes=(await db.query('SELECT * FROM exploration_nodes ORDER BY id')).rows;record.tasks=(await db.query('SELECT id,status,paused,completed_at FROM tasks ORDER BY id')).rows;
    record.tool_errors=record.activity.filter((a:any)=>a.is_error&&a.kind==='tool_result');
    record.usage=record.audit.reduce((sum:any,a:any)=>{for(const k of ['input','output','cacheRead','cacheWrite','totalTokens'])sum[k]=(sum[k]??0)+Number(a.usage?.[k]??0);return sum;},{});
    await db.query("UPDATE llm_profiles SET api_key=''");await db.query("UPDATE tasks SET paused=true WHERE status NOT IN ('done','failed','timeout')");await db.close();
  }
  record.finished_at=new Date().toISOString();record.supplement_used=ledger.requests.length;record.remaining=500-ledger.requests.length;record.cumulative_calls=ledger.baseline+ledger.requests.length;
  record.source_sha256=Object.fromEntries(['src/pi/runner.ts','src/agent/roles.ts','src/engine/engine.ts','src/engine/worker-outcome.ts'].map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')]));
  save();unlinkSync(lock);console.log(JSON.stringify({status:record.status,calls:record.calls,remaining:record.remaining,db:name,error:record.error}));
}
if(record.status!=='passed')process.exitCode=1;
