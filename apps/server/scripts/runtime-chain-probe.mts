// Local acceptance against an already-running, freshly built backend. The model
// endpoint is deterministic; reported token usage is synthetic, not provider cost.
import http from 'node:http';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import pg from 'pg';
import {Database} from '../src/db/index.js';
import {signJWT} from '../src/http/auth.js';

const base=process.env.FATE_PROBE_BASE??'http://127.0.0.1:18787';
if(new URL(base).hostname!=='127.0.0.1')throw new Error('acceptance backend must be local');
if(!process.env.FATE_PROBE_DSN||!process.env.FATE_PROBE_OUTPUT||!process.env.FATE_PROBE_DATA)throw new Error('missing probe configuration');
const output=process.env.FATE_PROBE_OUTPUT,data=process.env.FATE_PROBE_DATA;
const db=new Database(new pg.Pool({connectionString:process.env.FATE_PROBE_DSN}));
const token=signJWT(readFileSync('jwt.key','utf8').trim());
const stamp=Date.now().toString();
const record:any={started_at:new Date().toISOString(),kind:'deterministic HTTP integration',synthetic_usage:true,target_requests:0,requests:[],tasks:[],checks:[],errors:[]};
const save=()=>{mkdirSync(path.dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(record,null,2)+'\n');};
const api=async(url:string,body?:unknown)=>{
  const r=await fetch(base+url,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60_000)});
  const value=await r.json();if(!r.ok)throw new Error(`${url}: ${r.status} ${JSON.stringify(value)}`);return value as any;
};
async function until(fn:()=>Promise<any>,label:string,ms=30_000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,200));}throw new Error(`timeout: ${label}`);}
const tasks=new Map<string,any>(),steps=new Map<string,number>();
const calls=(name:string,args:unknown)=>({role:'assistant',content:null,tool_calls:[{id:`call_${stamp}_${record.requests.length}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const text=(content:string)=>({role:'assistant',content});
const contract=(phase:number)=>({objective:`LOCAL 合成资料阶段 ${phase}，不发起目标请求`,acceptance:[`保存合成资料阶段 ${phase} 的明确结论`],out_of_scope:['禁止网络探测及命令执行'],work:{resource:`local:runtime-${stamp}`,question_key:`phase_${phase}`,method_class:'synthetic_review',identity:'fixture'},allowed_tools:['checkpoint_intent','insert_assets','record_fact','context_search','context_get','complete_intent']});
const nodes=async(t:any)=>(await db.query('SELECT * FROM exploration_nodes WHERE exploration_id=$1 ORDER BY id',[t.exploration_id])).rows;
async function response(body:any){
  const names=(body.tools??[]).map((x:any)=>x.function.name);
  const isSummary=JSON.stringify(body.messages).includes('压缩安全测试平台会话')&&!names.length;
  const t=await until(async()=>tasks.get(body.model),'task registration',5000);
  const role=isSummary?'compaction':names.includes('complete_intent')?'worker':names.includes('record_plan_decision')?'planner':names.includes('add_intent')?'mainagent':'goals';
  const n=await nodes(t),intents=n.filter((x:any)=>x.kind==='intent'),facts=n.filter((x:any)=>x.kind==='fact'&&x.state==='confirmed');
  let answer:any,usage=500;
  const lastCall=body.messages.filter((m:any)=>m.role==='assistant').flatMap((m:any)=>m.tool_calls??[]).at(-1)?.function?.name;
  if(isSummary){
    answer=text('LOCAL 合成资料复验：仅执行当前意图和验收条件。已提交的进度及事实引用以宿主检查点为准。按原意图继续读取证据、提交 complete_intent 后停止；没有目标请求或真实漏洞。');
  }else if(role==='goals'){
    answer=lastCall==='set_goals'?text('合成验收目标已保存。'):calls('set_goals',{goals:[{text:'LOCAL 合成资料两阶段结论已保存并具备资产锚点，目标请求为零'}]});
  }else if(role==='planner'){
    const done=intents.filter((x:any)=>x.state==='done');
    if(lastCall==='record_plan_decision')answer=text('本轮规划已保存。');
    else if(['add_intent','prove_goal'].includes(lastCall))answer=calls('record_plan_decision',{status:lastCall==='add_intent'?'dispatched':'exhausted',reason:'依据本任务已提交的阶段事实推进',basis_ids:facts.map((f:any)=>Number(f.id)),resume_when:'新的 Worker 结果或用户输入'});
    else if(intents.length===0||done.length===1&&intents.length===1){
      const phase=intents.length+1,prev=facts.at(-1);
      answer=calls('add_intent',{intents:[{summary:`LOCAL 合成资料阶段 ${phase}`,asset_ids:[t.asset],priority:5,contract:contract(phase),...(prev?{parent_id:Number(prev.id)}:{})}]});
    }else if(done.length===2){
      const goal=n.find((x:any)=>x.kind==='goal'&&x.state==='open');
      answer=goal?calls('prove_goal',{goal_id:Number(goal.id),evidence_node_id:Number(facts.at(-1).id)}):calls('record_plan_decision',{status:'exhausted',reason:'两个阶段均已完成',basis_ids:[],resume_when:'用户追加目标'});
    }else answer=calls('record_plan_decision',{status:'waiting_dependency',reason:'当前意图尚未完成，避免重复下发',basis_ids:[],resume_when:'当前 Worker 完成'});
  }else if(role==='mainagent'){
    if(t.verifyFeedback)assert.ok(JSON.stringify(body.messages).includes('Worker 回传数据'),'Main receives original-session feedback');
    if(!intents.length)answer=calls('add_intent',{intents:[{summary:'LOCAL 手动合成资料验证',asset_ids:[t.asset],contract:contract(1)}]});
    else answer=text('意图已提交；Worker 状态以宿主返回为准。');
  }else{
    const intent=intents.find((x:any)=>x.state==='running')??intents.at(-1);
    assert.ok(intent,'worker must have assigned intent');
    const key=String(intent.id),step=steps.get(key)??0;steps.set(key,step+1);
    const fact=facts.find((f:any)=>Number(f.payload.from_intent)===Number(intent.id));
    if(step===0){answer=calls('checkpoint_intent',{phase:'investigating',summary:'已领取当前意图，准备核验本地合成资料',attempted:[],next_step:'写回合成结论'});usage=40_000;}
    else if(step===1)answer=calls('insert_assets',{items:[{type:'service',url:t.url,page_title:'LOCAL synthetic acceptance fixture',status_code:200}]});
    else if(step===2){answer=calls('record_fact',{summary:`LOCAL 合成资料核验完成：意图 ${intent.id}`,evidence:`SYNTHETIC FIXTURE ONLY: intent=${intent.id}; observation=fixture-ok; no target requests`,detail:'该记录来自确定性验收模型，不代表真实目标漏洞。',confidence:'high',observation_type:'observed',asset_ids:[t.asset]});usage=40_000;}
    else if(step===3){
      assert.ok(fact,'fact persisted before detail retrieval');
      if(t.execution_mode==='manual'&&!t.pauseInjected){
        t.pauseInjected=true;t.pauseReady=true;steps.set(key,3);
        await until(async()=>t.resumeRequested,'resume held model response',20_000);
      }else if(t.execution_mode==='manual'&&t.resumeRequested){
        assert.ok(JSON.stringify(body.messages).includes(`node:${fact.id}`),'resumed context retains fact reference after compaction');
        t.restoredFact=true;
      }
      answer=calls('context_get',{ref:`node:${fact.id}`});
    }
    else if(step===4){assert.ok(fact);answer=calls('complete_intent',{outcome:'complete',summary:'LOCAL 当前意图完成，未探索其他方向',criteria:[{index:0,outcome:'supported',fact_ids:[Number(fact.id)]}]});}
    else answer=text('当前意图结果已提交，停止。');
  }
  // pi estimates its persisted projection before each request. Supply real local
  // transcript volume as well as fake usage; usage alone is not a size fixture.
  if(role==='worker'&&usage===40_000)answer.content='LOCAL synthetic padding, no additional observations. '.repeat(3500);
  record.requests.push({at:new Date().toISOString(),task_id:t.id,role,tool:answer.tool_calls?.[0]?.function.name??null,bytes:Buffer.byteLength(JSON.stringify(body)),synthetic_input_tokens:usage,tools:names});save();
  return {id:`chatcmpl-${stamp}-${record.requests.length}`,object:'chat.completion',created:Math.floor(Date.now()/1000),model:body.model,choices:[{index:0,message:answer,finish_reason:answer.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:usage,completion_tokens:50,total_tokens:usage+50}};
}
const server=http.createServer(async(req,res)=>{
  try{let raw='';for await(const c of req)raw+=c;
    if(req.url?.endsWith('/chat/completions')){const answer=await response(JSON.parse(raw));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(answer));}
    else{res.writeHead(404);res.end();}
  }catch(e){record.errors.push(String(e));save();res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:String(e)}}));}
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const port=(server.address() as any).port;
try{
  record.health=await api('/api/health');
  record.previous_tasks=(await db.query('SELECT id,status,paused,queued FROM tasks ORDER BY id')).rows;
  for(const mode of ['managed','manual']){
    const model=`local-${mode}-${stamp}`,url=`http://runtime-${mode}-${stamp}.invalid:9080/`;
    const asset=await db.assets().upsertHTTPService({url,pageTitle:'LOCAL synthetic fixture'});
    const profile=await api('/api/llm/profiles',{name:`LOCAL runtime probe ${mode} ${stamp}`,format:'openai',base_url:`http://127.0.0.1:${port}/v1`,model,api_key:'local-fixture-only',pool_exclude:true,context_window_k:48,max_tokens:2048,streaming:false,retry:{connect:{attempts:-1,interval_ms:0},empty:{attempts:-1,interval_ms:0},stream:{attempts:-1,interval_ms:0}}});
    const t=await api('/api/tasks',{name:`LOCAL-RECHECK-${mode}-${stamp}`,description:'LOCAL 本地合成资料验收。禁止访问任何目标网络，仅校验内部工具、任务调度和事实记录。',goal:'LOCAL 两阶段合成结论和双图引用完整',execution_mode:mode,llm_profile_ids:[Number(profile.id)],asset_ids:[asset],coverage_enabled:false,timeout_seconds:180,plan_heartbeat_seconds:60});
    Object.assign(t,{asset,url,execution_mode:mode,profile_id:Number(profile.id)});tasks.set(model,t);record.tasks.push(t);save();
    if(mode==='manual'){
      const main=await api(`/api/tasks/${t.id}/chat`,{message:'请下发一个 LOCAL 手动合成资料意图，Worker 只保存合成结论，不发起网络请求。'});record.main_reply=main;
      await until(async()=>t.pauseReady,'Worker reached post-fact compressed checkpoint');
      const pauseStart=Date.now();
      const paused=await api(`/api/tasks/${t.id}/pause`,{});
      record.inflight_pause={...paused,latency_ms:Date.now()-pauseStart};
      assert.equal(paused.paused,true);assert.ok(record.inflight_pause.latency_ms<10_000);
      const pausedNodes=await nodes(t);
      assert.equal(pausedNodes.filter(n=>n.kind==='fact'&&n.state==='confirmed').length,1);
      assert.equal(pausedNodes.filter(n=>n.kind==='intent'&&n.state==='done').length,0);
      t.resumeRequested=true;record.resume=await api(`/api/tasks/${t.id}/resume`,{});
      await until(async()=>(await nodes(t)).some(n=>n.kind==='intent'&&n.state==='done'),'manual Worker completion');
      assert.equal(t.restoredFact,true);
      await until(async()=>(await db.query('SELECT 1 FROM worker_feedback_delivery WHERE task_id=$1 AND published',[t.id])).rowCount,'durable feedback publication');
      record.pause=await api(`/api/tasks/${t.id}/pause`,{});
      t.verifyFeedback=true;
      await api(`/api/tasks/${t.id}/chat`,{message:'仅核对已回传的 Worker 结果，不下发新意图。'});
      await api(`/api/tasks/${t.id}/chat`,{message:'再次核对同一结果，不重复下发。'});
      const entries=readFileSync(path.join(data,'sessions',`exp${t.exploration_id}-main.jsonl`),'utf8').trim().split('\n').map(l=>JSON.parse(l));
      const keys=entries.filter(e=>e.type==='custom_message'&&e.customType==='fate_context'&&e.details?.key?.startsWith('worker-feedback:')).map(e=>e.details.key);
      const deliveries=(await db.query('SELECT activity_id FROM worker_feedback_delivery WHERE task_id=$1',[t.id])).rows;
      assert.deepEqual([...new Set(keys)].sort(),deliveries.map(d=>`worker-feedback:${d.activity_id}`).sort());
      assert.equal(keys.length,new Set(keys).size,'feedback must not be injected twice');
      record.feedback_keys=keys;
    }else await until(async()=>{const latest=await api(`/api/tasks/${t.id}`);return latest.status==='done';},'managed task done',60_000);
    const finalNodes=await nodes(t);
    const anchors=(await db.query('SELECT a.* FROM exploration_anchors a JOIN exploration_nodes n ON n.id=a.node_id WHERE n.exploration_id=$1',[t.exploration_id])).rows;
    const graph=await api(`/api/exploration/${t.exploration_id}/nodes`),edges=await api(`/api/exploration/${t.exploration_id}/edges`),assets=await api(`/api/assets?task_id=${t.id}`);
    const audit=(await db.query('SELECT id,role,purpose,status,usage,error FROM llm_request_attempts WHERE task_id=$1 ORDER BY id',[t.id])).rows;
    const acts=(await db.query('SELECT id,node_id,worker,kind,tool,is_error,summary,created_at FROM activity WHERE exploration_id=$1 ORDER BY id',[t.exploration_id])).rows;
    const decisions=(await db.query('SELECT * FROM planner_decisions WHERE exploration_id=$1 ORDER BY created_at',[t.exploration_id])).rows;
    const done=finalNodes.filter(n=>n.kind==='intent'&&n.state==='done');
    assert.equal(done.length,mode==='managed'?2:1);
    assert.equal(finalNodes.filter(n=>n.kind==='fact'&&n.state==='confirmed').length,done.length);
    assert.ok(done.every(n=>n.payload.execution_result?.outcome==='complete'&&n.payload.progress));
    assert.ok(anchors.length>=done.length*2);
    assert.ok(edges.items.some((e:any)=>e.rel==='yields'));
    assert.ok(assets.assets.some((a:any)=>Number(a.id)===asset&&a.tested));
    assert.ok(audit.every(a=>a.status==='completed'||mode==='manual'&&a.status==='aborted'));
    assert.equal(acts.filter(a=>a.is_error).length,0,'all internal tools must succeed');
    assert.ok(audit.filter(a=>a.purpose==='compaction').length>=done.length);
    if(mode==='manual')assert.equal(audit.filter(a=>a.role==='planner').length,0);
    else{assert.ok(decisions.length>=2);assert.ok(edges.items.some((e:any)=>e.rel==='proves'));}
    record.checks.push({mode,task_id:t.id,nodes:finalNodes,anchors,edges,assets,graph,audit,activity:acts,decisions});save();
  }
  record.status='passed';
}catch(error){record.status='failed';record.error=String(error);}
finally{
  for(const t of record.tasks){try{const latest=await api(`/api/tasks/${t.id}`);if(latest.status==='running'&&!latest.paused)await api(`/api/tasks/${t.id}/pause`,{});}catch(e){record.errors.push(String(e));}}
  record.sessions=[];
  for(const t of record.tasks){
    for(const f of readdirSync(path.join(data,'sessions')).filter(f=>f.startsWith(`exp${t.exploration_id}-`))){
      const file=path.join(data,'sessions',f),entries=readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
      record.sessions.push({file,compactions:entries.filter(e=>e.type==='compaction')});
    }
  }
  record.finished_at=new Date().toISOString();save();await new Promise<void>(r=>server.close(()=>r()));await db.close();
}
console.log(JSON.stringify({status:record.status,task_ids:record.tasks.map((t:any)=>t.id),requests:record.requests.length,compactions:record.requests.filter((r:any)=>r.role==='compaction').length,error:record.error}));
if(record.status!=='passed')process.exitCode=1;
