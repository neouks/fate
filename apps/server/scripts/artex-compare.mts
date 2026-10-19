import {pathToFileURL} from 'node:url';import path from 'node:path';import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import pg from 'pg';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';import {ModelRuntime} from '@earendil-works/pi-coding-agent';
const baseline=process.env.FATE_BASELINE;if(!baseline)throw new Error('FATE_BASELINE must identify a saved pre-change source snapshot');
const output=[];
for(const [label,root] of [['before',path.join(baseline,'apps/server')],['after',process.cwd()]]){
 const dbname=`fate_artex_measure_${label}_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'artex-measure-'));
 process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${dbname}?sslmode=disable`;
 const {openDatabase}=await import(pathToFileURL(path.join(root,'src/db/index.ts')).href),roles=await import(pathToFileURL(path.join(root,'src/agent/roles.ts')).href),{TodoStore}=await import(pathToFileURL(path.join(root,'src/tools/context.ts')).href);
 const db=await openDatabase();
 try{
  const task=await db.tasks().createTaskWithOptions('LOCAL identical measurement','Return a concise LOCAL summary',{executionMode:'managed'}),s=db.exploration(task.exploration_id);
  for(const role of ['planner','worker','mainagent']){
   const f=fauxProvider({provider:`measure-${label}-${role}`}),runtime=await ModelRuntime.create({refreshOnCreate:false});await runtime.registerNativeProvider(f.provider);
   const messageBytes:number[]=[];
   f.setResponses([ctx=>{messageBytes.push(Buffer.byteLength(JSON.stringify(ctx.messages)));return fauxAssistantMessage('LOCAL execution completed; no new findings.');},ctx=>{messageBytes.push(Buffer.byteLength(JSON.stringify(ctx.messages)));return fauxAssistantMessage([fauxToolCall('record_plan_decision',{status:'exhausted',reason:'LOCAL execution completed',basis_ids:[],resume_when:'new user request'})]);}]);
   const shared={db,taskID:task.id,expID:task.exploration_id,model:{modelRuntime:runtime,model:f.getModel()},dataDir:dir,maxTurns:4,hooks:{},onActivity:()=>{}};
   if(role==='planner')await roles.runPlannerRound({...shared,goal:task.goal,todos:new TodoStore(db),triggersText:'LOCAL fixture'});
   else if(role==='mainagent')await roles.runMainChat({...shared,goal:task.goal,message:'Summarize LOCAL execution'});
   else {const id=await s.addIntent({summary:'Return a concise LOCAL summary'},5,[],'user');await s.claimNextWorker('measure');await roles.runWorkerIntent({...shared,intent:{id},workerName:'measure',maxDurationMs:20000});}
   const r=(await db.query('SELECT effective FROM runtime_role_configs WHERE task_id=$1 AND role=$2 ORDER BY started_at DESC LIMIT 1',[task.id,role])).rows[0].effective;
   output.push({version:label,role,model_requests:f.state.callCount,faux_message_utf8_bytes:messageBytes,total_faux_message_utf8_bytes:messageBytes.reduce((a,b)=>a+b,0),default_tools:r.active_tools?.length,tools:r.active_tools,prompt_diagnostics:r.prompt_diagnostics,first_request_size:r.first_request_size});
  }
 }finally{await db.close();const admin=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await admin.connect();await admin.query(`DROP DATABASE ${dbname}`);await admin.end();rmSync(dir,{recursive:true,force:true});}
}
const dest=path.resolve('../../docs/reviews/evidence/artex-alignment-20261019');mkdirSync(dest,{recursive:true});writeFileSync(path.join(dest,'comparison.json'),JSON.stringify(output,null,2));console.log(JSON.stringify(output.map(({prompt_diagnostics,tools,first_request_size,...rest})=>({...rest,prompt_diagnostics,first_request_size})),null,2));
