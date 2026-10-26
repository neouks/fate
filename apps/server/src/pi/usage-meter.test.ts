import {beforeAll,afterAll,it,expect} from 'vitest';
import {createServer} from 'node:http';import {once} from 'node:events';import {mkdtemp,readdir,readFile,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import pg from 'pg';
import {openDatabase,type Database} from '../db/index.js';import {aggregateUsage} from '../db/usage-ledger.js';
import {UsageObservation,meterProvider,configureUsageOutbox,replayUsageOutbox} from './usage-meter.js';import {buildModelSource,testProfileConnection} from './providerFromProfile.js';
const name=`fate_meter_${process.pid}`;let db:Database,dir:string;
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;db=await openDatabase();dir=await mkdtemp(path.join(tmpdir(),'fate-meter-'));configureUsageOutbox(db,dir);});
afterAll(async()=>{await db.close();const p=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await p.connect();await p.query(`DROP DATABASE ${name}`);await p.end();await rm(dir,{recursive:true,force:true});});
it('distinguishes missing, partial, real zero and cumulative usage; reasoning is not added twice',()=>{
 const o=new UsageObservation();expect(o.result({input:0,output:0,cacheRead:0,cacheWrite:0})).toMatchObject({_quality:'unknown'});
 o.observe({usage:{completion_tokens:3}},'openai-completions');expect(o.result({input:0,output:3,cacheRead:0,cacheWrite:0})).toMatchObject({_quality:'partial',output:3});
 o.observe({usage:{prompt_tokens:100,completion_tokens:10,prompt_tokens_details:{cached_tokens:80},completion_tokens_details:{reasoning_tokens:5}}},'openai-completions');
 o.observe({usage:{prompt_tokens:100,completion_tokens:10,prompt_tokens_details:{cached_tokens:80}}},'openai-completions');expect(o.result(null)).toMatchObject({_quality:'complete',input:20,output:10,cacheRead:80,totalTokens:110});
 const zero=new UsageObservation();zero.observe({usage:{prompt_tokens:0,completion_tokens:0,prompt_tokens_details:{cached_tokens:0}}},'openai-completions');expect(zero.result(null)).toMatchObject({_quality:'complete',totalTokens:0});expect(new UsageObservation().result(null,true)).toMatchObject({_quality:'not_sent'});
 const a=new UsageObservation();a.observe({message:{usage:{input_tokens:5,output_tokens:1,cache_read_input_tokens:9,cache_creation_input_tokens:2}}},'anthropic-messages');a.observe({usage:{output_tokens:4}},'anthropic-messages');expect(a.result(null)).toMatchObject({input:5,cacheRead:9,cacheWrite:2,output:4,totalTokens:20});
});
async function fixture(format:string,streaming:boolean,usage:any,run:(source:any,profile:any)=>Promise<void>){
 let requests=0;
 const server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const payload=JSON.parse(raw);requests++;
  let data:any;
  if(format==='anthropic')data={id:'msg-local',type:'message',model:'fixture',role:'assistant',content:[{type:'text',text:'pong'}],stop_reason:'end_turn',stop_sequence:null,usage};
  else if(format==='openai-responses')data={id:'resp-local',object:'response',model:'fixture',status:'completed',output:[{id:'msg_1',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'pong',annotations:[]}]}],usage};
  else data={id:'chat-local',object:'chat.completion',model:'fixture',choices:[{index:0,message:{role:'assistant',content:'pong'},finish_reason:'stop'}],usage};
  if(payload.stream){res.setHeader('content-type','text/event-stream');res.end(`data: ${JSON.stringify({...data,choices:[{index:0,delta:{role:'assistant',content:'pong'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);}
  else{res.setHeader('content-type','application/json');res.end(JSON.stringify(data));}
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const profile={id:0,name:'LOCAL diagnostic',model:'fixture',baseURL:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,apiKey:'local-fixture',contextWindowK:128,maxTokens:128,format,streaming};await run(await buildModelSource(profile),profile);return requests;}
 finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
it.each(['openai','anthropic','openai-responses'])('captures native nonstream %s once, with real cache semantics and diagnostics',async format=>{
 const u=format==='anthropic'?{input_tokens:20,output_tokens:10,cache_read_input_tokens:80,cache_creation_input_tokens:0}:format==='openai-responses'?{input_tokens:100,output_tokens:10,input_tokens_details:{cached_tokens:80}}:{prompt_tokens:100,completion_tokens:10,prompt_tokens_details:{cached_tokens:80}};
 const before=(await aggregateUsage(db))[0]!;
 expect(await fixture(format,false,u,async(_,p)=>{expect((await testProfileConnection(p,db)).ok).toBe(true);})).toBe(1);
 const after=(await aggregateUsage(db))[0]!;expect(after.calls-before.calls).toBe(1);expect(after.input_tokens-before.input_tokens).toBe(100);expect(after.output_tokens-before.output_tokens).toBe(10);expect(after.cache_read_tokens-before.cache_read_tokens).toBe(80);
});
it.each([undefined,{completion_tokens:4},{prompt_tokens:0,completion_tokens:0,prompt_tokens_details:{cached_tokens:0}}])('does not turn wire usage %j into a fabricated zero',async usage=>{
 await fixture('openai',true,usage,async(source)=>{
  const task=await db.tasks().createTaskWithOptions('LOCAL partial usage','',{executionMode:'manual'});
  const provider=source.modelRuntime.getProvider(source.model.provider)!;
  await source.modelRuntime.registerNativeProvider(meterProvider(db,provider,{id:0,name:'LOCAL',model:'fixture'},()=>({taskID:task.id,role:'worker',purpose:'conversation'})));
  await source.modelRuntime.completeSimple(source.model,{messages:[{role:'user',content:'ping',timestamp:Date.now()}]});
  const total=(await aggregateUsage(db,{taskID:task.id}))[0]!;expect(total.calls).toBe(1);expect(total.usage_complete).toBe(!!usage&&'prompt_tokens' in usage);expect(total.output_tokens).toBe(usage?.completion_tokens??0);
 });
});
it('keeps per-request receipts on DB failure, replays idempotently after log deletion and rejects stale snapshots',async()=>{
 const task=await db.tasks().createTaskWithOptions('LOCAL outbox','',{executionMode:'manual'});const original=db.transaction.bind(db);let failed=false;
 try{await fixture('openai',true,{prompt_tokens:100,completion_tokens:10,prompt_tokens_details:{cached_tokens:80}},async(source)=>{
  const provider=source.modelRuntime.getProvider(source.model.provider)!;
  await source.modelRuntime.registerNativeProvider(meterProvider(db,provider,{id:0,name:'LOCAL',model:'fixture'},()=>({taskID:task.id,mainSegment:2,turnID:'LOCAL-turn',role:'mainagent',purpose:'conversation'})));
  db.transaction=(async fn=>{if(failed)throw new Error('LOCAL database unavailable');const result=await original(fn);failed=true;return result;}) as typeof db.transaction;
  const result=await source.modelRuntime.completeSimple(source.model,{messages:[{role:'user',content:'ping',timestamp:Date.now()}]});expect(result.stopReason).toBe('stop');
 });}finally{db.transaction=original;}
 const files=await readdir(path.join(dir,'usage-outbox'));expect(files).toHaveLength(1);const receipt=JSON.parse(await readFile(path.join(dir,'usage-outbox',files[0]!), 'utf8'));expect(JSON.stringify(receipt)).not.toMatch(/ping|pong|local-fixture/);
 await db.query('DELETE FROM llm_request_attempts WHERE task_id=$1',[task.id]);expect(await replayUsageOutbox(db)).toBe(0);expect(await replayUsageOutbox(db)).toBe(0);
 expect((await aggregateUsage(db,{taskID:task.id}))[0]).toMatchObject({calls:1,input_tokens:100,output_tokens:10,usage_complete:true});
 await writeFile(path.join(dir,'usage-outbox',files[0]!),JSON.stringify({...receipt,status:'running',finishedAt:null,usage:{...receipt.usage,input:1,output:0,_receipt_seq:1}}));await replayUsageOutbox(db);
 expect((await aggregateUsage(db,{taskID:task.id}))[0]).toMatchObject({input_tokens:100,output_tokens:10,pending_calls:0});expect((await db.query('SELECT 1 FROM llm_request_attempts WHERE task_id=$1',[task.id])).rowCount).toBe(0);
});

it('recovers a fsynced receipt after SIGKILL without replaying the provider request',async()=>{
 const {spawn}=await import('node:child_process');const task=await db.tasks().createTaskWithOptions('LOCAL killed metering process','',{executionMode:'manual'});
 const requests=await fixture('openai',true,{prompt_tokens:100,completion_tokens:10,prompt_tokens_details:{cached_tokens:80}},async(_,profile)=>{
  const script=`import {openDatabase} from './src/db/index.ts';import {buildModelSource} from './src/pi/providerFromProfile.ts';import {meterProvider,configureUsageOutbox} from './src/pi/usage-meter.ts';
   const db=await openDatabase();configureUsageOutbox(db,${JSON.stringify(dir)});const source=await buildModelSource(${JSON.stringify(profile)});
   await source.modelRuntime.registerNativeProvider(meterProvider(db,source.modelRuntime.getProvider(source.model.provider),{id:0,name:'LOCAL',model:'fixture'},()=>({taskID:${task.id},role:'worker',purpose:'conversation'})));
   const original=db.transaction.bind(db);let first=true;db.transaction=async f=>{if(!first)throw new Error('LOCAL injected DB outage');first=false;return original(f);};
   await source.modelRuntime.completeSimple(source.model,{messages:[{role:'user',content:'ping',timestamp:Date.now()}]});process.stdout.write('RECEIPT_READY');await new Promise(()=>{});`;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:process.cwd(),env:{...process.env},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',c=>{stderr+=c;});
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Child receipt timed out '+stderr));},15000);child.stdout.on('data',data=>{if(String(data).includes('RECEIPT_READY')){clearTimeout(timer);resolve();}});child.on('exit',()=>{clearTimeout(timer);reject(new Error('Child exited before receipt '+stderr));});});
  const ended=once(child,'exit');child.kill('SIGKILL');await ended;
 });expect(requests).toBe(1);
 expect((await aggregateUsage(db,{taskID:task.id}))[0]).toMatchObject({calls:1,usage_complete:false});
 expect(await replayUsageOutbox(db)).toBe(0);expect((await aggregateUsage(db,{taskID:task.id}))[0]).toMatchObject({calls:1,input_tokens:100,output_tokens:10,usage_complete:true});
 expect(await replayUsageOutbox(db)).toBe(0);
});
