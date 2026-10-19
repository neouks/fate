// Real provider and public MCP acceptance. Isolated data, no model/run quotas.
import pg from 'pg';import path from 'node:path';import {randomUUID} from 'node:crypto';import {mkdirSync,writeFileSync} from 'node:fs';
import {Database,openDatabase} from '../src/db/index.js';import {postgresDSN} from '../src/config/index.js';import {Engine,defaultEngineConfig} from '../src/engine/engine.js';import {makeModelResolver} from '../src/pi/modelResolver.js';import {resolveRolePrompt} from '../src/agent/prompts.js';import {configureAgentEnv} from '../src/agent/roles.js';import {AgentRunner} from '../src/pi/runner.js';import {buildApp} from '../src/http/app.js';import {AUTH_PASSWORD_KEY,hashPassword,signJWT} from '../src/http/auth.js';import {configureEvidenceStore} from '../src/evidence/blobs.js';
const name=`fate_real_mcp_${process.pid}`,dir=`/private/tmp/${name}`,evidence=path.resolve(process.env.FATE_MCP_EVIDENCE??`../../docs/reviews/evidence/real-mcp-20261019/run-${process.pid}`);
mkdirSync(evidence,{recursive:true});mkdirSync(path.join(dir,'skills'),{recursive:true});
const record:any={run_id:randomUUID(),db:name,data_dir:dir,started_at:new Date().toISOString(),status:'ready',budgets:{requests:null,tokens:null,duration:null},requests:[],mcp:[],runs:[],events:[]};
let apiKey='';const clean=(v:unknown)=>String(v).split(apiKey||'\0').join('[redacted]');const save=()=>writeFileSync(path.join(evidence,'run.json'),JSON.stringify(record,null,2)+'\n');const originalFetch=globalThis.fetch;
const source=new Database(new pg.Pool({connectionString:postgresDSN().dsn}));const profile=await source.platform().profileByID(Number(process.env.FATE_MCP_PROFILE_ID??453));
if(!profile?.apiKey||new URL(profile.baseURL).hostname!=='api.deepseek.com')throw new Error('Configured DeepSeek profile required');apiKey=profile.apiKey;
const roles=['planner','worker','mainagent'],prompts=await Promise.all(roles.map(async role=>({role,...await resolveRolePrompt(source,role)})));await source.close();
process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}?sslmode=disable`;process.env.SERIES_LOG_LEVEL='silent';
const db=await openDatabase();configureEvidenceStore(db,dir);configureAgentEnv({skillsDir:path.join(dir,'skills')});
const pid=await db.platform().saveProfile({...profile,id:undefined,name:'Real MCP isolated acceptance',isDefault:true,poolExclude:true,proxy:'',maxTokens:0});
for(const p of prompts){const a=(await db.platform().getAgentByKey(p.role))!;await db.platform().savePrompt(a.id,p.template,'Isolated runtime prompt copy','acceptance');}
await db.query('UPDATE agents SET max_turns=0,run_seconds=0 WHERE key=ANY($1)',[roles]);await db.platform().setSetting('workers','1');
const safe=['add_intent','dispatch_intents','record_fact','prove_goal','context_search','context_get','graph_overview','todo_write','tool_search','read_tool_output'];await db.query('UPDATE tools SET enabled=key=ANY($1::text[])',[safe]);
const mid=await db.platform().saveMCP({name:'deepwiki',transport:'http',url:'https://mcp.deepwiki.com/mcp',enabled:true,insecure:false,command:'',args:[],env:{}});
await db.query("INSERT INTO agent_visibility(agent_id,resource_kind,resource_id,mcp_tool_name,enabled) SELECT id,'mcp',$1,'',true FROM agents WHERE key='worker'",[mid]);
const asset=await db.assets().upsertHTTPService({url:'https://github.com/microsoft/node-pty',pageTitle:'Public node-pty documentation acceptance'});
const goal='保存两条由远程 DeepWiki 文档支持的独立事实：node-pty 文档目录中的平台结构，以及终端进程退出与资源清理 API 的行为。不是漏洞验证。';
const description=`真实模型与公开 MCP 验收，仅查询 microsoft/node-pty 的公开文档，不测试 GitHub 或 DeepWiki 的安全性。Planner 只提交一个意图，由同一 Worker 完成两项交付；意图描述必须包含以下完整步骤：先用 tool_search 查找 deepwiki 工具，调用 read_wiki_structure 读取 microsoft/node-pty；立即用 record_fact 保存平台结构观察（证据写明实际返回的章节，锚定资产 ${asset}）。写回成功后再调用远程问答工具查询终端退出、onExit、kill 和资源清理，随后写第二条独立事实。必须先保存第一条事实再发起第二次 MCP 调用，不能把两个阶段都做完再集中写回。远程 tool_result 是本次证据，不编造 traffic_id 或截图。所有操作完成后简短总结并停止。暂停恢复时读取已有事实与会话，跳过已成功记录的阶段；被取消且未返回工具结果的文档查询可以重新发起。Planner 等待该意图结束后，依据两条事实证明上述文档交付目标。Worker 暂停时等待用户恢复，不创建替代意图，不扩展到其他方向。不报告漏洞，不运行本地命令，不调用其他网络服务。`;
const task=await db.tasks().createTaskWithOptions(description,goal,{name:'真实 MCP：Worker 按钮暂停与恢复',executionMode:'managed',llmProfileIDs:[pid],assetIDs:[asset],timeoutSeconds:0,coverageEnabled:false,planHeartbeatSeconds:60});
const store=db.exploration(task.exploration_id),origin=await store.originFactID(),goalID=await store.addGoal({text:goal},'user');await store.link(origin,'spawns',goalID);await db.query('INSERT INTO main_sessions(exploration_id,seq) VALUES($1,1),($1,2)',[task.exploration_id]);
// Goals is intentionally bypassed in this focused Planner/Worker fixture; seed
// the same persistent constraint block that normal goal extraction would save.
await db.query("INSERT INTO task_constraints(exploration_id,kind,text,origin) VALUES($1,'allow',$2,'user')",[task.exploration_id,'整个验收仅创建一个意图，由同一 Worker 顺序完成两项文档交付。Worker 暂停时等待用户点击恢复按钮；禁止创建新意图接续其剩余步骤、禁止替代意图。只查询 microsoft/node-pty 的公开 DeepWiki 文档，不做漏洞测试。']);
Object.assign(record,{task_id:task.id,exp_id:task.exploration_id,asset_id:asset,goal_id:goalID,main_a:1,main_b:2,prompt_versions:prompts.map(p=>({role:p.role,version:p.version,source:p.source}))});
const facts=async()=> (await store.listByKind('fact')).filter(n=>n.state==='confirmed'&&n.payload.from_intent);let gateUsed=false;
globalThis.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
 if(['127.0.0.1','localhost'].includes(url.hostname))return originalFetch(input,init);
 if(!['api.deepseek.com','mcp.deepwiki.com'].includes(url.hostname))throw new Error('Acceptance outbound scope: public DeepWiki and configured model only');
 const body=typeof init?.body==='string'?JSON.parse(init.body):{};
 if(url.hostname==='api.deepseek.com'){
  const pending=(await db.query("SELECT role FROM llm_request_attempts WHERE task_id=$1 AND status='running' ORDER BY id DESC LIMIT 1",[task.id])).rows[0];
  const r:any={at:new Date().toISOString(),role:pending?.role,bytes:Buffer.byteLength(JSON.stringify(body)),tools:(body.tools??[]).map((t:any)=>t.function?.name),output_limits:Object.fromEntries(['max_tokens','max_completion_tokens','max_output_tokens'].filter(k=>k in body).map(k=>[k,body[k]]))};record.requests.push(r);save();
  try{const response=await originalFetch(input,init);r.status=response.status;save();return response;}catch(e){r.error=clean(e);save();throw e;}
 }
 const item:any={at:new Date().toISOString(),method:body.method??init?.method??'GET',tool:body.params?.name,arguments:body.params?.arguments};record.mcp.push(item);save();const response=await originalFetch(input,init);item.status=response.status;
 if(body.method==='tools/call'){
  item.response=await response.clone().text();item.remote_response_at=new Date().toISOString();const saved=await facts();
  if(response.ok&&saved.length&&record.mcp.some((x:any)=>x.method==='tools/call'&&x.delivered_at)&&!gateUsed){
   gateUsed=true;record.gate={ready:true,at:new Date().toISOString(),boundary:'real remote response received; delivery to PI held until UI pause',fact_ids:saved.map(n=>n.id)};record.first_fact_visible_while_running={at:new Date().toISOString(),facts:saved,intents:await store.listByKind('intent')};save();
   await new Promise<void>(resolve=>{if(init?.signal?.aborted)resolve();else init?.signal?.addEventListener('abort',()=>resolve(),{once:true});});
   item.cancelled_at=new Date().toISOString();record.gate.cancelled=true;save();await response.body?.cancel().catch(()=>{});throw new DOMException('Acceptance UI paused during remote response delivery','AbortError');
  }item.delivered_at=new Date().toISOString();
 }save();return response;
};
const originalPrompt=AgentRunner.prototype.prompt;
AgentRunner.prototype.prompt=async function(...args:Parameters<typeof originalPrompt>){
 const opts=(this as any).opts,run:any={role:opts.platform?.role,started_at:new Date().toISOString(),max_turns:opts.maxTurns,max_duration_ms:opts.maxDurationMs,session_path:this.sessionFile,session_id:this.sessionId};record.runs.push(run);save();
 try{const result=await originalPrompt.apply(this,args);Object.assign(run,{finished_at:new Date().toISOString(),...result});save();return result;}catch(e){Object.assign(run,{finished_at:new Date().toISOString(),error:clean(e)});save();throw e;}
};
const engine=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:250},makeModelResolver(db),dir);
engine.bus.on('activity',a=>{if((a.metadata as any)?.worker_feedback)void (async()=>{record.events.push({...a,observed_at:new Date().toISOString(),active_slots:(await db.query('SELECT id FROM engine_worker_slots WHERE intent_id=$1',[(a.metadata as any).worker_feedback.intent_id])).rows});save();})();});
const jwt=randomUUID(),token=signJWT(jwt);await db.platform().setSetting(AUTH_PASSWORD_KEY,hashPassword('Fate-MCP-Acceptance-20261019'));
const app=buildApp({db,engine,jwtKey:jwt,dataDir:dir,skillsRoot:path.join(dir,'skills'),version:'real-mcp-20261019',startedAt:Date.now()});
app.post('/api/acceptance/start',async()=>{record.status='running';save();await engine.run(task.id);return {task_id:task.id};});
app.get('/api/acceptance/state',async()=>({task:await db.tasks().getTask(task.id),intents:await store.listByKind('intent'),facts:await facts(),gate:record.gate,requests:record.requests.length,runs:record.runs}));
app.post('/api/acceptance/capture',async()=>{
 record.task=await db.tasks().getTask(task.id);record.intents=await store.listByKind('intent');record.facts=await facts();
 record.activity=(await db.query('SELECT id,node_id,worker,kind,tool,is_error,summary,detail,metadata,main_seg,created_at FROM activity WHERE exploration_id=$1 ORDER BY id',[task.exploration_id])).rows;
 record.attempts=(await db.query('SELECT id,role,model,status,purpose,usage,error,created_at,finished_at FROM llm_request_attempts WHERE task_id=$1 ORDER BY id',[task.id])).rows;
 record.runtime_configs=(await db.query('SELECT role,effective,finished_at FROM runtime_role_configs WHERE task_id=$1',[task.id])).rows;record.feedback=(await db.query('SELECT * FROM worker_feedback WHERE task_id=$1',[task.id])).rows;
 record.status='captured';save();return {saved:true,evidence};
});
app.addHook('onResponse',async(req,reply)=>{record.http??=[];record.http.push({path:req.url.split('?')[0],status:reply.statusCode,has_token:!!req.headers['x-series-token'],at:new Date().toISOString()});save();});
const discovered=await app.inject({method:'POST',url:`/api/mcp/${mid}/refresh`,headers:{authorization:`Bearer ${token}`}});record.discovery=discovered.json();if(!record.discovery.tools?.length)throw new Error('Remote MCP discovery failed: '+JSON.stringify(record.discovery));
await app.listen({port:Number(process.env.FATE_MCP_PORT??18988),host:'127.0.0.1'});writeFileSync(path.join(dir,'token'),token,{mode:0o600});writeFileSync('/private/tmp/fate-real-mcp-active.json',JSON.stringify({dir,name,evidence,task_id:task.id,exp_id:task.exploration_id,port:Number(process.env.FATE_MCP_PORT??18988)}));save();console.log(JSON.stringify({ready:true,task_id:task.id,port:Number(process.env.FATE_MCP_PORT??18988),evidence}));
process.on('SIGTERM',async()=>{await engine.shutdown();await app.close();await db.close();record.stopped_at=new Date().toISOString();save();process.exit(0);});
