import pg from 'pg';import http from 'node:http';import {fork,type ChildProcess} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {Database,openDatabase} from '../src/db/index.js';import {postgresDSN} from '../src/config/index.js';import {resolveRolePrompt} from '../src/agent/prompts.js';import {signJWT} from '../src/http/auth.js';
const output=process.env.FATE_CRASH_OUTPUT!,ledgerPath=process.env.FATE_CRASH_LEDGER!;
assert.ok(output&&ledgerPath&&!existsSync(output),'fresh output required');
const ledger=JSON.parse(readFileSync(ledgerPath,'utf8'));assert.equal(ledger.allowance,500);assert.equal(ledger.baseline,72);
const lock=ledgerPath+'.lock';writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});
const runID=randomUUID(),name=`fate_crash_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-crash-'));
const record:any={run_id:runID,database:name,data_dir:dir,started_at:new Date().toISOString(),status:'running',initial_used:ledger.requests.length,calls:0,fixture_requests:[],processes:[],runners:[],external_target_requests:0};
mkdirSync(path.dirname(output),{recursive:true});mkdirSync(path.join(dir,'skills'));
const save=()=>writeFileSync(output,JSON.stringify(record,null,2)+'\n');const saveLedger=()=>writeFileSync(ledgerPath,JSON.stringify(ledger,null,2)+'\n');
const deadline=Date.now()+20*60_000,jwt=randomUUID(),token=signJWT(jwt),nonce=randomUUID();let fixtureBase='',db:Database|undefined,child:ChildProcess|undefined,base='',key='';
const redact=(e:unknown)=>String(e).split(key||'\0').join('[redacted]').replace(/(?:Bearer\s+|\bsk-)[\w.-]+/gi,'[redacted]');
const fixture=http.createServer((req,res)=>{const u=new URL(req.url!,fixtureBase),valid=req.method==='GET'&&(u.pathname==='/sample'||u.pathname==='/confirm'&&u.searchParams.get('token')===nonce);record.fixture_requests.push({at:new Date().toISOString(),path:u.pathname,method:req.method,accepted:valid});save();res.writeHead(valid?200:400,{'content-type':'application/json'});res.end(JSON.stringify(valid?(u.pathname==='/sample'?{fixture:'SYNTHETIC',sample:'ALPHA',values:[4,7,9],token:nonce}:{fixture:'SYNTHETIC',verified:true,total:20,token:nonce}):{error:'invalid request'}));});
async function until(fn:()=>Promise<any>,label:string,ms=480_000){const end=Math.min(deadline,Date.now()+ms);while(Date.now()<end){const v=await fn();if(v)return v;if(record.denied_requests)throw Error('shared model request budget exhausted');await new Promise(r=>setTimeout(r,100));}throw Error('timeout: '+label);}
async function api(route:string,body?:unknown){const r=await fetch(base+route,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30_000)});const v=await r.json();assert.ok(r.ok,`${route}: ${r.status}`);return v as any;}
async function start(generation:number){
 const proc=fork(path.resolve('scripts/crash-recovery-host.mts'),[],{execArgv:['--import','tsx'],env:{...process.env,SERIES_LOG_LEVEL:'silent',FATE_CRASH_HOST:JSON.stringify({generation,dir,jwt,fixture:fixtureBase})},stdio:['ignore','pipe','pipe','ipc']});child=proc;
 const info:any={pid:proc.pid,generation,started_at:new Date().toISOString()};record.processes.push(info);const requests=new Map<number,any>();
 proc.stdout?.on('data',()=>{});proc.stderr?.on('data',chunk=>{info.diagnostics=(String(info.diagnostics??'')+redact(String(chunk))).slice(-3000);});
 proc.on('message',(m:any)=>{
  if(m.type==='request'){
   const allowed=ledger.requests.length<ledger.allowance&&Date.now()<deadline;
   if(allowed){const req={number:ledger.requests.length+1,run_id:runID,at:new Date().toISOString(),...m};delete req.type;ledger.requests.push(req);requests.set(m.id,req);record.calls++;saveLedger();}
   else record.denied_requests=(record.denied_requests??0)+1;
   save();proc.send({type:'request_ack',id:m.id,allowed});
  }else if(m.type==='headers'||m.type==='request_error'){const req=requests.get(m.id);if(req){Object.assign(req,m.type==='headers'?{status:m.status}:{error:m.error});saveLedger();}}
  else if(m.type==='kill_ready'){record.kill_ready={...m,at:new Date().toISOString()};save();}
  else if(m.type==='runner'){record.runners.push({...m,pid:proc.pid,at:new Date().toISOString()});save();}
  else if(m.type==='ready'){info.base=m.base;info.ready_at=new Date().toISOString();save();}
 });
 proc.on('exit',(code,signal)=>{Object.assign(info,{exit_code:code,signal,exited_at:new Date().toISOString()});save();});
 await until(async()=>info.base,'child startup',30_000);base=info.base;return proc;
}
try{
 const source=new Database(new pg.Pool({connectionString:postgresDSN().dsn}));const profile=await source.platform().profileByID(453);
 const prompts=await Promise.all(['goals','planner','worker','mainagent'].map(async role=>({role,...await resolveRolePrompt(source,role)})));
 const configs=(await source.query("SELECT key,max_turns,run_seconds,wrapup_max_turns,wrapup_prompt FROM agents WHERE key IN ('goals','planner','worker','mainagent')")).rows;await source.close();
 assert.ok(profile?.apiKey&&profile.model==='deepseek-flash'&&new URL(profile.baseURL).hostname==='api.deepseek.com');key=profile.apiKey;
 process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}?sslmode=disable`;db=await openDatabase();
 const pid=await db.platform().saveProfile({...profile,id:undefined,name:'LOCAL SIGKILL acceptance',isDefault:true,poolExclude:true,proxy:'',streaming:true});
 for(const p of prompts){const agent=await db.platform().getAgentByKey(p.role);await db.platform().savePrompt(agent!.id,p.template,'isolated current prompt','acceptance');}
 for(const c of configs)await db.query('UPDATE agents SET max_turns=$2,run_seconds=$3,wrapup_max_turns=$4,wrapup_prompt=$5 WHERE key=$1',[c.key,c.max_turns,c.run_seconds,c.wrapup_max_turns,c.wrapup_prompt]);
 record.prompt_versions=prompts.map(({role,source,version})=>({role,source,version}));
 const safe=['set_goals','set_constraints','register_user_target','add_task_scope','add_intent','checkpoint_intent','record_fact','complete_intent','prove_goal','record_plan_decision','context_search','context_get','graph_overview','list_findings','list_assets','todo_write','http_request','traffic_body','read_tool_output','node_detail','list_facts','expand_index','expand_digest'];
 await db.query('UPDATE tools SET enabled=key=ANY($1::text[])',[safe]);await db.platform().setSetting('workers','1');
 await new Promise<void>(resolve=>fixture.listen(0,'127.0.0.1',resolve));fixtureBase=`http://127.0.0.1:${(fixture.address() as any).port}`;
 const asset=await db.assets().upsertHTTPService({url:fixtureBase+'/sample',pageTitle:'LOCAL synthetic crash recovery'});record.asset_id=asset;
 await start(1);
 const task=await api('/api/tasks',{name:`REAL-SIGKILL-${runID.slice(0,8)}`,goal:'完成两个串行意图：先读取样本并保存真实事实，再根据该事实 token 独立复核合计与 verified=true；均提交可验收结果，Planner 证明目标后自然结束。',description:`本地调度及进程恢复验收，没有漏洞目标。唯一授权资产 ID=${asset}，仅允许 GET ${fixtureBase}/sample 和 ${fixtureBase}/confirm?token=<sample返回值>。禁止其他网络、扫描、文件、命令或 MCP。\n第一阶段：Planner 下发一个读取 sample 的意图。Worker checkpoint_intent，http_request GET sample；把 sample、values、合计、token、traffic_id 保存为 observed 事实，再 complete_intent。第二阶段必须等第一意图 done 后，Planner 读取第一事实，以其为 parent 和 basis 下发一个独立复核意图。第二 Worker 读取该事实中的 token，GET confirm，核对 verified=true、total 与样本 values 合计一致，写一条 observed 事实并 complete_intent。\n总共两个意图、两条事实。每个意图只执行自己的阶段，事实和意图均锚定上述资产。不重复已经成功的请求。进程意外退出后使用已有事实、检查点、轨迹继续原意图的剩余验收，不新建代替意图、不重复执行。等两阶段完成后 prove_goal，自然结束。最终交付是两阶段核验的一个整体结果，不把操作步骤拆成额外目标。`,execution_mode:'managed',llm_profile_ids:[pid],asset_ids:[asset],coverage_enabled:false,timeout_seconds:600});
 record.task_id=Number(task.id);record.exploration_id=task.exploration_id;save();const s=db.exploration(task.exploration_id);
 await until(async()=>record.kill_ready,'fact saved and next provider response in-flight',240_000);
 const id=record.kill_ready.intent_id;record.before_kill_node=await s.getNode(id);record.before_kill_facts=await s.nodesByIDs(record.kill_ready.fact_ids);
 assert.equal(record.before_kill_node.state,'running');assert.ok(!record.before_kill_node.payload.execution_result);assert.ok(record.before_kill_facts.length);
 const session=path.join(dir,'sessions',`exp${task.exploration_id}-worker-i${id}.jsonl`);record.session_before=JSON.parse(readFileSync(session,'utf8').split('\n')[0]!);
 record.lease_before=(await db.query('SELECT * FROM engine_task_leases WHERE task_id=$1',[task.id])).rows[0];
 record.inflight_before=(await db.query("SELECT id,role FROM llm_request_attempts WHERE status='running' ORDER BY id")).rows;
 record.killed_at=new Date().toISOString();save();child!.kill('SIGKILL');await until(async()=>record.processes[0].signal==='SIGKILL','confirmed SIGKILL',10_000);
 assert.equal((await s.getNode(id))?.state,'running','SIGKILL must not run graceful cleanup');
 record.after_kill_node=await s.getNode(id);const oldPID=child!.pid;await start(2);assert.notEqual(child!.pid,oldPID);
 await until(async()=>{const rows=(await db!.query('SELECT * FROM engine_task_leases WHERE task_id=$1',[task.id])).rows;return rows[0]?.token!==record.lease_before.token&&rows[0];},'automatic new lease takeover',45_000);
 record.reclaimed_at=new Date().toISOString();record.lease_after=(await db.query('SELECT * FROM engine_task_leases WHERE task_id=$1',[task.id])).rows[0];save();
 await until(async()=>{const t=await db!.tasks().getTask(Number(task.id));if(t&&['failed','timeout'].includes(t.status))throw Error('unexpected task terminal '+t.status);return t?.status==='done';},'natural task completion');
 await until(async()=>!(await db!.query('SELECT 1 FROM engine_task_leases WHERE task_id=$1',[task.id])).rowCount,'leases drain',15_000);
 const calls=record.calls;await new Promise(r=>setTimeout(r,5000));assert.equal(record.calls,calls,'no post-completion requests');
 record.task=await api(`/api/tasks/${task.id}`);record.intents=await s.listByKind('intent');record.facts=(await s.listByKind('fact')).filter(n=>n.state==='confirmed');record.goals=await s.listByKind('goal');
 record.edges=(await db.query('SELECT * FROM exploration_edges WHERE exploration_id=$1 ORDER BY id',[task.exploration_id])).rows;
 record.anchors=(await db.query('SELECT a.* FROM exploration_anchors a JOIN exploration_nodes n ON n.id=a.node_id WHERE n.exploration_id=$1',[task.exploration_id])).rows;
 record.session_after=JSON.parse(readFileSync(session,'utf8').split('\n')[0]!);
 assert.equal(record.session_after.id,record.session_before.id);assert.equal(record.intents.length,2);assert.ok(record.intents.every((n:any)=>n.state==='done'&&n.payload.execution_result?.outcome==='complete'));
 assert.equal(record.facts.length,2);assert.ok(record.goals.length&&record.goals.every((n:any)=>n.state==='met'));
 for(const f of record.before_kill_facts)assert.equal(JSON.stringify(record.facts.find((n:any)=>n.id===f.id)?.payload),JSON.stringify(f.payload),'saved fact unchanged');
 for(const pathname of ['/sample','/confirm'])assert.equal(record.fixture_requests.filter((r:any)=>r.path===pathname&&r.accepted).length,1,'no duplicate target execution');
 assert.equal(record.fixture_requests.length,2);const second=record.intents.find((n:any)=>n.id!==id),firstFact=record.before_kill_facts[0];
 assert.ok(record.edges.some((e:any)=>Number(e.src_id)===firstFact.id&&Number(e.dst_id)===second.id&&e.rel==='derived_from'));
 for(const n of [...record.intents,...record.facts])assert.ok(record.anchors.some((a:any)=>Number(a.node_id)===n.id&&Number(a.asset_id)===asset));
 const resumed=ledger.requests.find((r:any)=>r.run_id===runID&&r.generation===2&&r.intent_id===id);assert.ok(resumed?.recovered_context?.has_prior_fact&&resumed.recovered_context.has_recovery);
 const planner=record.runners.filter((r:any)=>r.role==='planner').at(-1);assert.ok(planner?.stopReason==='completed'&&!planner.aborted);
 record.domain_chain_passed=true;
 record.orphan_requests=(await db.query("SELECT id,role,status FROM llm_request_attempts WHERE status='running'")).rows;
 record.orphan_runtimes=(await db.query('SELECT id,role,expires_at FROM runtime_role_configs WHERE finished_at IS NULL')).rows;
 save();assert.equal(record.orphan_requests.length,0,'no permanently running model audits after crash recovery');assert.equal(record.orphan_runtimes.length,0,'no orphaned runtime configurations');
 record.status='passed';
}catch(e){record.status='failed';record.error=redact(e);}
finally{
 if(child?.connected){child.send({type:'shutdown'});await until(async()=>child?.exitCode!==null||child?.signalCode!==null,'child cleanup',15_000).catch(()=>child?.kill('SIGKILL'));}
 fixture.closeAllConnections();await new Promise<void>(resolve=>fixture.close(()=>resolve()));
 if(db){record.audit=(await db.query('SELECT id,task_id,role,purpose,status,error,usage,created_at,finished_at FROM llm_request_attempts ORDER BY id')).rows;record.activity=(await db.query("SELECT id,node_id,worker,kind,tool,is_error,summary,detail,metadata,created_at FROM activity WHERE kind NOT IN ('thinking','usage') ORDER BY id")).rows;record.nodes=(await db.query('SELECT * FROM exploration_nodes ORDER BY id')).rows;record.tasks=(await db.query('SELECT id,status,paused,completed_at FROM tasks ORDER BY id')).rows;await db.query("UPDATE llm_profiles SET api_key=''");await db.query("UPDATE tasks SET paused=true WHERE status NOT IN ('done','failed','timeout')");await db.close();}
 record.finished_at=new Date().toISOString();record.used=ledger.requests.length;record.remaining=500-ledger.requests.length;record.usage=record.audit?.reduce((t:number,a:any)=>t+Number(a.usage?.totalTokens??0),0);
 record.source_sha256=Object.fromEntries(['src/engine/engine.ts','src/agent/roles.ts','src/pi/modelResolver.ts','src/engine/runtime-config.ts'].map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')]));save();unlinkSync(lock);console.log(JSON.stringify({status:record.status,calls:record.calls,remaining:record.remaining,database:name,domain_chain_passed:record.domain_chain_passed,error:record.error}));
}
if(record.status!=='passed')process.exitCode=1;
