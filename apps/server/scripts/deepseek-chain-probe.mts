// Explicit supplemental allowance: at most eight physical DeepSeek requests.
// Uses an isolated DB, actual Engine/pi loops, current role prompts, local evidence.
import pg from 'pg';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,existsSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {Database,openDatabase} from '../src/db/index.js';
import {Engine,defaultEngineConfig} from '../src/engine/engine.js';
import {makeModelResolver} from '../src/pi/modelResolver.js';
import {createTrackedRunner} from '../src/engine/runtime-config.js';
import {resolveRolePrompt,systemRolePrompt} from '../src/agent/prompts.js';
import {configureAgentEnv,workerSessionFile} from '../src/agent/roles.js';

const output=process.env.FATE_LIVE_CHAIN_OUTPUT!,sourceDSN=process.env.FATE_LIVE_PROFILE_DSN!;
if(!output||!sourceDSN||existsSync(output))throw new Error('new evidence path and runtime profile DSN required');
const source=new Database(new pg.Pool({connectionString:sourceDSN}));
const profile=await source.platform().profileByID(1);
const prompts=await Promise.all(['mainagent','worker','planner'].map(async role=>({role,...await resolveRolePrompt(source,role)})));
await source.close();
if(!profile?.apiKey||profile.model!=='deepseek-flash'||new URL(profile.baseURL).hostname!=='api.deepseek.com')throw new Error('approved profile unavailable');
const name=`fate_live_chain_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-live-chain-'));
process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}?sslmode=disable`;
process.env.SERIES_LOG_LEVEL='silent';
const db=await openDatabase(),realFetch=globalThis.fetch,deadline=Date.now()+15*60_000;
const record:any={status:'running',started_at:new Date().toISOString(),db:name,data_dir:dir,baseline_requests:64,allowance:8,calls:0,target_requests:0,requests:[],checks:{},prompts:prompts.map(p=>({role:p.role,source:p.source,version:p.version}))};
mkdirSync(path.dirname(output),{recursive:true});
const save=()=>writeFileSync(output,JSON.stringify(record,null,2)+'\n');save();
globalThis.fetch=async(input,init)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  if(url.protocol!=='https:'||url.hostname!=='api.deepseek.com')throw new Error('live probe forbids non-model network access');
  if(record.calls>=8||Date.now()>=deadline){record.denied_requests=(record.denied_requests??0)+1;save();throw new Error('supplemental physical request budget exhausted');}
  const body=typeof init?.body==='string'?JSON.parse(init.body):{};
  const names=(body.tools??[]).map((t:any)=>t.function.name);
  const role=names.includes('complete_intent')?'worker':names.includes('record_plan_decision')?'planner':names.includes('add_intent')?'mainagent':'compaction';
  const request:any={number:++record.calls,role,at:new Date().toISOString(),stream:body.stream===true,bytes:Buffer.byteLength(JSON.stringify(body)),tools:names};record.requests.push(request);save();
  const r=await realFetch(input,init);request.status=r.status;request.content_type=r.headers.get('content-type');save();return r;
};
let engine:Engine|undefined,runner:Awaited<ReturnType<typeof createTrackedRunner>>|undefined,task:any;
async function until(fn:()=>Promise<any>,label:string,ms=60_000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;if(record.denied_requests)throw new Error(`budget exhausted while waiting for ${label}`);await new Promise(r=>setTimeout(r,150));}throw new Error(`timeout: ${label}`);}
try{
  const pid=await db.platform().saveProfile({...profile,id:undefined,name:'LOCAL DeepSeek supplemental chain',isDefault:true,poolExclude:true,proxy:'',maxTokens:1400,streaming:true,retry:{connect:{attempts:-1,interval_ms:0},empty:{attempts:-1,interval_ms:0},stream:{attempts:-1,interval_ms:0}}});
  for(const p of prompts){const a=await db.platform().getAgentByKey(p.role);assert.ok(a);await db.platform().savePrompt(a.id,p.template,'copy current prompt for isolated live probe','probe');}
  const safe=['add_intent','dispatch_intents','checkpoint_intent','record_fact','complete_intent','prove_goal','record_plan_decision','context_search','context_get','graph_overview','list_findings','list_assets'];
  await db.query('UPDATE tools SET enabled=key=ANY($1::text[])',[safe]);
  // Physical HTTP allowance is authoritative. Keep the ordinary turn budget
  // above the expected transcript to avoid injecting a redundant wrap-up turn.
  await db.query("UPDATE agents SET max_turns=10,run_seconds=90,wrapup_max_turns=1");
  await db.platform().setSetting('workers','1');configureAgentEnv({skillsDir:path.join(dir,'skills')});mkdirSync(path.join(dir,'skills'));
  const asset=await db.assets().upsertHTTPService({url:'http://local-synthetic.invalid:9080/',pageTitle:'LOCAL fixture; no target request'});
  const goalText='仅验收本地合成证据：SYNTHETIC sample=ALPHA, check=PASS。保存一条明确标注合成数据的事实并完成一个意图即达标；不是漏洞验证，没有其他方向，无需派生工作。';
  task=await db.tasks().createTaskWithOptions('LOCAL DeepSeek supplemental chain',goalText,{executionMode:'manual',assetIDs:[asset],llmProfileIDs:[pid],coverageEnabled:false,timeoutSeconds:180});
  record.task_id=task.id;record.exploration_id=task.exploration_id;record.asset_id=asset;save();
  const s=db.exploration(task.exploration_id),goal=await s.addGoal({text:goalText},'user'),origin=await s.originFactID();
  await s.link(origin,'spawns',goal);
  await db.query("INSERT INTO task_constraints(exploration_id,kind,text,origin) VALUES($1,'deny','禁止网络、命令、文件或 MCP 执行；仅使用给定合成证据和内部写回工具。','user')",[task.exploration_id]);
  const resolver=makeModelResolver(db);engine=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:100},resolver,dir);
  const objective='仅处理给定本地合成文本 SYNTHETIC sample=ALPHA, check=PASS。第一次响应同时调用 checkpoint_intent 和 record_fact；事实 summary/evidence 明确标注合成资料而非真实测试。取得 fact_id 后调用 complete_intent，用该 fact_id 回答唯一 acceptance，随后简短结束。不得查询网络或其他方向。';
  const contract={objective,acceptance:['保存带 SYNTHETIC 标记的 ALPHA/PASS 事实，并在 complete_intent 引用此事实'],out_of_scope:['任何外部探测','任何额外意图'],allowed_tools:['checkpoint_intent','record_fact','complete_intent'],work:{resource:'local:synthetic-alpha',question_key:'check_pass',method_class:'fixture_review',identity:'alpha'}};
  record.main_reply=await engine.mainChat(task.id,`请直接用 add_intent 提交且只提交以下一个意图，不需要额外查询。工具返回后简短确认实际状态并结束，不等 Worker。参数：${JSON.stringify({intents:[{summary:'LOCAL 合成文本 ALPHA/PASS 核验',asset_ids:[asset],contract}]})}`);
  const intent=await until(async()=>(await s.listByKind('intent')).find(n=>n.state==='done'),'Worker accepted completion');
  const facts=(await s.listByKind('fact')).filter(n=>n.state==='confirmed');assert.equal(facts.length,1);assert.ok(String(facts[0]!.payload.evidence).includes('SYNTHETIC'));
  record.checks.worker={intent_id:intent.id,state:intent.state,result:intent.payload.execution_result,fact_id:facts[0]!.id};
  const beforePlanner=(await db.query("SELECT count(*) n FROM llm_request_attempts WHERE task_id=$1 AND role='planner'",[task.id])).rows[0];assert.equal(Number(beforePlanner.n),0);record.checks.manual_planner_calls=0;
  const pause=await engine.pause(task.id);assert.equal(pause.status,'paused');
  const session=workerSessionFile(dir,task.exploration_id,intent.id),model=await resolver(task.id,'worker');
  const options={...model,cwd:path.join(dir,'tasks',String(task.id)),agentDir:path.join(dir,'pi-agent'),resumeSessionPath:session,
    intentID:intent.id,systemPrompt:await systemRolePrompt(db,'worker'),toolAllowlist:[],customTools:[],maxTurns:2,maxWrapupTurns:0,compactionSettings:{keepRecentTokens:64},maxDurationMs:60000};
  runner=await createTrackedRunner(db,task.id,'worker',options);
  await runner.compact();record.checks.compaction=runner.compactionDiagnostics;await runner.dispose();runner=undefined;
  runner=await createTrackedRunner(db,task.id,'worker',options);
  const entries=readFileSync(session,'utf8').trim().split('\n').map(l=>JSON.parse(l)),checkpoint=entries.filter(e=>e.type==='compaction').at(-1)?.details?.checkpoint;
  assert.equal(checkpoint.intent.state,'done');assert.ok(checkpoint.intent.result);assert.ok(JSON.stringify(runner.messages).includes(`node:${intent.id}`));
  record.checks.restored={done:true,intent_ref:checkpoint.intent.ref,result:checkpoint.intent.result};await runner.dispose();runner=undefined;
  assert.ok(record.calls<=6,'reserve two calls for Planner');
  await db.query("UPDATE tasks SET execution_mode='managed' WHERE id=$1",[task.id]);await engine.resume(task.id);
  engine.notify(task.id,`用户验收指示：目标 #${goal} 的唯一验收条件已由意图 #${intent.id} 完成，证据事实 #${facts[0]!.id}。此本地合成任务 coverage_enabled=false、漏洞数为0符合预期。请在一次响应中调用 prove_goal 和 record_plan_decision（status=exhausted），随后简短结束，不派新意图。`);
  await until(async()=> (await db.tasks().getTask(task.id))?.status==='done','Planner goal completion');
  await engine.shutdown();engine=undefined;
  assert.equal((await s.listByKind('intent')).length,1);assert.equal((await s.getNode(goal))?.state,'met');
  record.checks.planner={task_done:true,goal_met:true,intent_count:1,decisions:(await db.query('SELECT decision FROM planner_decisions WHERE exploration_id=$1',[task.exploration_id])).rows};
  record.status='passed';
}catch(error){record.status='failed';record.error=String(error).split(profile.apiKey).join('[redacted]').replace(/sk-[\w.-]+/g,'[redacted]');}
finally{
  await runner?.dispose();await engine?.shutdown();globalThis.fetch=realFetch;
  if(task){
    record.audit=(await db.query('SELECT id,role,purpose,status,error,usage FROM llm_request_attempts WHERE task_id=$1 ORDER BY id',[task.id])).rows;
    record.activity=(await db.query('SELECT id,node_id,worker,kind,tool,is_error,summary,detail,created_at FROM activity WHERE exploration_id=$1 ORDER BY id',[task.exploration_id])).rows;
    record.nodes=(await db.query('SELECT * FROM exploration_nodes WHERE exploration_id=$1 ORDER BY id',[task.exploration_id])).rows;
    record.anchors=(await db.query('SELECT a.* FROM exploration_anchors a JOIN exploration_nodes n ON n.id=a.node_id WHERE n.exploration_id=$1',[task.exploration_id])).rows;
    record.edges=(await db.query('SELECT * FROM exploration_edges WHERE exploration_id=$1',[task.exploration_id])).rows;
    if(record.status==='passed'&&(record.audit.length!==record.calls||record.audit.some((a:any)=>a.status!=='completed')||record.activity.some((a:any)=>a.is_error))){record.status='failed';record.error='final audit or tool error check failed';}
  }
  await db.query("UPDATE llm_profiles SET api_key=''");await db.close();
  record.finished_at=new Date().toISOString();record.total_requests=64+record.calls;save();
  console.log(JSON.stringify({status:record.status,calls:record.calls,total:record.total_requests,db:name,task_id:task?.id,target_requests:0,error:record.error}));
}
if(record.status!=='passed')process.exitCode=1;
