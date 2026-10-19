/** Explicit opt-in live evaluation; credentials are read from a runtime profile, never saved. */
import pg from 'pg';
import {readFileSync,mkdirSync,writeFileSync,mkdtempSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {defineTool,type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {Database} from '../src/db/index.js';
import {buildModelSource} from '../src/pi/providerFromProfile.js';
import {AgentRunner} from '../src/pi/runner.js';
import {ROLE_PROMPTS,hostProtocol,renderPrompt,composeRolePrompt} from '../src/agent/prompts.js';
import {TOOL_DESCRIPTIONS} from '../src/agent/tool-descriptions.js';
import {workerTools,plannerTools,mainTools,goalsTools} from '../src/tools/index.js';
import {runContext} from '../src/tools/context.js';

const dsn=process.env.FATE_PROMPT_PROFILE_DSN;
if(!dsn)throw new Error('FATE_PROMPT_PROFILE_DSN is required');
const db=new Database(new pg.Pool({connectionString:dsn}));
const profile=await db.platform().profileByID(Number(process.env.FATE_PROMPT_PROFILE_ID||1));await db.close();
if(!profile?.apiKey||profile.model!=='deepseek-flash')throw new Error('configured DeepSeek flash profile unavailable');
const source=await buildModelSource({...profile,maxTokens:1200});
const baseline=JSON.parse(readFileSync(new URL('../test-fixtures/prompt-baseline.json',import.meta.url),'utf8'));
const root=mkdtempSync(path.join(tmpdir(),'fate-prompt-live-'));
const output=process.env.FATE_PROMPT_EVIDENCE_DIR||root;mkdirSync(output,{recursive:true});
const previousFile=path.join(output,'deepseek-comparison.json');
const previous=process.env.FATE_PROMPT_CONTINUE==='1'&&existsSync(previousFile)?JSON.parse(readFileSync(previousFile,'utf8')):null;
const started=previous?.started_at||new Date().toISOString(),deadline=new Date(started).getTime()+20*60_000;let requests=previous?.request_count||0;
const superseded:any[]=previous?.superseded_rows||[];
const contract={version:1,objective:'只根据 LOCAL 合成输入回答 login_present，不访问网络或文件',acceptance:['说明 login_present=false 且数据是合成输入'],out_of_scope:['网络访问','文件操作','其他意图'],basis:[]};
const oldProtocols:Record<string,string>={worker:'【宿主执行约定】仅执行当前意图。阶段变化调用 checkpoint_intent；关键观察即时 record_fact。结束前必须 complete_intent 按 acceptance 的零起始索引逐项提交结果；负面结论也需证据。未完成用 partial/blocked，写明恢复位置。其他方向仅记录线索。',planner:'【宿主规划协议】没有新的可执行方向时允许等待依赖、请求输入或方向穷尽，禁止为保持运行凑单。优先按 context_search 查阅既往工作与证据，再提交带 contract 的意图。每轮结束前 record_plan_decision 保存简短依据和恢复条件。'};
const cases:Record<string,{user:string;goal?:string;tools:string[]}>={
 goals:{user:'这是 LOCAL 合成验收。最终交付物仅为一份基于现有离线资料的资产清单，没有授权任何外部测试对象。',tools:['set_goals','set_constraints','register_user_target']},
 planner:{goal:'用户尚未提供授权测试目标，需要等待输入。',user:'LOCAL 态势：goals=[待提供授权目标]，open_intents=[]，running_intents=[]，recent_done=[]，todos=[]。没有任何可执行目标。',tools:['context_search','graph_overview','record_plan_decision','add_intent']},
 mainagent:{goal:'查询已有任务状态',user:'LOCAL 用户请求：告诉我当前 Worker 进度，不新增任务或意图。',tools:['graph_overview','get_worker_trace','add_intent']},
 worker:{user:'当前意图的 LOCAL 合成证据：login_present=false。这不是实际目标的测试结果。完成本意图。',tools:['checkpoint_intent','record_fact','complete_intent','context_search']},
 auto:{user:'LOCAL 用户请求：查询已有任务 #11 的状态并告诉我，不创建新任务。',tools:['get_task','list_tasks','spawn_task']},
 pentest:{user:'已绑定任务 #11。仅整理这条离线 LOCAL 合成观察：login_present=false，证据 LOCAL_FIXTURE。将它写入绑定任务，明确是合成数据，不访问网络或文件，不新增其他方向。',tools:['record_conversation_fact','context_search']},
 reporter:{user:'请根据 LOCAL 合成漏洞 #51 的已有证据完善并保存报告，不是真实目标漏洞。',tools:['get_finding','update_finding_report']},
 retester:{user:'本次仅复核 LOCAL 合成漏洞 #51，原快照没有任何授权目标。请完成复测记录，不访问网络。',tools:['get_finding_retest_context','record_finding_retest_result']},
};
const object=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',properties,required});
const extra:Record<string,unknown>={
 get_task:object({task_id:{type:'integer'}}),list_tasks:object({},[]),spawn_task:object({description:{type:'string'}}),
 get_finding:object({finding_id:{type:'integer'},offset:{type:'integer'}},['finding_id']),
 update_finding_report:object({finding_id:{type:'integer'},evidence_version:{type:'integer'},report:{type:'string'}}),
 get_finding_retest_context:object({offset:{type:'integer'}},[]),
 record_finding_retest_result:object({verdict:{type:'string',enum:['reproduced','fixed','inconclusive']},summary:{type:'string'},evidence:{type:'string'}}),
};
const rows:any[]=previous?.rows||[];
for(const [role,c] of Object.entries(cases))for(const variant of ['before','after']){
 if(process.env.FATE_PROMPT_CASES&&!process.env.FATE_PROMPT_CASES.split(',').includes(role))continue;
 if(process.env.FATE_PROMPT_VARIANTS&&!process.env.FATE_PROMPT_VARIANTS.split(',').includes(variant))continue;
 const old=rows.findIndex(r=>r.role===role&&r.variant===variant);if(old>=0)superseded.push(...rows.splice(old,1));
 if(requests>=64||Date.now()>=deadline){rows.push({role,variant,status:'not_run_budget'});continue;}
 const dir=path.join(root,role,variant);mkdirSync(dir,{recursive:true});
 const calls:any[]=[],sizes:any[]=[],usage:any[]=[],saved:Record<string,any>={};let nudges=0;
 const ctx=runContext({} as Database,11,1,role as never);
 const originals=[...workerTools(ctx),...plannerTools(ctx),...mainTools(ctx),...goalsTools(ctx)];
 const tools=c.tools.map(name=>{
  const original=originals.find(t=>t.name===(name==='record_conversation_fact'?'record_fact':name));
  return defineTool({name,label:name,description:TOOL_DESCRIPTIONS[name]||original?.description||name,parameters:(original?.parameters||extra[name]||object({})) as never,
   async execute(_id,args:any){calls.push({name,args});let result:any={saved:true};
    switch(name){
     case 'graph_overview':result={goals:[],running_intents:[{id:17,progress:{phase:'waiting',summary:'LOCAL 等待授权输入'}}],open_intents:[],todos:[]};break;
     case 'get_worker_trace':result={intent_id:17,phase:'waiting',summary:'LOCAL 等待授权输入'};break;
     case 'context_search':result={items:[],next_cursor:null};break;
     case 'get_task':case 'list_tasks':result={task:{id:11,status:'paused',paused:true}};break;
     case 'get_finding':result={finding_id:51,evidence_version:7,content:JSON.stringify({name:'LOCAL synthetic finding',summary:'合成证据记录示例，不是真实漏洞',evidence:'LOCAL_FIXTURE: example-only',report:''}),next_offset:null};break;
     case 'get_finding_retest_context':result={content:JSON.stringify({finding_id:51,scope_targets:[],summary:'LOCAL synthetic finding',evidence:'LOCAL_FIXTURE: example-only'}),next_offset:null};break;
     case 'record_fact':case 'record_conversation_fact':saved.fact=args;result={fact_id:42};break;
     case 'complete_intent':
      if(!saved.fact||args.outcome!=='complete'||!args.criteria?.some((x:any)=>x.index===0&&x.fact_ids?.includes(42)))return {content:[{type:'text',text:JSON.stringify({error:'先记录本意图事实，逐项引用实际 fact_id'})}],isError:true,details:undefined};
      saved.result=args;break;
     case 'update_finding_report':
      if(args.evidence_version!==7)return {content:[{type:'text',text:'证据版本不匹配'}],isError:true,details:undefined};saved.report=args;break;
     case 'record_finding_retest_result':saved.retest=args;break;
     case 'set_goals':saved.goals=args;break;
     case 'record_plan_decision':saved.decision=args;break;
     case 'add_intent':case 'spawn_task':saved.unexpected=name;result={error:'LOCAL 场景不允许新增工作'};break;
    }
    return {content:[{type:'text',text:JSON.stringify(result)}],details:undefined};
   }});
 });
 const body=renderPrompt(variant==='before'?baseline[role]:ROLE_PROMPTS[role as keyof typeof ROLE_PROMPTS],{Goal:c.goal||'LOCAL fixture'});
 let system=variant==='before'?[body,oldProtocols[role]].filter(Boolean).join('\n'):composeRolePrompt(body,hostProtocol(role));
 if(role==='worker')system+='\n执行约定：'+JSON.stringify(contract);
 const timer=new AbortController();const timeout=setTimeout(()=>timer.abort('evaluation deadline'),Math.max(1,Math.min(deadline-Date.now(),120_000)));
 let runner:AgentRunner|undefined;
 try{
  runner=await AgentRunner.create({...source,cwd:dir,agentDir:path.join(dir,'agent'),inMemory:true,signal:timer.signal,
   toolAllowlist:tools.map(t=>t.name),customTools:tools,systemPrompt:system,maxTurns:5,maxWrapupTurns:1,maxDurationMs:120000,
   onRequestSize:size=>{if(requests>=64||Date.now()>=deadline)throw new Error('evaluation request/time budget exhausted');requests++;sizes.push(size);},
   onActivity:a=>{if(a.kind==='usage')usage.push(a);},
   wrapup:()=>{const missing=role==='worker'?!saved.result:role==='planner'?!saved.decision:role==='goals'?!saved.goals:role==='reporter'?!saved.report:role==='retester'?!saved.retest:false;if(!missing)return;const prompt=hostProtocol(role);if(!prompt)return;nudges++;return {prompt};},
  });
  const diagnostics=runner.promptDiagnostics,result=await runner.prompt(c.user);
  const ok=!result.aborted&&!saved.unexpected&&(role==='worker'?!!saved.result:role==='planner'?['needs_input','waiting_dependency'].includes(saved.decision?.status):role==='goals'?!!saved.goals?.goals?.length:role==='mainagent'?calls.some(t=>t.name==='graph_overview'):role==='auto'?calls.some(t=>t.name==='get_task'):role==='pentest'?!!saved.fact:role==='reporter'?!!saved.report:role==='retester'?saved.retest?.verdict==='inconclusive':false);
  rows.push({role,variant,status:ok?'passed':'failed',requests:sizes.length,nudges,diagnostics,request_sizes:sizes,usage,tools:calls,saved,stop_reason:result.stopReason});
  console.log(JSON.stringify({role,variant,status:ok?'passed':'failed',requests:sizes.length,total_requests:requests}));
 }catch(error){rows.push({role,variant,status:'error',requests:sizes.length,nudges,request_sizes:sizes,usage,tools:calls,error:String(error).replace(/sk-[\w-]+/g,'[redacted]')});console.log(JSON.stringify({role,variant,status:'error',total_requests:requests}));}
 finally{clearTimeout(timeout);await runner?.dispose();writeFileSync(path.join(output,'deepseek-comparison.json'),JSON.stringify({started_at:started,finished_at:new Date().toISOString(),model:profile.model,target_requests:0,request_limit:64,request_count:requests,superseded_rows:superseded,method:'fixed local synthetic inputs and tool bindings; native pi sessions; model/tool contracts tested separately by integration regressions',rows},null,2)+'\n');}
}
if(rows.some(r=>r.status!=='passed'))process.exitCode=1;
