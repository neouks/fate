/** Real-model planning only: real domain writes to a new test database, no
 * Worker runner, scheduler, target requests, or production task mutations. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import pg from 'pg';
import {Database,openDatabase} from '../src/db/index.js';
import {postgresDSN} from '../src/config/index.js';
import {resolveModelProfiles} from '../src/pi/modelResolver.js';
import {buildModelSource} from '../src/pi/providerFromProfile.js';
import {AgentRunner} from '../src/pi/runner.js';
import {systemRolePrompt} from '../src/agent/prompts.js';
import {availableDomainTools} from '../src/tools/index.js';
import {runContext} from '../src/tools/context.js';
import {applyToolBindings} from '../src/agent/tool-bindings.js';
import {INTENT_GRANULARITY_GUIDANCE} from '../src/agent/intent-granularity.js';
if(!process.argv.includes('--run')){console.log('Pass --run to verify Planner/Main planning in an isolated database.');process.exit(0);}
const out=resolve(process.argv.find(a=>a.startsWith('--out='))?.slice(6)??'../../docs/reviews/evidence/intent-granularity-'+Date.now());
await mkdir(out,{recursive:false,mode:0o700});
const dsn=postgresDSN().dsn,oldDSN=process.env.SERIES_PG_DSN;
const production=new Database(new pg.Pool({connectionString:dsn,options:'-c default_transaction_read_only=on'}));
const adminURL=new URL(dsn);adminURL.pathname='/postgres';const admin=new pg.Pool({connectionString:adminURL.href});
const name='test_intent_granularity_model_'+Date.now(),testURL=new URL(dsn);testURL.pathname='/'+name;
let db:Database|undefined,created=false;const fetchOriginal=globalThis.fetch,summary:any[]=[];
const scenarios=[
 {key:'dependent',expected:1,goal:'完成隔离练习系统的登录核查，并在取得有效会话后核查上传入口的权限要求。',
  evidence:'当前只确认存在练习系统登录入口；尚无有效会话、尚无登录核查结果，上传入口需要登录。本任务只有只读检查授权。',
  request:'原始工作候选是：核查登录是否接受授权的测试凭据；若成功，继续检查后台上传入口的权限要求。请安排本轮实际可执行工作，保存后续计划。无需实际访问系统。'},
 {key:'ready',expected:1,goal:'完成隔离练习系统的登录核查，并在取得有效会话后核查上传入口的权限要求。',
  evidence:'登录核查已完成并有有效会话，身份和授权范围已确认并保存。上传入口已经定位，本轮只需核查该入口的权限要求；已有登录结论有效，无需重做。全部工作只读。',
  request:'根据已保存的结果安排下一步，引用已有证据，不重新做登录核查。无需实际访问系统。'},
 {key:'independent',expected:2,goal:'核对同一离线服务的导出文件时间字段格式和帮助页版本标识。',
  evidence:'离线导出样本 export.csv 和离线帮助页 help.html 已就绪。时间字段格式与帮助页版本标识是两项独立要求，互不依赖，各自可独立验收，均未执行。',
  request:'请安排这两项已具备条件的工作。每项可以包含读取样本、核对规则、保存证据和给出结论等必要步骤；不需要每一步都创建工作。'},
];
try{
 const profiles=await Promise.all(['planner','mainagent'].map(async role=>{const p=(await resolveModelProfiles(production,0,role)).profiles[0];assert(p&&!p.proxy);return p;}));
 const sources=await Promise.all(profiles.map(p=>buildModelSource({...p,maxTokens:3072})));
 await admin.query(`CREATE DATABASE "${name}"`);created=true;process.env.SERIES_PG_DSN=testURL.href;db=await openDatabase();
 for(const [index,role] of (['planner','mainagent'] as const).entries())for(const scenario of scenarios){
  const only=process.argv.find(a=>a.startsWith('--only='))?.slice(7);
  if(only&&only!==role&&only!==role+'/'+scenario.key)continue;
  const dir=join(out,role+'-'+scenario.key);await mkdir(dir);let runner:AgentRunner|undefined;let requests=0;const errors:string[]=[],dispatches:number[]=[];
  const exp=await db.createExploration('offline planning fixture',scenario.goal);
  const task=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,status,execution_mode) VALUES($1,$2,$3,'running','managed') RETURNING id",['offline planning fixture',scenario.goal,exp])).rows[0]!.id);
  const fact=await db.exploration(exp).addNode('fact',{summary:scenario.evidence,evidence:'合成夹具观察：'+scenario.evidence},0,'confirmed','fixture',[]);
  const ctx=runContext(db,task,exp,role,{...(role==='planner'?{plannerSession:{identity:()=>`${task}:fixture`,entries:()=>runner?.sessionEntries??[]}}:{}),hooks:{dispatchIntent:async(_exp,id)=>{dispatches.push(id);return {queued:true};}}});
  const tools=await applyToolBindings(db,role,availableDomainTools(ctx).filter(t=>['add_intent','todo_write','context_search','context_get'].includes(t.name)));
  const system=await systemRolePrompt(db,role,{Goal:scenario.goal});
  assert.equal(system.split(INTENT_GRANULARITY_GUIDANCE).length-1,1);
  globalThis.fetch=async(input,init)=>{
   let payload:any;try{payload=JSON.parse(typeof init?.body==='string'?init.body:'');}catch{}
   if(payload?.model&&(payload.messages||payload.input)){
    assert(++requests<=10,'Request budget exceeded');
    const names=(payload.tools??[]).map((t:any)=>t.function?.name??t.name);assert.equal(names.length,new Set(names).size,'Duplicate tool schemas');
    writeFileSync(join(dir,`request-${requests}.json`),JSON.stringify(payload,null,2),{mode:0o600});
   }
   return fetchOriginal(input,init);
  };
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort('scenario timeout'),180_000);
  try{
   runner=await AgentRunner.create({...sources[index]!,cwd:dir,agentDir:join(dir,'agent'),inMemory:true,signal:controller.signal,maxTurns:8,
    platform:{role,taskID:task,policy:{version:'domain-v1',compaction:'native',mcpLoading:'deferred'}},
    systemPrompt:system,toolAllowlist:tools.map(t=>t.name),customTools:tools,
    onActivity:a=>{if(a.kind==='tool_end'&&a.isError)errors.push(a.toolName);},
   });
   const instruction=role==='mainagent'?scenario.request.replace('无需实际访问系统。','请调用派单工具保存本轮可执行意图，系统不会启动 Worker；不是仅提供文字建议。'):scenario.request;
   const result=await runner.prompt(instruction+'\n当前任务宿主快照：'+JSON.stringify({task_id:task,exploration_id:exp,execution_mode:'managed',existing_intents:[],goals:[scenario.goal],facts:[{id:fact,version:0,summary:scenario.evidence}]}));
   const intents=(await db.query("SELECT id,state,payload FROM exploration_nodes WHERE exploration_id=$1 AND kind='intent' ORDER BY id",[exp])).rows;
   const todo=(await db.query('SELECT planner_todos FROM explorations WHERE id=$1',[exp])).rows[0]?.planner_todos;
   await writeFile(join(dir,'result.json'),JSON.stringify({role,scenario:scenario.key,model:profiles[index]!.model,requests,errors,intents,todo,answer:result.lastAssistantText,dispatches},null,2));
   assert.equal(result.stopReason,'completed');assert.equal(intents.length,scenario.expected,role+' '+scenario.key+' wrong work count');
   assert.equal(errors.length,0,'Tool calls failed');
   assert(intents.every(n=>n.state==='open'),'No Worker should execute');
   if(scenario.key==='ready')assert(intents.every(n=>(n.payload.contract?.basis??[]).some((r:any)=>Number(r.node_id)===fact)),'Follow-up must reference the saved result');
   if(scenario.key==='dependent'){
    if(tools.some(t=>t.name==='todo_write'))assert(Array.isArray(todo)&&todo.some((t:any)=>/上传/.test(t.content)),'Dependent work must stay in todo');
    else assert.match(result.lastAssistantText??'',/等待|依赖|结果|后续/,'Explain the deferred work when todo tool is not bound');
   }
   if(role==='mainagent')assert.equal(dispatches.length,scenario.expected,'Main dispatch callback count');
   summary.push({role,scenario:scenario.key,model:profiles[index]!.model,requests,intents:intents.length,errors:0,dispatch_callbacks:dispatches.length});console.log(JSON.stringify(summary.at(-1)));
  }finally{clearTimeout(timer);controller.abort();await runner?.dispose();globalThis.fetch=fetchOriginal;}
 }
 await writeFile(join(out,'summary.json'),JSON.stringify({checks:summary,production_task_writes:false,worker_executions:0,deployed:false,review:'Inspect each result.json for semantic scope; counts alone do not prove atomic intent.'},null,2));
}finally{
 globalThis.fetch=fetchOriginal;await db?.close();await production.close();if(created)await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();
 if(oldDSN===undefined)delete process.env.SERIES_PG_DSN;else process.env.SERIES_PG_DSN=oldDSN;
}
