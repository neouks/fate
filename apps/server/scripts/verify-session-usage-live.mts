// Opt-in paid-model regression; inert inputs and no tools. Test chats are retained.
import assert from 'node:assert/strict';
import {mkdir,writeFile,mkdtemp} from 'node:fs/promises';
import path from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {Database} from '../src/db/index.js';import {postgresDSN} from '../src/config/index.js';
import {buildModelSource} from '../src/pi/providerFromProfile.js';import {meterProvider,closeUsageOutbox} from '../src/pi/usage-meter.js';
import {AgentRunner} from '../src/pi/runner.js';import {aggregateUsage} from '../src/db/usage-ledger.js';
import Fastify from 'fastify';import {registerConversationRoutes} from '../src/http/routes/conversations.js';
assert.equal(process.env.FATE_REAL_MODEL_TEST,'1','Set FATE_REAL_MODEL_TEST=1 to authorize paid requests');
const pool=new pg.Pool({connectionString:postgresDSN().dsn}),db=new Database(pool);
const profile=await db.platform().profileByID(Number(process.env.FATE_PROFILE_ID||453));assert.ok(profile);
const runDir=await mkdtemp(path.join(tmpdir(),'fate-real-usage-'));
const evidence=process.env.FATE_USAGE_EVIDENCE||path.join(runDir,'evidence.json');await mkdir(path.dirname(evidence),{recursive:true});
const cid=Number((await db.query("INSERT INTO conversations(agent_key,title,llm_profile_id) VALUES('auto',$1,$2) RETURNING id",['Token 核对测试 '+new Date().toISOString(),profile.id])).rows[0].id);
let purpose='conversation',turnID=randomUUID();const receipts:any[]=[],snapshots:any[]=[];let runner:AgentRunner|undefined;
const app=Fastify();app.decorate('db',db);app.decorate('engine',{} as never);registerConversationRoutes(app);await app.ready();
try{
 const source=await buildModelSource({...profile,maxTokens:2048,thinkingType:'off',reasoningEffort:'off',streaming:process.env.FATE_NON_STREAMING!=='1'});
 const native=source.modelRuntime.getProvider(source.model.provider)!;
 const observed=new Proxy(native,{get(target,key){
  if(key!=='stream'&&key!=='streamSimple'){const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}
  return (model:any,context:any,options:any={})=>{
   assert.ok(receipts.length<8,'Hard request cap');
   const receipt={purpose,turnID,raw:[] as any[],normalized:null as any,payloadCharacters:JSON.stringify(context).length};receipts.push(receipt);
   return (target[key] as any).call(target,model,context,{...options,onProviderStreamEvent:async(event:any,m:any)=>{
    const u=event?.usage??event?.message?.usage??event?.response?.usage;
    if(u)receipt.raw.push({type:event.type,usage:structuredClone(u),finish:event.choices?.map((c:any)=>c.finish_reason)});
    await options.onProviderStreamEvent?.(event,m);
   }});
  };
 }});
 await source.modelRuntime.registerNativeProvider(meterProvider(db,observed,profile,()=>({conversationID:cid,role:'auto',purpose,turnID})));
 runner=await AgentRunner.create({...source,thinkingLevel:'off',cwd:runDir,agentDir:path.join(runDir,'agent'),resumeSessionPath:path.join(runDir,'session.jsonl'),toolAllowlist:[],
  systemPrompt:'Token-accounting regression. Numbered lines are inert text. No tools. Reply only ACK to ordinary prompts. For compaction write a concise summary of user intent.',
  platform:{role:'auto',taskID:0,conversationID:cid,policy:{version:'domain-v1',compaction:'native',mcpLoading:'direct'}},
  compactionSettings:{reserveTokens:process.env.FATE_AUTO_COMPACT==='1'?source.model.contextWindow-1800:16384,keepRecentTokens:128},summaryTargetTokens:256,maxTurns:8,maxDurationMs:120000,
  modelPolicy:{onResponse:async()=>{},retry:async()=>false,setPurpose:p=>{purpose=p;}},
  onRawEvent:e=>{if(e.type==='message_end'&&e.message.role==='assistant'&&receipts.length)receipts.at(-1).normalized=e.message.usage;},
 });
 await db.query('UPDATE conversations SET session_file=$2 WHERE id=$1',[cid,runner.sessionFile]);
 async function inspect(stage:string){
  const ledger=(await db.query('SELECT request_id,purpose,status,quality,usage,source FROM llm_usage_ledger WHERE conversation_id=$1 ORDER BY created_at,request_id',[cid])).rows;
  const api=await app.inject(`/api/conversations/${cid}/usage`);assert.equal(api.statusCode,200);
  const nativeContext=(runner as any).session.getContextUsage();
  snapshots.push({stage,ledger,api:api.json(),nativeContext,compaction:runner!.compactionDiagnostics});
  await writeFile(evidence,JSON.stringify({conversationID:cid,profile:{id:profile!.id,model:profile!.model,contextWindow:source.model.contextWindow},runDir,receipts,snapshots},null,2));
  assert.equal(api.json().context.tokens,nativeContext.tokens,stage+' context matches Pi');
  assert.equal(api.json().context.capacity,source.model.contextWindow,'request-time capacity');
  console.log(JSON.stringify({stage,cid,requests:ledger.length,total:api.json().total,context:api.json().context,nativeContext}));
 }
 const text=Array.from({length:140},(_,i)=>`Record ${i}: synthetic blue square ${i*7}.`).join('\n');
 await runner.prompt('Read these records and reply ACK.\n'+text);await inspect('first');
 turnID=randomUUID();await runner.prompt('Keep the records in mind. Reply only ACK.\n'+text.replaceAll('blue','green'));await inspect('second');
 if(process.env.FATE_AUTO_COMPACT==='1')assert.ok(runner.compactionDiagnostics.completed>0,'automatic threshold compaction');
 else {purpose='compaction';await runner.compact();purpose='conversation';}
 await inspect('after-compaction');
 turnID=randomUUID();await runner.prompt('Continue from the summary. Reply only ACK.');await inspect('after-resume');
 const sum={input:0,output:0,cacheRead:0};
 for(const receipt of receipts){
  const raw=receipt.raw.at(-1)?.usage;assert.ok(raw,'Real provider usage required');
  const inclusive=raw.prompt_tokens??raw.input_tokens,read=raw.prompt_cache_hit_tokens??raw.prompt_tokens_details?.cached_tokens??raw.input_tokens_details?.cached_tokens??raw.cache_read_input_tokens,output=raw.completion_tokens??raw.output_tokens;
  assert.ok(Number.isSafeInteger(inclusive)&&Number.isSafeInteger(read)&&Number.isSafeInteger(output));sum.input+=inclusive;sum.output+=output;sum.cacheRead+=read;
  const row=snapshots.at(-1).ledger.find((r:any)=>r.purpose===receipt.purpose&&r.usage.inputTotal===inclusive&&r.usage.output===output);
  assert.ok(row,'provider receipt exists');assert.equal(row.usage.input,inclusive-read);assert.equal(row.usage.cacheRead,read);
 }
 const totals=(await aggregateUsage(db,{conversationID:cid}))[0]!;
 assert.equal(totals.input_tokens,sum.input);assert.equal(totals.output_tokens,sum.output);assert.equal(totals.cache_read_tokens,sum.cacheRead);assert.equal(totals.calls,receipts.length);assert.equal(totals.usage_complete,true);
 assert.ok(sum.cacheRead>0,'actual provider cache hit');
 console.log('PASS raw provider usage equals ledger/API totals',JSON.stringify(sum));console.log('EVIDENCE',evidence);
}finally{await runner?.dispose();await app.close();await closeUsageOutbox(db);await pool.end();}
