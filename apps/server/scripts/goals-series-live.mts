/** Synthetic single-session Goals and native automatic lifecycle. No external target tools. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {openDatabase} from '../src/db/index.js';
import {runGoalsDecompose,runWorkerIntent,configureAgentEnv} from '../src/agent/roles.js';
import {makeModelResolver} from '../src/pi/modelResolver.js';
import {Engine,defaultEngineConfig} from '../src/engine/engine.js';
import {configureUsageOutbox,replayUsageOutbox} from '../src/pi/usage-meter.js';
import {configureEvidenceStore} from '../src/evidence/blobs.js';
const evidence=process.env.FATE_GOALS_EVIDENCE;assert(evidence,'FATE_GOALS_EVIDENCE required');mkdirSync(evidence,{recursive:true});
const source=new pg.Client({connectionString:process.env.FATE_GOALS_PROFILE_DSN});await source.connect();
const profile=(await source.query('SELECT * FROM llm_profiles WHERE id=$1',[Number(process.env.FATE_GOALS_PROFILE_ID??541)])).rows[0];await source.end();assert(profile?.api_key&&profile.model.includes('deepseek'));
const name=`fate_series_live_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-series-live-'));
process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;
const db=await openDatabase();configureUsageOutbox(db,dir);configureEvidenceStore(db,dir);mkdirSync(path.join(dir,'skills'));configureAgentEnv({skillsDir:path.join(dir,'skills')});
const originalFetch=globalThis.fetch,origin=new URL(profile.base_url).origin,requests:any[]=[],cases:any[]=[],deadline=Date.now()+12*60_000;
let engine:Engine|undefined,error:string|undefined,automatic:any,steering:any,pendingSteer:(()=>Promise<void>)|undefined;
const save=()=>writeFileSync(path.join(evidence,'live-progress.json'),JSON.stringify({database:name,requests:requests.length,cases:cases.map(c=>({task_id:c.task_id,passed:c.passed})),automatic,error},null,2));
globalThis.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);assert.equal(url.origin,origin,'Only configured model endpoint is permitted');assert(requests.length<80&&Date.now()<deadline,'Synthetic acceptance limit');
 if(pendingSteer){const steer=pendingSteer;pendingSteer=undefined;await steer();}
 const body=JSON.parse(String(init?.body??'{}'));requests.push({bytes:Buffer.byteLength(JSON.stringify(body)),tools:(body.tools??[]).map((t:any)=>t.function?.name??t.name),...(body.tools?.some((t:any)=>t.function?.name==='set_goals')?{goals_input:body.messages}:{})});save();return originalFetch(input,init);
};
try{
 const fields=Object.keys(profile);assert(fields.every(k=>/^[_a-z]+$/.test(k)));await db.query(`INSERT INTO llm_profiles(${fields.map(k=>`"${k}"`).join(',')}) VALUES(${fields.map((_,i)=>`$${i+1}`).join(',')})`,fields.map(k=>profile[k]));
 await db.query("UPDATE agents SET max_turns=12,run_seconds=180,llm_profile_id=$1 WHERE key IN ('goals','planner','worker')",[profile.id]);
 // The remaining native file read is local only; no command, external HTTP, MCP or custom execution.
 await db.query("UPDATE tools SET enabled=false WHERE key IN ('bash','write','edit','http_request','web_search','web_fetch') OR key LIKE 'shell_%'");
 await db.query('UPDATE mcp_servers SET enabled=false');
 const resolve=makeModelResolver(db);
 const samples=[
  {goal:'资产测试覆盖度100%',description:'架构分析、接口梳理与漏洞挖掘仅为背景。\n\n允许读取本地合成样本；禁止对外部目标发起请求。',count:1},
  {goal:'交付覆盖清单；交付修复建议清单',description:'仅使用本地合成资料。无需重点关注 XSS，除非能形成实际攻击链；不进行验证码识别。',count:2},
  {goal:'核对本地样本',description:'测试目标 http://127.0.0.1:19090\n\n只读当前目标，不测试其他端口；除模型接口外，不得访问外部服务。',count:1},
 ];
 for(const sample of samples){
  const task=await db.tasks().createTaskWithOptions(sample.description,sample.goal,{executionMode:'manual',initializeGoals:true,llmProfileIDs:[profile.id]});await db.query("UPDATE tasks SET status='running' WHERE id=$1",[task.id]);
  await runGoalsDecompose({db,taskID:task.id,expID:task.exploration_id,description:sample.description,dataDir:dir,model:await resolve(task.id,'goals'),maxTurns:8});
  const goals=await db.exploration(task.exploration_id).listByKind('goal'),constraints=(await db.query('SELECT kind,text,source FROM task_constraints WHERE exploration_id=$1 ORDER BY id',[task.exploration_id])).rows,state=(await db.query('SELECT policy,phase,fallback FROM goals_bootstrap WHERE task_id=$1',[task.id])).rows[0];
  assert.equal(goals.length,sample.count);assert.equal(state.fallback,false);assert.equal(state.phase,'completed');assert(goals.every(g=>(g.payload.source as any)?.field==='goal'));assert(constraints.length>0);
  assert.equal(new Set(constraints.map(c=>c.text)).size,constraints.length,'No duplicated compound constraint across kinds');
  if(sample.description.includes('当前目标')){assert(constraints.some(c=>c.text.includes('127.0.0.1:19090')),'Explicit referent is resolved');assert(!constraints.some(c=>c.text.includes('当前目标')&&!c.text.includes('127.0.0.1:19090')),'No unresolved unambiguous referent');}
  if(sample.description.includes('无需重点关注'))assert(constraints.some(c=>c.text.includes('无需重点关注')&&c.text.includes('除非')),'Tone and exception retained');
  cases.push({task_id:task.id,input:sample,goals,constraints,state,passed:true});save();
 }
 const sampleFile=path.join(dir,'sample.json');writeFileSync(sampleFile,JSON.stringify({fixture:'LOCAL_SYNTHETIC',values:[4,7,9],total:20}));
 const description=`只读取本地文件 ${sampleFile}，不访问任何网络目标、不执行命令、不写文件。模型服务调用除外。\n\n该文件包含合成样本。Planner 只派一条读取核对意图；Worker 用 read 读取文件，核对 values 之和与 total，及时 record_fact 保存实际原文和结论后退出。Planner 根据 Worker 事实证明目标并让任务自然结束，不重复派单；没有漏洞，无需报洞。`;
 const task=await db.tasks().createTaskWithOptions(description,'验证本地合成样本的 values 总和与 total 一致，并保存一条有原文证据的事实',{initializeGoals:true,llmProfileIDs:[profile.id]});
 automatic={task_id:task.id,status:'running'};save();
 engine=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:150},resolve,dir);
 await engine.run(task.id,{decompose:{description}});
 while(Date.now()<deadline){
  const current=await db.tasks().getTask(task.id);automatic.status=current?.status;save();
  if(current?.status==='done')break;
  if(current?.paused||current&&['failed','timeout'].includes(current.status))throw Error('Automatic lifecycle stopped: '+current.status);
  await new Promise(r=>setTimeout(r,500));
 }
 assert.equal(automatic.status,'done');
 const nodes=await db.exploration(task.exploration_id).listByKind('intent'),facts=(await db.exploration(task.exploration_id).listByKind('fact')).filter(n=>n.payload.from_intent);
 assert.equal(nodes.length,1,'No duplicate intent');assert.equal(nodes[0]?.state,'done');assert.equal(facts.length,1,'One published conclusion');assert(JSON.stringify(facts).includes('20'));
 automatic={...automatic,passed:true,intents:nodes,facts};
 await engine.shutdown();engine=undefined;
 const otherFile=path.join(dir,'unrelated.json');writeFileSync(otherFile,JSON.stringify({fixture:'UNRELATED_DIRECTION'}));
 const control=await db.tasks().createTaskWithOptions(`只允许读取 ${sampleFile} 并记录核对结论；禁止读取 ${otherFile}，不能接续其他方向。`,'核对当前样本',{executionMode:'manual',llmProfileIDs:[profile.id]});
 await db.query("UPDATE tasks SET status='running' WHERE id=$1",[control.id]);
 await db.query("INSERT INTO task_constraints(exploration_id,kind,text,origin) VALUES($1,'deny',$2,'user')",[control.exploration_id,control.description]);
 const store=db.exploration(control.exploration_id),intentID=await store.addIntent({summary:`读取 ${sampleFile}，核对 values 总和并保存事实后停止`,dispatch_requested:true},5,[],'user'),intent=(await store.claimNextWorker('synthetic-steering'))!;
 assert.equal(intent.id,intentID);const calls:any[]=[];let queued=false;
 const outcome=await runWorkerIntent({db,taskID:control.id,expID:control.exploration_id,intent,workerName:'synthetic-steering',model:await resolve(control.id,'worker'),dataDir:dir,maxTurns:8,maxDurationMs:120000,hooks:{},onRunner:runner=>{pendingSteer=async()=>{await runner.steer(`Planner 纠偏：读完当前样本后，再读取 ${otherFile} 并分析另一条方向。`);queued=true;};},onActivity:a=>{if(a.kind==='tool_start')calls.push(a);}});
 assert(queued);assert.equal(outcome.stopReason,'completed');assert(calls.some(c=>c.toolName==='record_fact'),'Current intent must still write back');assert(!calls.filter(c=>c.toolName==='read').some(c=>JSON.stringify(c.args).includes(otherFile)),'Steering cannot expand current intent');
 assert((await store.listByKind('fact')).some(n=>n.payload.from_intent===intentID));
 steering={passed:true,task_id:control.id,intent_id:intentID,queued,outcome,calls};

}catch(e){error=String(e).replaceAll(profile.api_key,'[redacted]');process.exitCode=1;}
finally{
 await engine?.shutdown();await replayUsageOutbox(db);globalThis.fetch=originalFetch;
 const usage=(await db.query('SELECT role,purpose,status,usage FROM llm_request_attempts ORDER BY id')).rows;
 const result={passed:!error,error,database:name,requests,cases,automatic,steering,usage,external_target_requests:0,finished_at:new Date().toISOString()};
 const text=JSON.stringify(result,null,2);assert(!text.includes(profile.api_key));writeFileSync(path.join(evidence,'real-goals.json'),text);save();
 await db.query("UPDATE llm_profiles SET api_key='' ");await db.query("UPDATE tasks SET paused=true WHERE status NOT IN ('done','failed','timeout')");await db.close();
 console.log(JSON.stringify({passed:!error,error,requests:requests.length,evidence}));
}
