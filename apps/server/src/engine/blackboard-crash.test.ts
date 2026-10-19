import {it,expect} from 'vitest';import pg from 'pg';import {fork,type ChildProcess} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
import {openDatabase} from '../db/index.js';
async function until(fn:()=>Promise<boolean>|boolean,ms=12000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw new Error('process recovery timeout');}
it.each(['published','finished'])('survives SIGKILL after %s without losing or replaying observations',async mode=>{
 const name=`fate_bb_crash_${mode}_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-bb-crash-'));
 process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}?sslmode=disable`;const db=await openDatabase();
 let child:ChildProcess|undefined;const processes:ChildProcess[]=[];let ready=false,requests=0,error='';
 const task=await db.tasks().createTaskWithOptions('LOCAL crash fixture','',{executionMode:'manual'}),s=db.exploration(task.exploration_id);
 const intent=await s.addIntent({summary:'Observe one LOCAL sample',dispatch_requested:true},1,[],'user');
 const start=(generation:number)=>{
  child=fork(path.resolve('scripts/blackboard-crash-host.mts'),[],{execArgv:['--import','tsx'],env:{...process.env,FATE_BLACKBOARD_CRASH:JSON.stringify({generation,mode,task:task.id,intent,dir})},stdio:['ignore','ignore','pipe','ipc']});processes.push(child);
  child.stderr?.on('data',data=>{error+=String(data);});child.on('message',(m:any)=>{if(m.type==='kill_ready')ready=true;if(m.type==='request')requests++;});
 };
 try{
  await db.platform().setSetting('workers','1');start(1);await until(()=>ready);
  const fact=(await db.query("SELECT id,payload FROM exploration_nodes WHERE kind='fact' AND payload->>'from_intent'=$1",[String(intent)])).rows[0]!;expect(fact).toBeTruthy();
  expect((await s.getNode(intent))?.state).toBe(mode==='published'?'running':'done');
  const session=path.join(dir,'sessions',`exp${task.exploration_id}-worker-i${intent}.jsonl`),sessionID=JSON.parse(readFileSync(session,'utf8').split('\n')[0]!).id;
  child!.kill('SIGKILL');await until(()=>child!.signalCode==='SIGKILL');
  // Deterministic expiration of the dead executor, never a graceful shutdown.
  await db.query("UPDATE engine_task_leases SET expires_at=now()-interval '1 second' WHERE task_id=$1",[task.id]);
  const before=requests;start(2);
  await until(async()=>!!(await db.query("SELECT 1 FROM blackboard_wakeups WHERE node_id=$1 AND kind='worker_settled'",[intent])).rowCount);
  expect((await s.getNode(intent))?.state).toBe('done');expect(requests-before).toBe(mode==='published'?1:0);
  expect((await db.query("SELECT id FROM exploration_nodes WHERE kind='fact' AND payload->>'from_intent'=$1",[String(intent)])).rows).toHaveLength(1);
  expect((await s.getNode(Number(fact.id)))?.payload.evidence).toBe(fact.payload.evidence);
  expect((await db.query("SELECT 1 FROM activity WHERE node_id=$1 AND kind='result'",[intent])).rowCount).toBe(1);
  expect((await db.query("SELECT 1 FROM blackboard_wakeups WHERE node_id=$1 AND kind='worker_settled'",[intent])).rowCount).toBe(1);
  expect(JSON.parse(readFileSync(session,'utf8').split('\n')[0]!).id).toBe(sessionID);
 }catch(e){throw new Error(String(e)+' '+error.slice(-1500));}
 finally{
  for(const proc of processes)if(proc.exitCode===null&&proc.signalCode===null){if(proc.connected)proc.send('stop');await until(()=>proc.exitCode!==null||proc.signalCode!==null,6000).catch(()=>proc.kill('SIGKILL'));}
  await db.close();const admin=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres?sslmode=disable'});await admin.connect();await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);await admin.end();rmSync(dir,{recursive:true,force:true});
 }
});
