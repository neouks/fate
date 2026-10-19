import pg from 'pg';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Database,openDatabase} from '../src/db/index.js';
import {buildModelSource} from '../src/pi/providerFromProfile.js';
import {createTrackedRunner} from '../src/engine/runtime-config.js';
import {systemRolePrompt} from '../src/agent/prompts.js';
import {mainTools} from '../src/tools/index.js';
import {runContext} from '../src/tools/context.js';
import {applyToolBindings} from '../src/agent/roles.js';
const evidence=process.env.FATE_PROMPT_EVIDENCE_DIR!;
const comparisonFile=path.join(evidence,'deepseek-comparison.json');
const comparison=JSON.parse(readFileSync(comparisonFile,'utf8'));
const sourceDB=new Database(new pg.Pool({connectionString:process.env.FATE_PROMPT_PROFILE_DSN}));
const profile=await sourceDB.platform().profileByID(Number(process.env.FATE_PROMPT_PROFILE_ID||1));await sourceDB.close();
if(!profile?.apiKey)throw new Error('runtime profile missing');
const name=`fate_prompt_live_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-prompt-host-'));
process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}?sslmode=disable`;
process.env.SERIES_LOG_LEVEL='silent';
const db=await openDatabase();let runner:Awaited<ReturnType<typeof createTrackedRunner>>|undefined;
const record:any={target_requests:0,db:name,started_at:new Date().toISOString(),calls:0,tools:[],usage:[]};
try{
 const id=await db.platform().saveProfile({...profile,id:undefined,name:'LOCAL prompt host probe',isDefault:true,maxTokens:800});
 const task=await db.tasks().createTaskWithOptions('LOCAL prompt host probe','仅查询本地合成任务进度',{});
 await db.query('UPDATE tasks SET llm_profile_id=$2,active_llm_profile_id=$2 WHERE id=$1',[task.id,id]);
 const tools=await applyToolBindings(db,'mainagent',mainTools(runContext(db,task.id,task.exploration_id,'mainagent')));
 const source=await buildModelSource({...profile,maxTokens:800});
 const deadline=new Date(comparison.started_at).getTime()+20*60_000;
 runner=await createTrackedRunner(db,task.id,'mainagent',{...source,cwd:dir,agentDir:path.join(dir,'agent'),inMemory:true,
  systemPrompt:await systemRolePrompt(db,'mainagent',{Goal:task.goal}),customTools:tools,toolAllowlist:tools.map(t=>t.name),maxTurns:3,maxWrapupTurns:0,maxDurationMs:60000,
  guard:g=>['graph_overview','context_search','context_get','list_findings','list_assets'].includes(g.toolName)?undefined:{block:true,reason:'本地验收只允许查询'},
  onRequestSize:size=>{if(comparison.request_count>=64||Date.now()>=deadline)throw new Error('shared live evaluation budget exhausted');comparison.request_count++;record.calls++;},
  onActivity:a=>{if(a.kind==='tool_end')record.tools.push({name:a.toolName,error:a.isError});if(a.kind==='usage')record.usage.push(a);},
 });
 const result=await runner.prompt('查询当前 LOCAL 合成任务进度并简短说明；不要新建、下发、探测或修改任何内容。');
 const runtime=(await db.query("SELECT effective FROM runtime_role_configs WHERE task_id=$1 AND role='mainagent' ORDER BY started_at DESC LIMIT 1",[task.id])).rows[0]?.effective;
 record.runtime=runtime;record.status=!result.aborted&&record.tools.some((t:any)=>t.name==='graph_overview'&&!t.error)&&runtime?.first_request_size&&runtime?.request_count===record.calls?'passed':'failed';
 record.intents=(await db.exploration(task.exploration_id).listByKind('intent')).length;
 if(record.intents!==0)record.status='failed';
}catch(error){record.status='error';record.error=String(error).replace(/sk-[\w-]+/g,'[redacted]');}
finally{
 await runner?.dispose();await db.query("UPDATE llm_profiles SET api_key=''");await db.close();
 record.finished_at=new Date().toISOString();comparison.host_probe_requests=record.calls;
 writeFileSync(comparisonFile,JSON.stringify(comparison,null,2)+'\n');writeFileSync(path.join(evidence,'deepseek-host-probe.json'),JSON.stringify(record,null,2)+'\n');
 console.log(JSON.stringify({status:record.status,calls:record.calls,total_requests:comparison.request_count,target_requests:0}));
}
if(record.status!=='passed')process.exitCode=1;
