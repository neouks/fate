// Spend only the unused eighth physical request from deepseek-chain-probe.
import pg from 'pg';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {Database} from '../src/db/index.js';
import {makeModelResolver} from '../src/pi/modelResolver.js';
import {createTrackedRunner} from '../src/engine/runtime-config.js';
import {systemRolePrompt} from '../src/agent/prompts.js';
import {runContext,TodoStore} from '../src/tools/context.js';
import {proveGoalTool} from '../src/tools/findings.js';
import {planDecisionTool} from '../src/tools/coordination.js';
import {buildGraphOverview} from '../src/tools/overview.js';

const input=process.env.FATE_LIVE_CHAIN_INPUT!,output=process.env.FATE_LIVE_TAIL_OUTPUT!,dsn=process.env.FATE_LIVE_PROFILE_DSN!;
if(!input||!output||!dsn||existsSync(output))throw new Error('fresh tail evidence path required');
const base=JSON.parse(readFileSync(input,'utf8'));
if(base.calls!==7||base.baseline_requests!==64||!base.checks.restored?.done)throw new Error('expected exactly seven spent requests and verified recovery');
const source=new Database(new pg.Pool({connectionString:dsn})),profile=await source.platform().profileByID(1);await source.close();
if(!profile?.apiKey)throw new Error('runtime key unavailable');
if(!/^fate_live_chain_\d+$/.test(base.db))throw new Error('invalid isolated DB');
const db=new Database(new pg.Pool({connectionString:`postgres://series:series@127.0.0.1:5433/${base.db}?sslmode=disable`}));
const record:any={started_at:new Date().toISOString(),status:'running',budget_mode:'one native turn; no final conversational turn',calls:0,baseline_requests:71,target_requests:0,tools:[],requests:[]};
writeFileSync(output,JSON.stringify(record,null,2)+'\n',{flag:'wx'});const save=()=>writeFileSync(output,JSON.stringify(record,null,2)+'\n');
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
  const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  if(u.protocol!=='https:'||u.hostname!=='api.deepseek.com'||record.calls>=1)throw new Error('supplemental eighth-request cap');
  const body=typeof init?.body==='string'?JSON.parse(init.body):{};
  record.calls++;record.requests.push({bytes:Buffer.byteLength(JSON.stringify(body)),stream:body.stream===true});save();
  const r=await originalFetch(input,init);Object.assign(record.requests.at(-1),{status:r.status,content_type:r.headers.get('content-type')});save();return r;
};
let runner:Awaited<ReturnType<typeof createTrackedRunner>>|undefined;
try{
  await db.query('UPDATE llm_profiles SET api_key=$1',[profile.apiKey]);
  const task=(await db.tasks().getTask(base.task_id))!,round=randomUUID(),todos=new TodoStore(db);await todos.load(task.exploration_id);
  const ctx=runContext(db,task.id,task.exploration_id,'planner',{planningRoundID:round,todos});
  const tools=[proveGoalTool(ctx),planDecisionTool(ctx)],overview=await buildGraphOverview(ctx);
  const model=await makeModelResolver(db)(task.id,'planner');
  runner=await createTrackedRunner(db,task.id,'planner',{...model,cwd:path.join(base.data_dir,'tasks',String(task.id)),agentDir:path.join(base.data_dir,'pi-agent'),
    systemPrompt:await systemRolePrompt(db,'planner',{Goal:task.goal}),toolAllowlist:tools.map(t=>t.name),customTools:tools,inMemory:true,maxTurns:1,maxWrapupTurns:0,maxDurationMs:60_000,
    onActivity:a=>{if(a.kind==='tool_end')record.tools.push({name:a.toolName,error:a.isError,result:a.content});},
  });
  const goal=(await db.exploration(task.exploration_id).listByKind('goal'))[0]!,fact=base.checks.worker.fact_id;
  record.result=await runner.prompt(`这是本地合成资料的单轮验收，不执行目标探测。完整当前态势：${JSON.stringify(overview)}\n已由宿主核对：唯一意图 done，唯一事实 #${fact} 的证据为 SYNTHETIC sample=ALPHA, check=PASS；这是合成数据，不是真实漏洞。coverage_enabled=false，漏洞数为0符合用户目标，无其他待办。\n请在本次响应中同时调用 prove_goal(goal_id=${goal.id},evidence_node_id=${fact}) 和 record_plan_decision(status=exhausted,basis_ids=[${fact}],reason=说明合成验收已满足,resume_when=用户追加目标)。不要新增意图。模型预算仅一轮，宿主会在工具提交后停止，不需要下一轮自然语言收尾。`);
  await runner.dispose();runner=undefined;
  record.goal=(await db.exploration(task.exploration_id).getNode(goal.id))?.state;
  record.decision=(await db.query('SELECT decision FROM planner_decisions WHERE round_id=$1',[round])).rows[0]?.decision;
  record.intent_count=(await db.exploration(task.exploration_id).listByKind('intent')).length;
  assert.equal(record.goal,'met');assert.equal(record.decision?.status,'exhausted');assert.equal(record.intent_count,1);assert.ok(record.tools.every((t:any)=>!t.error));
  record.status='passed';
}catch(error){record.status='failed';record.error=String(error).split(profile.apiKey).join('[redacted]');}
finally{
  await runner?.dispose();globalThis.fetch=originalFetch;
  record.audit=(await db.query("SELECT id,role,purpose,status,usage,error FROM llm_request_attempts WHERE task_id=$1 AND role='planner' ORDER BY id",[base.task_id])).rows;
  if(record.status==='passed'&&(record.audit.length!==1||record.audit[0]?.status!=='completed')){record.status='failed';record.error='Planner audit mismatch';}
  await db.query("UPDATE llm_profiles SET api_key=''");await db.close();
  record.total_requests=71+record.calls;record.finished_at=new Date().toISOString();save();console.log(JSON.stringify({status:record.status,calls:record.calls,total:record.total_requests,goal:record.goal,decision:record.decision,error:record.error}));
}
if(record.status!=='passed')process.exitCode=1;
