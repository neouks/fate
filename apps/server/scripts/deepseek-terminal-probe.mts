// Real provider acceptance. All attempts/reruns share one durable physical-request
// allowance; only local synthetic evidence is available to the agents.
import pg from 'pg';
import {existsSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {Database,openDatabase} from '../src/db/index.js';
import {Engine,defaultEngineConfig} from '../src/engine/engine.js';
import {makeModelResolver} from '../src/pi/modelResolver.js';
import {resolveRolePrompt} from '../src/agent/prompts.js';
import {configureAgentEnv} from '../src/agent/roles.js';
import {AgentRunner} from '../src/pi/runner.js';
import {buildApp} from '../src/http/app.js';
import {signJWT} from '../src/http/auth.js';

const output=process.env.FATE_TERMINAL_OUTPUT!,ledgerPath=process.env.FATE_TERMINAL_LEDGER!,sourceDSN=process.env.FATE_LIVE_PROFILE_DSN!;
if(!output||!ledgerPath||!sourceDSN||existsSync(output))throw new Error('fresh output, shared ledger and runtime profile DSN required');
mkdirSync(path.dirname(ledgerPath),{recursive:true});mkdirSync(path.dirname(output),{recursive:true});
const lock=ledgerPath+'.lock';writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});
if(!existsSync(ledgerPath))writeFileSync(ledgerPath,JSON.stringify({baseline:72,allowance:500,requests:[]},null,2)+'\n',{flag:'wx'});
const ledger=JSON.parse(readFileSync(ledgerPath,'utf8'));
assert.equal(ledger.baseline,72);assert.equal(ledger.allowance,500);
const runID=randomUUID(),dir=mkdtempSync(path.join(tmpdir(),'fate-terminal-')),name=`fate_terminal_${process.pid}`;
const record:any={run_id:runID,started_at:new Date().toISOString(),status:'running',db:name,data_dir:dir,target_requests:0,calls:0,cases:[],runner_results:[]};
const save=()=>writeFileSync(output,JSON.stringify(record,null,2)+'\n');
const saveLedger=()=>writeFileSync(ledgerPath,JSON.stringify(ledger,null,2)+'\n');
const realFetch=globalThis.fetch,originalPrompt=AgentRunner.prototype.prompt,deadline=Date.now()+20*60_000;
let engine:Engine|undefined,app:ReturnType<typeof buildApp>|undefined,db:Database|undefined,key='';
const redact=(v:unknown)=>String(v).split(key||'\0').join('[redacted]').replace(/sk-[\w.-]+/g,'[redacted]');
async function until(fn:()=>Promise<any>,label:string,ms=240_000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;if(record.denied_requests)throw new Error(`request budget exhausted: ${label}`);await new Promise(r=>setTimeout(r,200));}throw new Error(`timeout: ${label}`);}
try {
  const source=new Database(new pg.Pool({connectionString:sourceDSN}));
  const profile=await source.platform().profileByID(1);
  const prompts=await Promise.all(['goals','planner','worker','mainagent'].map(async role=>({role,...await resolveRolePrompt(source,role)})));
  await source.close();
  if(!profile?.apiKey||profile.model!=='deepseek-flash'||new URL(profile.baseURL).hostname!=='api.deepseek.com')throw new Error('approved profile unavailable');
  key=profile.apiKey;
  process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}?sslmode=disable`;
  process.env.SERIES_LOG_LEVEL='silent';db=await openDatabase();
  globalThis.fetch=async(input,init)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    if(url.protocol!=='https:'||url.hostname!=='api.deepseek.com')throw new Error('probe forbids non-model outbound network');
    if(ledger.requests.length>=ledger.allowance||record.calls>=120||Date.now()>=deadline){record.denied_requests=(record.denied_requests??0)+1;save();throw new Error('physical request limit reached');}
    const body=typeof init?.body==='string'?JSON.parse(init.body):{},names=(body.tools??[]).map((t:any)=>t.function.name);
    const role=names.includes('complete_intent')?'worker':names.includes('record_plan_decision')?'planner':names.includes('add_intent')?'mainagent':names.includes('set_goals')?'goals':'compaction';
    const request:any={number:ledger.requests.length+1,run_id:runID,role,at:new Date().toISOString(),bytes:Buffer.byteLength(JSON.stringify(body)),tools:names};
    ledger.requests.push(request);record.calls++;saveLedger();save();
    try{const response=await realFetch(input,init);request.status=response.status;saveLedger();return response;}
    catch(e){request.error=redact(e);saveLedger();throw e;}
  };
  AgentRunner.prototype.prompt=async function(...args:Parameters<typeof originalPrompt>){
    const platform=(this as any).opts.platform,started=new Date().toISOString();
    try{const result=await originalPrompt.apply(this,args);record.runner_results.push({role:platform?.role,task_id:platform?.taskID,started_at:started,finished_at:new Date().toISOString(),...result});save();return result;}
    catch(e){record.runner_results.push({role:platform?.role,task_id:platform?.taskID,started_at:started,error:redact(e)});save();throw e;}
  };
  const pid=await db.platform().saveProfile({...profile,id:undefined,name:'LOCAL natural completion acceptance',isDefault:true,poolExclude:true,proxy:'',maxTokens:2200,streaming:true,retry:{connect:{attempts:-1,interval_ms:0},empty:{attempts:-1,interval_ms:0},stream:{attempts:-1,interval_ms:0}}});
  for(const p of prompts){const a=await db.platform().getAgentByKey(p.role);assert.ok(a);await db.platform().savePrompt(a.id,p.template,'copy current prompt for isolated terminal acceptance','probe');}
  record.prompts=prompts.map(p=>({role:p.role,source:p.source,version:p.version}));
  const safe=['set_goals','set_constraints','add_intent','dispatch_intents','checkpoint_intent','record_fact','complete_intent','prove_goal','record_plan_decision','context_search','context_get','graph_overview','list_findings','list_assets','todo_write'];
  await db.query('UPDATE tools SET enabled=key=ANY($1::text[])',[safe]);
  await db.query('UPDATE agents SET max_turns=20,run_seconds=180,wrapup_max_turns=1');
  await db.platform().setSetting('workers','1');
  const skills=path.join(dir,'skills');mkdirSync(skills);configureAgentEnv({skillsDir:skills});
  engine=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:100,plannerMaxTurns:20},makeModelResolver(db),dir);
  const jwtKey=randomUUID();app=buildApp({version:'terminal-acceptance',startedAt:Date.now(),db,engine,jwtKey,skillsRoot:skills,dataDir:dir});
  const base=await app.listen({host:'127.0.0.1',port:0}),token=signJWT(jwtKey);engine.startScheduler();
  const api=async(url:string,body?:unknown,method=body===undefined?'GET':'POST')=>{
    const response=await realFetch(base+url,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(180_000)});
    const value=await response.json();assert.ok(response.ok,`${url}: ${response.status} ${JSON.stringify(value)}`);return value as any;
  };
  const selected=(process.env.FATE_TERMINAL_CASES??'single,serial,manual').split(',');
  for(const kind of selected){
    const asset=await db.assets().upsertHTTPService({url:`http://synthetic-${kind}.invalid:9080/`,pageTitle:'SYNTHETIC fixture, not a real target'});
    const goal=kind==='serial'?'保存 ALPHA/PASS 合成资料的核验结论，再由独立复核意图引用第一条事实验证其字段，交付两条关联事实和明确复核结论。':'保存一条明确标注 SYNTHETIC 的 ALPHA/PASS 合成资料核验事实，完成该意图即可验收。';
    const description=`这是平台调度验收，不是渗透任务。唯一资料：SYNTHETIC sample=ALPHA, check=PASS。合成资料归属本任务的合成资产 #${asset}；所有意图及事实须通过 asset_ids 关联此资产，以验收双图锚点。这只是资料归属，不授权任何目标操作。禁止任何网络、命令、文件和 MCP 执行。仅使用内部黑板和写回工具；没有漏洞目标，没有其他探索方向。${goal} ${kind==='serial'?'先派核验意图；第一意图完成后，以其事实为父节点，再派一次独立复核意图。两阶段串行执行，不能合并或重复下发。':'只需一个意图，不派生其他工作。'} 不允许把用户原文当作已完成的 Worker 结果；等待 Worker 提交验收结果后，Planner 根据其事实证明目标。`;
    const started=Date.now(),t=await api('/api/tasks',{name:`LOCAL-TERMINAL-${kind}-${runID.slice(0,8)}`,description,goal,execution_mode:kind==='manual'?'manual':'managed',llm_profile_ids:[pid],asset_ids:[asset],coverage_enabled:false,timeout_seconds:300,plan_heartbeat_seconds:30});
    const item:any={kind,task_id:Number(t.id),exploration_id:t.exploration_id,asset_id:asset,started_at:new Date(started).toISOString(),status:'running'};record.cases.push(item);save();
    const s=db.exploration(t.exploration_id);
    if(kind==='manual'){
      await api(`/api/tasks/${t.id}/chat`,{message:'请为本任务下发唯一的合成资料核验意图，遵守任务的范围及验收条件，实际结果由 Worker 写回。'});
      await until(async()=>(await s.listByKind('intent')).some(n=>n.state==='done'),'manual Worker completion');
      assert.equal(Number((await db.query("SELECT count(*) n FROM llm_request_attempts WHERE task_id=$1 AND role='planner'",[t.id])).rows[0]!.n),0);
      item.manual_planner_calls=0;await api(`/api/tasks/${t.id}/execution-mode`,{execution_mode:'managed'},'PATCH');
    }
    await until(async()=>{const task=await db!.tasks().getTask(Number(t.id));if(task&&['failed','timeout'].includes(task.status))throw new Error(`${kind}: unexpected terminal ${task.status}`);return task?.status==='done';},`${kind} natural task completion`);
    await until(async()=>Number((await db!.query('SELECT count(*) n FROM runtime_role_configs WHERE task_id=$1 AND finished_at IS NULL',[t.id])).rows[0]!.n)===0,'runners disposed',15_000);
    const before=record.calls;await new Promise(r=>setTimeout(r,10_000));assert.equal(record.calls,before,'no requests after task termination');
    const intents=await s.listByKind('intent'),facts=(await s.listByKind('fact')).filter(n=>n.state==='confirmed'),goals=await s.listByKind('goal');
    assert.equal(intents.length,kind==='serial'?2:1,'no duplicate or extra intents');assert.ok(intents.every(n=>n.state==='done'),'all intended work accepted');
    assert.ok(goals.length>0&&goals.every(n=>n.state==='met'));assert.equal(facts.length,kind==='serial'?2:1);
    const planners=record.runner_results.filter((r:any)=>r.task_id===Number(t.id)&&r.role==='planner');
    assert.ok(planners.length&&planners.at(-1).stopReason==='completed'&&!planners.at(-1).aborted,'Planner finishes naturally');
    item.status='passed';item.elapsed_ms=Date.now()-started;item.task=await api(`/api/tasks/${t.id}`);item.intents=intents;item.facts=facts;item.goals=goals;
    item.edges=(await db.query('SELECT * FROM exploration_edges WHERE exploration_id=$1',[t.exploration_id])).rows;
    item.anchors=(await db.query('SELECT a.* FROM exploration_anchors a JOIN exploration_nodes n ON n.id=a.node_id WHERE n.exploration_id=$1',[t.exploration_id])).rows;
    for(const n of [...intents,...facts])assert.ok(item.anchors.some((a:any)=>Number(a.node_id)===n.id&&Number(a.asset_id)===asset),'dual graph anchor preserved');
    if(kind==='serial'){const second=intents.sort((a,b)=>a.id-b.id)[1]!;const firstFact=facts.sort((a,b)=>a.id-b.id)[0]!;assert.ok(item.edges.some((e:any)=>Number(e.src_id)===firstFact.id&&Number(e.dst_id)===second.id),'serial intent uses first fact');}
    item.quiet_after_done_ms=10_000;save();console.log(JSON.stringify({case:kind,status:item.status,calls:record.calls,elapsed_ms:item.elapsed_ms}));
    item.remaining_leases=Number((await db.query('SELECT count(*) n FROM engine_task_leases WHERE task_id=$1',[t.id])).rows[0]!.n);
    item.remaining_worker_slots=Number((await db.query('SELECT count(*) n FROM engine_worker_slots WHERE task_id=$1',[t.id])).rows[0]!.n);
    assert.equal(item.remaining_leases,0);assert.equal(item.remaining_worker_slots,0);
    if(kind==='manual'){
      item.feedback=(await db.query("SELECT a.metadata,d.published FROM activity a JOIN worker_feedback_delivery d ON d.activity_id=a.id WHERE d.task_id=$1 AND a.metadata->'worker_feedback'->>'state'='done'",[t.id])).rows;
      assert.equal(item.feedback.length,1);assert.equal(item.feedback[0].published,true);
    }
    save();
  }
  record.status='passed';
}catch(e){record.status='failed';record.error=redact(e);}
finally{
  await engine?.shutdown();await app?.close();AgentRunner.prototype.prompt=originalPrompt;globalThis.fetch=realFetch;
  if(db){
    record.audit=(await db.query('SELECT id,task_id,role,purpose,status,error,usage FROM llm_request_attempts ORDER BY id')).rows;
    record.activity=(await db.query('SELECT id,exploration_id,node_id,worker,kind,tool,is_error,summary,detail,created_at FROM activity ORDER BY id')).rows;
    record.nodes=(await db.query('SELECT * FROM exploration_nodes ORDER BY id')).rows;
    record.tasks=(await db.query('SELECT id,status,paused,completed_at FROM tasks ORDER BY id')).rows;
    record.planner_decisions=(await db.query('SELECT * FROM planner_decisions ORDER BY id')).rows;
    record.guard_rejections=record.activity.filter((a:any)=>a.is_error&&a.kind==='tool_result'&&/节点版本已变化|依据 #\d+ 已变化或不再授权|节点 #\d+ 不存在或不属于本任务及直接来源任务|Worker 尚未提交最终验收结果/.test(a.detail??''));
    const unexpected=record.activity.filter((a:any)=>a.is_error&&!record.guard_rejections.includes(a));
    if(record.status==='passed'&&(record.audit.length!==record.calls||record.audit.some((a:any)=>a.status!=='completed')||unexpected.length)){record.status='failed';record.error='audit or unexpected tool errors require review';}
    await db.query("UPDATE llm_profiles SET api_key=''");
    await db.query("UPDATE tasks SET paused=true WHERE status NOT IN ('done','failed','timeout')");await db.close();
  }
  record.finished_at=new Date().toISOString();record.supplement_used=ledger.requests.length;record.cumulative_calls=ledger.baseline+ledger.requests.length;save();unlinkSync(lock);
  console.log(JSON.stringify({status:record.status,calls:record.calls,supplement_used:ledger.requests.length,remaining:500-ledger.requests.length,db:name,error:record.error}));
}
if(record.status!=='passed')process.exitCode=1;
