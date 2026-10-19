// Runtime-only credentials. Three physical requests maximum, local synthetic graph only.
import pg from 'pg';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {Database,openDatabase} from '../src/db/index.js';
import {makeModelResolver} from '../src/pi/modelResolver.js';
import {createTrackedRunner} from '../src/engine/runtime-config.js';
import {systemRolePrompt} from '../src/agent/prompts.js';
import {contextSearchTool} from '../src/tools/context-read.js';
import {runContext} from '../src/tools/context.js';

const evidence=process.env.FATE_PLATFORM_EVIDENCE_DIR!,baselineFile=process.env.FATE_PLATFORM_BASELINE!;
if(!evidence||!baselineFile||!process.env.FATE_PLATFORM_PROFILE_DSN)throw new Error('required runtime configuration missing');
const baseline=JSON.parse(readFileSync(baselineFile,'utf8'));
const allowance=Math.min(3,64-Number(baseline.request_count));
const output=path.join(evidence,'deepseek-platform-probe.json');mkdirSync(evidence,{recursive:true});
// Never overwrite evidence or accidentally spend the same allocation twice.
try{readFileSync(output);throw new Error('probe evidence already exists');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
const sourceDB=new Database(new pg.Pool({connectionString:process.env.FATE_PLATFORM_PROFILE_DSN}));
const profile=await sourceDB.platform().profileByID(Number(process.env.FATE_PLATFORM_PROFILE_ID||1));await sourceDB.close();
if(!profile?.apiKey||profile.model!=='deepseek-flash'||new URL(profile.baseURL).hostname!=='api.deepseek.com')throw new Error('approved runtime profile missing');
const dir=mkdtempSync(path.join(tmpdir(),'fate-platform-live-')),name=`fate_platform_live_${process.pid}`;
process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}?sslmode=disable`;process.env.SERIES_LOG_LEVEL='silent';
const db=await openDatabase(),deadline=Date.now()+20*60_000,originalFetch=globalThis.fetch;
const record:any={started_at:new Date().toISOString(),db:name,data_dir:dir,baseline_requests:baseline.request_count,allowance,calls:0,target_requests:0,usage:[],requests:[],tools:[]};
const save=()=>writeFileSync(output,JSON.stringify(record,null,2)+'\n');save();
globalThis.fetch=async(input,init)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  if(url.hostname!=='api.deepseek.com')throw new Error('probe forbids non-model network access');
  if(record.calls>=allowance||Date.now()>=deadline)throw new Error('live request budget exhausted');
  record.calls++;save();return originalFetch(input,init);
};
let runner:Awaited<ReturnType<typeof createTrackedRunner>>|undefined;
try{
  const pid=await db.platform().saveProfile({...profile,id:undefined,name:'LOCAL domain adaptation',isDefault:true,proxy:'',maxTokens:800,streaming:true,retry:{connect:{attempts:-1,interval_ms:0}}});
  const task=await db.tasks().createTaskWithOptions('LOCAL domain adaptation','仅查询本地合成图，无目标操作',{});
  await db.query('INSERT INTO task_llm_profiles(task_id,profile_id,position) VALUES($1,$2,0)',[task.id,pid]);
  const source=await makeModelResolver(db)(task.id,'mainagent');
  const tools=[contextSearchTool(runContext(db,task.id,task.exploration_id,'mainagent'))];
  const options={...source,cwd:dir,agentDir:path.join(dir,'agent'),resumeSessionPath:path.join(dir,'main.jsonl'),
    systemPrompt:await systemRolePrompt(db,'mainagent',{Goal:task.goal}),toolAllowlist:['context_search'],customTools:tools,
    maxTurns:3,maxWrapupTurns:0,maxDurationMs:60_000,compactionSettings:{keepRecentTokens:64},
    onRequestSize:(size:unknown,purpose?:string)=>{record.requests.push({purpose:purpose??'conversation',size});},
    guard:(g:{toolName:string})=>g.toolName==='context_search'?undefined:{block:true,reason:'LOCAL 查询验证只允许 context_search'},
    onActivity:(a:any)=>{if(a.kind==='usage')record.usage.push(a);if(a.kind==='tool_end')record.tools.push({name:a.toolName,error:a.isError});},
  };
  runner=await createTrackedRunner(db,task.id,'mainagent',options);
  await runner.appendContextOnce('fixture:local','LOCAL 合成历史：没有授权测试目标，没有已确认漏洞，没有可执行意图。只查询本地数据库，不应创建任务或外联。'.repeat(40));
  const result=await runner.prompt('调用一次 context_search 查询当前任务的 goal 和 intent，limit=3，然后用一句话说明状态并结束。不要调用其他工具或执行目标操作。');
  if(result.aborted||record.calls>2||!record.tools.some((t:any)=>t.name==='context_search'&&!t.error))throw new Error('local query did not meet the two-request allowance');
  await runner.compact();record.compaction=runner.compactionDiagnostics;
  record.audit=(await db.query('SELECT purpose,status,usage FROM llm_request_attempts WHERE task_id=$1 ORDER BY id',[task.id])).rows;
  await runner.dispose();runner=undefined;
  runner=await createTrackedRunner(db,task.id,'mainagent',options);
  record.restored_checkpoint=JSON.stringify(runner.messages).includes('不是新的事实或授权');
  record.status=record.restored_checkpoint&&record.compaction.completed===1&&record.audit.length===record.calls&&record.audit.every((a:any)=>a.status==='completed')?'passed':'failed';
}catch(error){record.status='failed';record.error=String(error).replace(/sk-[\w.-]+/g,'[redacted]');}
finally{
  await runner?.dispose();globalThis.fetch=originalFetch;
  await db.query("UPDATE llm_profiles SET api_key=''");await db.close();
  record.finished_at=new Date().toISOString();record.total_authorized_requests=record.baseline_requests+record.calls;save();
  console.log(JSON.stringify({status:record.status,calls:record.calls,total:record.total_authorized_requests,target_requests:0}));
}
if(record.status!=='passed')process.exitCode=1;
