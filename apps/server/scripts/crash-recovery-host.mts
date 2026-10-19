// Isolated subprocess used by the real crash probe. Parent owns durable request
// metering; no model request leaves this process before the ledger acknowledges it.
import {Database} from '../src/db/index.js';
import pg from 'pg';
import {Engine,defaultEngineConfig} from '../src/engine/engine.js';
import {makeModelResolver} from '../src/pi/modelResolver.js';
import {configureAgentEnv} from '../src/agent/roles.js';
import {configureEvidenceStore} from '../src/evidence/blobs.js';
import {buildApp} from '../src/http/app.js';
import {AgentRunner} from '../src/pi/runner.js';
import path from 'node:path';
const config=JSON.parse(process.env.FATE_CRASH_HOST!);
const db=new Database(new pg.Pool({connectionString:process.env.SERIES_PG_DSN}));
const send=(value:unknown)=>process.send?.(value);
const approvals=new Map<number,(allowed:boolean)=>void>();let requestID=0,blocked=false;
process.on('message',(m:any)=>{if(m.type==='request_ack'){approvals.get(m.id)?.(m.allowed);approvals.delete(m.id);}});
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
 if(url.origin===config.fixture){if((init?.method??'GET')!=='GET')throw Error('fixture allows only GET');return originalFetch(input,init);}
 if(url.protocol!=='https:'||url.hostname!=='api.deepseek.com')throw Error('non-fixture target denied');
 const body=typeof init?.body==='string'?JSON.parse(init.body):{},names=(body.tools??[]).map((t:any)=>t.function.name);
 const role=names.includes('complete_intent')?'worker':names.includes('record_plan_decision')?'planner':names.includes('set_goals')?'goals':'compaction';
 const task=(await db.query('SELECT id,exploration_id FROM tasks ORDER BY id DESC LIMIT 1')).rows[0];
 const intent=role==='worker'?(await db.query("SELECT * FROM exploration_nodes WHERE exploration_id=$1 AND kind='intent' AND state='running' ORDER BY id LIMIT 1",[task?.exploration_id])).rows[0]:undefined;
 const facts=intent?(await db.query("SELECT * FROM exploration_nodes WHERE exploration_id=$1 AND kind='fact' AND state='confirmed' AND payload->>'from_intent'=$2 ORDER BY id",[task.exploration_id,String(intent.id)])).rows:[];
 const texts=(body.messages??[]).flatMap((m:any)=>typeof m.content==='string'?[m.content]:(m.content??[]).flatMap((part:any)=>typeof part.text==='string'?[part.text]:[]));
 const messages=texts.join('\n'),id=++requestID;
 const approved=new Promise<boolean>(resolve=>approvals.set(id,resolve));
 send({type:'request',id,pid:process.pid,generation:config.generation,role,task_id:Number(task?.id),intent_id:intent?Number(intent.id):undefined,bytes:Buffer.byteLength(JSON.stringify(body)),tools:names,
  recovered_context:config.generation>1&&intent?{has_prior_fact:!!facts.length&&facts.every(n=>messages.includes(String(n.payload.summary))||messages.includes(JSON.stringify(n.payload.summary))),has_recovery:messages.includes('executor_recovered')}:undefined});
 if(!await approved)throw Error('shared physical request budget exhausted');
 try{
  const response=await originalFetch(input,init);send({type:'headers',id,status:response.status});
  if(config.generation===1&&!blocked&&role==='worker'&&facts.length&&!intent.payload.execution_result&&response.ok){
   blocked=true;send({type:'kill_ready',pid:process.pid,intent_id:Number(intent.id),fact_ids:facts.map(n=>Number(n.id)),request_id:id});
   await new Promise(()=>{}); // Intentionally killed, never gracefully resumed.
  }
  return response;
 }catch(e){send({type:'request_error',id,error:String(e).replace(/(?:Bearer\s+|\bsk-)[\w.-]+/gi,'[redacted]')});throw e;}
};
const originalPrompt=AgentRunner.prototype.prompt;
AgentRunner.prototype.prompt=async function(...args){const p=(this as any).opts.platform;try{const result=await originalPrompt.apply(this,args);send({type:'runner',role:p?.role,task_id:p?.taskID,stopReason:result.stopReason,aborted:result.aborted,usage:result.usage});return result;}catch(e){send({type:'runner',role:p?.role,task_id:p?.taskID,error:String(e).replace(/(?:Bearer\s+|\bsk-)[\w.-]+/gi,'[redacted]')});throw e;}};
configureEvidenceStore(db,config.dir);configureAgentEnv({skillsDir:path.join(config.dir,'skills')});
const engine=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:150},makeModelResolver(db),config.dir);
const app=buildApp({version:'crash-recovery-acceptance',startedAt:Date.now(),db,engine,jwtKey:config.jwt,skillsRoot:path.join(config.dir,'skills'),dataDir:config.dir});
const base=await app.listen({host:'127.0.0.1',port:0});engine.startScheduler();send({type:'ready',base,pid:process.pid});
let closing=false;
process.on('message',async(m:any)=>{if(m.type==='shutdown'&&!closing){closing=true;await engine.shutdown();await app.close();await db.close();process.exit(0);}});
process.on('disconnect',()=>{if(!closing)process.exit(2);});
