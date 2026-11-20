/** Opt-in real Planner -> production steering tool/engine -> real Worker check.
 * Production configuration is read-only; all receipts use a fresh test DB.
 * No scheduler, server listener or production task is started. */
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {Database,openDatabase} from '../src/db/index.js';
import {postgresDSN} from '../src/config/index.js';
import {resolveModelProfiles} from '../src/pi/modelResolver.js';
import {buildModelSource} from '../src/pi/providerFromProfile.js';
import {AgentRunner} from '../src/pi/runner.js';
import {Engine} from '../src/engine/engine.js';
import {normalizeContract} from '../src/agent/intent-contract.js';
import {workerMandate,WORK_COORDINATION_GUIDANCE} from '../src/agent/worker-assignment.js';
import {hostProtocol} from '../src/agent/prompts.js';
import {steerWorkTool} from '../src/tools/intents.js';
import {runContext} from '../src/tools/context.js';
import type {WorkerCorrection} from '../src/agent/worker-correction.js';

if(!process.argv.includes('--run')){console.log('Pass --run to verify configured real models with isolated local sample data.');process.exit(0);}
const out=resolve(process.argv.find(a=>a.startsWith('--out='))?.slice(6)??'../../docs/reviews/evidence/method-correction-'+Date.now());
await mkdir(out,{recursive:false,mode:0o700});
const productionDSN=postgresDSN().dsn,oldDSN=process.env.SERIES_PG_DSN;
const production=new Database(new pg.Pool({connectionString:productionDSN,options:'-c default_transaction_read_only=on'}));
const adminURL=new URL(productionDSN);adminURL.pathname='/postgres';const admin=new pg.Pool({connectionString:adminURL.href});
const databaseName='test_method_correction_'+Date.now(),testURL=new URL(productionDSN);testURL.pathname='/'+databaseName;
const originalFetch=globalThis.fetch,controller=new AbortController(),timer=setTimeout(()=>controller.abort('verification timeout'),240_000);
let db:Database|undefined,created=false,release=()=>{},worker:AgentRunner|undefined,planner:AgentRunner|undefined,work:ReturnType<AgentRunner['prompt']>|undefined;
let phase='worker',request=0;const wires:{phase:string;payload:any}[]=[];
try{
 const profiles=await Promise.all(['planner','worker'].map(async role=>{
  const p=(await resolveModelProfiles(production,0,role)).profiles[0];assert(p&&!p.proxy,'Requires direct model transport');return p;
 }));
 const sources=await Promise.all(profiles.map(p=>buildModelSource({...p,maxTokens:2048})));
 await admin.query(`CREATE DATABASE "${databaseName}"`);created=true;
 process.env.SERIES_PG_DSN=testURL.href;db=await openDatabase();
 const exp=await db.createExploration('local read-only table fixture','read row A');
 const task=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,status) VALUES('local fixture','read row A',$1,'running') RETURNING id",[exp])).rows[0]!.id);
 const contract=normalizeContract({objective:'读取本地样本 A 行的 value',acceptance:['返回样本 A 行的 value'],out_of_scope:['不得修改文件','不得读取其他文件','不得访问网络'],allowed_tools:['parse_fixture']},'读取本地样本');
 const intent=await db.exploration(exp).addNode('intent',{summary:'读取本地样本 A 行的 value',contract},0,'running','method-worker',[]);
 const before=JSON.stringify((await db.exploration(exp).getNode(intent))!.payload.contract);
 const secret=randomUUID();await writeFile(join(out,'sample.csv'),`name;value\nA;${secret}\n`);
 let entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 const separators:string[]=[];
 globalThis.fetch=async(input,init)=>{
  let payload:any;try{payload=JSON.parse(typeof init?.body==='string'?init.body:'');}catch{}
  if(payload?.model&&(payload.messages||payload.input)){
   assert(++request<=12,'Model request budget exceeded');wires.push({phase,payload});
   writeFileSync(join(out,`request-${request}-${phase}.json`),JSON.stringify(payload,null,2),{mode:0o600});
  }
  return originalFetch(input,init);
 };
 worker=await AgentRunner.create({...sources[1]!,cwd:out,agentDir:join(out,'worker-agent'),inMemory:true,signal:controller.signal,maxTurns:6,stopOnFinalResponse:true,
  platform:{role:'worker',taskID:task,policy:{version:'domain-v1',compaction:'native',mcpLoading:'deferred'}},
  systemPrompt:hostProtocol('worker')+workerMandate(intent,{},contract,'[]')+'\n样本只有一个，通过 parse_fixture 读取。先按初始方案用逗号解析；失败时根据新证据调整。',
  toolAllowlist:['parse_fixture'],customTools:[{name:'parse_fixture',label:'Read local sample',description:'只读当前已授权的固定样本。按 separator 分列，返回 A 行的 value；不接受文件路径、网络或写操作。',parameters:{type:'object',additionalProperties:false,properties:{separator:{type:'string',enum:[',',';']}},required:['separator']},
   execute:async(_id,args:any)=>{
    separators.push(args.separator);const raw=await readFile(join(out,'sample.csv'),'utf8');
    if(separators.length===1){entered();await gate;controller.signal.throwIfAborted();}
    if(args.separator!==';')return {isError:true,content:[{type:'text',text:'解析失败：逗号未分列。头部为 name;value，样本是分号分隔；未读取到 A 行 value。'}],details:{}};
    return {content:[{type:'text',text:JSON.stringify({value:raw.trim().split('\n')[1]!.split(';')[1]})}],details:{}};
   }}],
 });
 const handle={turnID:randomUUID(),runner:Promise.resolve(worker),readyRunner:worker,done:new Promise<void>(()=>{}),settled:false};
 const runtime={expID:exp,lease:'isolated',work:new Map([[intent,handle]]),paused:false,stopped:false};
 // Real steering path; synthetic ownership fixture avoids starting a scheduler.
 const engine=Object.assign(Object.create(Engine.prototype),{tasks:new Map([[task,runtime]]),steeringQueues:new Map(),db,coordinator:{assert:async()=>{}}}) as Engine;
 const ctx=runContext(db,task,exp,'planner',{hooks:{steerWork:async(_exp,id,correction,source)=>{await engine.steerWork(task,id,correction,source);}}});
 const tool=steerWorkTool(ctx);
 work=worker.prompt('读取原意图要求的样本值。');void work.catch(()=>{});
 await Promise.race([ready,work.then(()=>{throw Error('Worker finished without reading sample');}),new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('Sample tool timeout')),{once:true}))]);
 assert.equal(separators[0],',');phase='planner';
 planner=await AgentRunner.create({...sources[0]!,cwd:out,agentDir:join(out,'planner-agent'),inMemory:true,signal:controller.signal,maxTurns:4,
  platform:{role:'planner',taskID:task,policy:{version:'domain-v1',compaction:'native',mcpLoading:'deferred'}},
  systemPrompt:hostProtocol('planner')+'\n'+WORK_COORDINATION_GUIDANCE+'\n这是隔离的资料解析任务，无需新增工作；你负责运行中 Worker 的协调。',
  toolAllowlist:['steer_work'],customTools:[tool],
 });
 const plan=await planner.prompt(JSON.stringify({intent_id:intent,state:'running',contract,observation:'Worker 使用 separator="," 解析失败，头部为 name;value，实际是分号分隔。原验收项尚未完成。请根据现状协调当前工作。'}));
 const receipts=(await db.query("SELECT metadata#>'{steering,correction}' correction FROM activity WHERE exploration_id=$1 AND tool='steer_work' ORDER BY id",[exp])).rows;
 assert.equal(receipts.length,1,'Planner must deliver one correction');const correction=receipts[0]!.correction as WorkerCorrection;
 assert.equal(correction.kind,'adjust_method');assert.deepEqual(correction.criterion_indices,[0]);assert.match(correction.method!,/;|分号/);
 await assert.rejects(engine.steerWork(task,intent,{...correction,reason:'相同方法的另一个理由'}),/不重复/);
 (engine as any).steeringQueues=new Map();await assert.rejects(engine.steerWork(task,intent,correction),/不重复/);
 phase='worker';release();const result=await work;
 assert.equal(result.stopReason,'completed');assert(result.lastAssistantText?.includes(secret),'Worker must return actual sample value');assert.deepEqual(separators,[',',';']);
 assert.equal(JSON.stringify((await db.exploration(exp).getNode(intent))!.payload.contract),before);
 const corrected=wires.filter(w=>w.phase==='worker'&&JSON.stringify(w.payload).includes('宿主方法纠偏'));
 assert(corrected.length>0,'Correction missing from next real Worker request');
 for(const {payload} of wires){const names=(payload.tools??[]).map((t:any)=>t.function?.name??t.name);assert.equal(new Set(names).size,names.length,'Duplicate schemas');}
 assert(corrected.every(w=>JSON.stringify(w.payload.tools??[]).includes('parse_fixture')));
 assert(!corrected.some(w=>JSON.stringify(w.payload.tools??[]).includes('bash')),'Correction granted a tool');
 await assert.rejects(engine.steerWork(task,intent,{...correction,method:'按分号逐行读取'}),/收尾或完成/);
 const summary={models:profiles.map((p,i)=>({role:i?'worker':'planner',model:p.model})),requests:request,planner_generated_method_correction:true,
  worker_separators:separators,worker_read_real_value:true,correction_in_actual_worker_request:true,no_duplicate_schema:true,no_new_tool_grants:true,unchanged_contract:true,
  duplicate_and_restored_duplicate_blocked:true,completed_worker_rejects_new_correction:true,isolated_database:databaseName,production_task_writes:false,deployed:false};
 await writeFile(join(out,'results.json'),JSON.stringify({summary,correction,planner_answer:plan.lastAssistantText,worker_answer:result.lastAssistantText},null,2));console.log(JSON.stringify(summary));
}catch(error){await writeFile(join(out,'failure.txt'),error instanceof Error?error.stack??error.message:String(error));throw error;}
finally{
 release();controller.abort();clearTimeout(timer);await work?.catch(()=>{});await planner?.dispose();await worker?.dispose();globalThis.fetch=originalFetch;
 await db?.close();await production.close();if(created)await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);await admin.end();
 if(oldDSN===undefined)delete process.env.SERIES_PG_DSN;else process.env.SERIES_PG_DSN=oldDSN;
}
