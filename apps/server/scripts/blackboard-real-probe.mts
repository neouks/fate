// Local synthetic blackboard acceptance. Every physical DeepSeek request is metered.
import pg from 'pg';import assert from 'node:assert/strict';import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';import {tmpdir} from 'node:os';
import {Database,openDatabase} from '../src/db/index.js';import {postgresDSN} from '../src/config/index.js';
import {Engine,defaultEngineConfig} from '../src/engine/engine.js';import {makeModelResolver} from '../src/pi/modelResolver.js';
import {configureAgentEnv} from '../src/agent/roles.js';
const ledgerPath=path.resolve('../../docs/reviews/evidence/terminal-acceptance-20261018/request-ledger.json');
const output=process.env.FATE_BLACKBOARD_OUTPUT!;assert.ok(output&&!existsSync(output));
const ledger=JSON.parse(readFileSync(ledgerPath,'utf8'));assert.equal(ledger.requests.length,489);assert.equal(ledger.allowance,500);
const lock=ledgerPath+'.lock';writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});
const name=`fate_blackboard_real_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-blackboard-real-')),runID=randomUUID();
const record:any={run_id:runID,started_at:new Date().toISOString(),database:name,data_dir:dir,status:'running',calls:0,peak:0,external_target_requests:0,events:[]};
mkdirSync(path.dirname(output),{recursive:true});mkdirSync(path.join(dir,'skills'));
const save=()=>writeFileSync(output,JSON.stringify(record,null,2)+'\n');let db:Database|undefined,e:Engine|undefined,key='';
const redact=(err:unknown)=>String(err).split(key||'\0').join('[redacted]').replace(/(?:Bearer\s+|\bsk-)[\w.-]+/gi,'[redacted]');
const deadline=Date.now()+180000,fetch0=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
 if(url.protocol!=='https:'||url.hostname!=='api.deepseek.com')throw Error('No target network access in synthetic acceptance');
 if(ledger.requests.length>=500||record.calls>=11||Date.now()>deadline){record.denied=true;save();throw Error('physical request budget exhausted');}
 const body=JSON.parse(String(init?.body??'{}')),tools=(body.tools??[]).map((t:any)=>t.function.name),role=tools.includes('complete_intent')?'worker':tools.includes('record_plan_decision')?'planner':'other';
 const request:any={number:ledger.requests.length+1,run_id:runID,at:new Date().toISOString(),role,bytes:Buffer.byteLength(JSON.stringify(body)),tools};
 ledger.requests.push(request);record.calls++;writeFileSync(ledgerPath,JSON.stringify(ledger,null,2)+'\n');save();
 try{const response=await fetch0(input,init);request.status=response.status;return response;}catch(error){request.error=redact(error);throw error;}
 finally{writeFileSync(ledgerPath,JSON.stringify(ledger,null,2)+'\n');}
};
try{
 const source=new Database(new pg.Pool({connectionString:postgresDSN().dsn})),profile=await source.platform().profileByID(453);await source.close();assert.ok(profile?.apiKey&&profile.model==='deepseek-flash');key=profile.apiKey;
 process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}?sslmode=disable`;db=await openDatabase();
 const pid=await db.platform().saveProfile({...profile,id:undefined,name:'LOCAL blackboard acceptance',isDefault:true,poolExclude:true,proxy:'',streaming:true});
 await db.platform().setSetting('workers','2');
 await db.query('UPDATE tools SET enabled=key=ANY($1::text[])',[['add_intent','record_plan_decision','prove_goal','record_fact','complete_intent','checkpoint_intent','context_get','context_search','graph_overview','todo_write']]);
 configureAgentEnv({skillsDir:path.join(dir,'skills')});
 const task=await db.tasks().createTaskWithOptions('LOCAL blackboard two-step arithmetic fixture. No network or files. Stage 1: one Worker sums supplied synthetic values [4,7,9], records the calculation as a fact and completes. Stage 2: only after stage 1 is done, Planner issues one new intent using the published stage-1 fact as parent and basis: another Worker verifies twice that sum equals 40, records one fact and completes. Planner proves the single goal after BOTH intents are done. Do not probe any targets. Each Planner round may batch add_intent with record_plan_decision. A Worker must stop immediately after complete_intent; no final prose is needed.', '两个依赖阶段完成：合成样本 [4,7,9] 求和为20，再引用该已发布事实验证两倍为40。',{executionMode:'managed',llmProfileIDs:[pid],timeoutSeconds:160});
 const s=db.exploration(task.exploration_id);await s.addGoal({text:task.goal},'user');record.task_id=task.id;record.exploration_id=task.exploration_id;save();
 e=new Engine(db,{...defaultEngineConfig(),workers:2,debounceMs:800,workerMaxTurns:5,plannerMaxTurns:5},makeModelResolver(db),dir);
 e.bus.on('activity',(a:any)=>{if(a.kind==='round'||a.kind==='result')record.events.push({at:new Date().toISOString(),worker:a.worker,node_id:a.nodeID,kind:a.kind,summary:String(a.summary??'').slice(0,500)});save();});
 await e.run(task.id);
 while(Date.now()<deadline){
  record.peak=Math.max(record.peak,Number((await db.query("SELECT count(*) n FROM engine_worker_slots WHERE phase='running'")).rows[0]?.n));
  const t=await db.tasks().getTask(task.id);if(t?.status==='done')break;if(record.denied||['failed','timeout'].includes(t?.status??''))throw Error('acceptance stopped: '+t?.status);
  await new Promise(r=>setTimeout(r,100));
 }
 assert.equal((await db.tasks().getTask(task.id))?.status,'done');
 record.intents=await s.listByKind('intent');record.facts=(await s.listByKind('fact')).filter(n=>n.state==='confirmed');
 assert.equal(record.intents.length,2);assert.ok(record.intents.every((n:any)=>n.state==='done'));assert.equal(record.facts.length,2);
 const first=record.intents.sort((a:any,b:any)=>a.id-b.id)[0],second=record.intents[1];
 const committed=(await db.query('SELECT completed_at FROM exploration_nodes WHERE id=$1',[first.id])).rows[0]!.completed_at;
 assert.ok(new Date(second.created_at)>=new Date(String(committed)));
 const calls=record.calls;await new Promise(r=>setTimeout(r,1500));assert.equal(record.calls,calls);assert.ok(record.peak<=2);
 record.status='passed';
}catch(error){record.status='failed';record.error=redact(error);}
finally{
 await e?.shutdown();globalThis.fetch=fetch0;
 if(db){record.tasks=(await db.query('SELECT id,exploration_id,status,description,goal,completed_at FROM tasks')).rows;record.nodes=(await db.query('SELECT * FROM exploration_nodes ORDER BY id')).rows;record.audit=(await db.query('SELECT role,purpose,status,usage,error FROM llm_request_attempts ORDER BY id')).rows;record.settlements=(await db.query('SELECT * FROM worker_settlements ORDER BY created_at')).rows;record.activity=(await db.query("SELECT id,node_id,worker,kind,tool,summary,is_error,metadata,created_at FROM activity WHERE kind NOT IN ('thinking','usage') ORDER BY id")).rows;await db.query("UPDATE llm_profiles SET api_key=''");await db.query("UPDATE tasks SET paused=true WHERE status='running'");await db.close();}
 record.finished_at=new Date().toISOString();record.remaining=500-ledger.requests.length;record.hashes=Object.fromEntries(['src/engine/engine.ts','src/pi/runner.ts','src/db/worker-drafts.ts'].map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));save();unlinkSync(lock);
 console.log(JSON.stringify({status:record.status,calls:record.calls,remaining:record.remaining,peak:record.peak,database:name,error:record.error}));
}
if(record.status!=='passed')process.exitCode=1;
