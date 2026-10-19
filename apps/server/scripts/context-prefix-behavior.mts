/** Real model, isolated native role sessions, synthetic graph only. No target traffic. */
import {createServer} from 'node:http';import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import pg from 'pg';
import {Database,openDatabase} from '../src/db/index.js';import {buildModelSource} from '../src/pi/providerFromProfile.js';import {runWorkerIntent,runPlannerRound} from '../src/agent/roles.js';import {TodoStore} from '../src/tools/context.js';
if(process.env.FATE_PREFIX_LIVE!=='1'||!process.env.FATE_PREFIX_PROFILE_DSN)throw new Error('Explicit opt-in required');
const out=new URL('../../../docs/reviews/evidence/context-prefix-20261019/'+(process.env.FATE_PREFIX_BEHAVIOR_LEDGER||'deepseek-behavior.json'),import.meta.url);if(existsSync(out))throw new Error('Fresh ledger required');
const sourceDB=new Database(new pg.Pool({connectionString:process.env.FATE_PREFIX_PROFILE_DSN}));const profile=await sourceDB.platform().profileByID(Number(process.env.FATE_PREFIX_PROFILE_ID));await sourceDB.close();
if(!profile?.apiKey||new URL(profile.baseURL).hostname!=='api.deepseek.com')throw new Error('Configured provider unavailable');
const name=`fate_prefix_live_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-prefix-live-'));
const report:any={authorization:'2026-10-19 user removed DeepSeek testing cap',method:'Actual native Worker plus two fresh Planner rounds, isolated database and synthetic paged evidence; host harness applies done after natural Worker return',target_requests:0,request_count:0,requests:[],activities:[]};let phase='worker';
const save=()=>writeFileSync(out,JSON.stringify(report,null,2)+'\n');
const server=createServer(async(req,res)=>{
 const request:any={phase,started_at:new Date().toISOString(),status:'started'};report.requests.push(request);report.request_count++;save();
 try{
  if(report.request_count>24)throw new Error('Diagnostic batch limit reached');
  const parts=[];for await(const part of req)parts.push(part);const body=JSON.parse(Buffer.concat(parts).toString());
  body.model=profile.model;body.thinking={type:'disabled'};body.stream=false;delete body.stream_options;
  // The local relay hostname hides pi's DeepSeek compatibility detection.
  body.max_tokens=body.max_tokens??body.max_completion_tokens;delete body.max_completion_tokens;delete body.store;
  for(const message of body.messages)if(message.role==='developer')message.role='system';
  const url=new URL(profile.baseURL);url.pathname=url.pathname.replace(/\/$/,'')+'/chat/completions';
  const upstream=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${profile.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60_000)});
  if(!upstream.ok)throw new Error(`provider HTTP ${upstream.status}: ${(await upstream.text()).slice(0,400)}`);
  const data=await upstream.json() as any;request.usage=data.usage;request.status='completed';request.finished_at=new Date().toISOString();save();
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));
 }catch(error){request.status='error';request.error=String(error).replace(/sk-[\w-]+/g,'[redacted]');save();res.writeHead(502);res.end(JSON.stringify({error:{message:request.error}}));}
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;process.env.SERIES_LOG_LEVEL='silent';const db=await openDatabase();
try{
 await db.query("UPDATE agents SET max_turns=0,run_seconds=0 WHERE key IN ('planner','worker')");
 const model=await buildModelSource({...profile,apiKey:'local-only',baseURL:`http://127.0.0.1:${(server.address() as any).port}/v1`,proxy:'',streaming:false,maxTokens:1200});
 const goal='仅核对本地图谱合成资料里的最终标记，若已有完成意图及对应事实包含标记，则复用结果，不重复派单。不进行网络或文件探测。';
 const task=await db.tasks().createTaskWithOptions('LOCAL context retrieval acceptance',goal,{}),s=db.exploration(task.exploration_id);
 const goalID=await s.addNode('goal',{text:goal},0,'open','fixture',[]);
 const seed=await s.addNode('fact',{summary:'LOCAL synthetic source; read the complete detail field to find its final marker',detail:'LOCAL 合成证据，不对应任何外部目标。\n'.repeat(200)+'最终标记：FATE_LOCAL_73',evidence:'LOCAL fixture'},0,'confirmed','fixture',[]);
 const summary=`仅用 context_get 分页读取 node:${seed} 的 /payload/detail，核对全文末尾的最终标记，保存一条含标记的事实并总结；不进行其他探索。`;
 const id=await s.addIntent({summary,dispatch_requested:true,contract:{version:1,objective:summary,acceptance:['完整续读并记录最终标记'],out_of_scope:['网络访问','文件访问','其他意图'],basis:[{node_id:seed,version:0}],allowed_tools:['context_get','context_search']}},5,[],'user');
 const intent=(await s.claimNextWorker('local-worker'))!;
 const onActivity=(a:any)=>{if(['tool_start','tool_end','assistant_message_end'].includes(a.kind)){report.activities.push({phase,...a});save();}};
 const result=await runWorkerIntent({db,taskID:task.id,expID:task.exploration_id,workerName:'local-worker',intent,model,dataDir:dir,hooks:{},maxTurns:10,maxDurationMs:120000,onActivity});
 report.worker_result=result;
 const facts=(await s.listByKind('fact',100)).filter(n=>Number(n.payload.from_intent)===id);report.worker_facts=facts;
 if(result.stopReason!=='completed'||facts.length!==1||!JSON.stringify(facts).includes('FATE_LOCAL_73'))throw new Error('Worker failed actual evidence acceptance');
 await s.setIntentState(id,'done');
 for(let n=0;n<25;n++)await s.addNode('fact',{summary:`LOCAL unrelated observation ${n}`,evidence:'synthetic'},0,'confirmed','fixture',[]);
 for(let n=0;n<15;n++){const extra=await s.addIntent({summary:`LOCAL unrelated completed work ${n}`},5,[],'fixture');await s.setIntentState(extra,'done');}
 const before=(await s.listByKind('intent',100)).length;
 for(let n=0;n<2;n++){
  phase=`planner-${n}`;
  const result=await runPlannerRound({db,taskID:task.id,expID:task.exploration_id,goal,model,dataDir:dir,todos:new TodoStore(db),hooks:{},triggersText:'LOCAL 重新核对已有完成意图与最终标记，先检索；已有结果满足目标就复用，不创建新工作。',maxTurns:8,onActivity});
  report[phase]=result;
  if(result.stopReason!=='completed')throw new Error('Planner did not settle');
 }
 report.goal=await s.getNode(goalID);
 report.intent_count={before,after:(await s.listByKind('intent',100)).length};
 report.status=report.intent_count.before===report.intent_count.after&&['worker','planner-0','planner-1'].every(p=>report.activities.some((a:any)=>a.phase===p&&a.kind==='tool_start'&&['context_get','context_search'].includes(a.toolName)))?'passed':'failed';
 console.log(JSON.stringify({status:report.status,request_count:report.request_count,intents:report.intent_count,fact_count:facts.length}));if(report.status!=='passed')process.exitCode=1;
}catch(error){report.status='failed';report.error=String(error).replace(/sk-[\w-]+/g,'[redacted]');console.log(report.error);process.exitCode=1;}
finally{save();await db.close();await new Promise<void>(r=>server.close(()=>r()));const c=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await c.connect();await c.query(`DROP DATABASE ${name}`);await c.end();rmSync(dir,{recursive:true,force:true});}
