/** Real model, native automatic compaction and disk recovery; business tools are mocks. */
import {mkdir,readFile,writeFile,appendFile,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {SettingsManager,type ToolDefinition,type ExtensionFactory} from '@earendil-works/pi-coding-agent';
import {Database} from '../src/db/index.js';
import {postgresDSN} from '../src/config/index.js';
import {AgentRunner,type AgentRunnerOptions} from '../src/pi/runner.js';
import {buildModelSource,describeModelError} from '../src/pi/providerFromProfile.js';
import {toolLoadout,compactToolSchema} from '../src/agent/tool-loading.js';
import {roleDefinitions} from '../src/agent/tool-catalog.js';
import {TOOL_ALIASES} from '../src/agent/tool-registry.js';
import {roleContextPolicy} from '../src/agent/context-policy.js';
import {CONTEXT_RETENTION_RULES} from '../src/agent/context-needs.js';
import {PLANNER_COMPACTION_RULES} from '../src/agent/planner-memory.js';
import {applyToolBindings} from '../src/agent/tool-bindings.js';

type Role='planner'|'worker';type Arm='deferred'|'resident';
const args=new Map(process.argv.slice(2).map(a=>{const[k,...v]=a.split('=');return[k!,v.join('=')];}));
const production=args.has('--production');
const resumeFrom=args.get('--resume-from')?resolve(args.get('--resume-from')!):undefined;
if(resumeFrom&&!production)throw new Error('resume-from is only supported for production-threshold calibration');
const repeats=Number(args.get('--repeats')||(production?1:2)),roles=(args.get('--roles')||'planner,worker').split(',') as Role[],arms=(args.get('--arms')||(production?'resident':'deferred,resident')).split(',') as Arm[];
if(!Number.isInteger(repeats)||repeats<1||repeats>2||roles.some(r=>!['planner','worker'].includes(r))||arms.some(a=>!['deferred','resident'].includes(a)))throw new Error('Invalid bounded options');
const maxRequests=40,timeoutMs=300_000,threshold=12288;
const output=resolve(args.get('--out')||join('artifacts','role-compaction-'+Date.now()));
const plan={roles,arms,repeats,max_requests_per_run:maxRequests,timeout_ms:timeoutMs,working_set_threshold:threshold,model_output_limit:8192,
  method:'Current production AgentRunner, automatic native compaction (no manual compact call), real summary model requests included. Three complete long synthetic history user messages and real model acknowledgements, idle turns, version-2 read/write after compaction, dispose/reopen identical JSONL, version-3 read/write. Baseline defers frequent tools; current uses production role loadout. Role-specific retention rules and permissions applied. Historical documents are provided in full as conversation messages, avoiding a mock pagination contract.',
  safety:'Read-only model configuration lookup; all business tool implementations mocked; no target traffic or business DB writes.',
  limitations:'Test-only 12288-token working-set threshold; no production configuration changes. Synthetic role prompts, no real Planner dispatch or Worker target execution. No fixed random seed or cache reset.'};
if(production)Object.assign(plan,{working_set_threshold:'resolved from production settings and SDK defaults',model_output_limit:'production profile value',
  method:'Current production role threshold settings, model capacity, output configuration and tool bindings. Large deterministic synthetic historical host-context messages are appended to the native transcript without LLM generation, then the unmodified native automatic compactor is triggered by an ordinary prompt. Real summaries and all continuation requests are metered. Verify fresh evidence after compaction and disk restore; no manual compact call.',
  limitations:'Production threshold and native 60-second summary deadline are unchanged. Historical context is synthetic host input, not millions of tokens of prior real-model dialogue. Business tools are mocked; full production task scheduling and completion guards are not reproduced. SDK threshold checks use provider context usage when available; actual usage is recorded separately from history-size estimates.'});
if(!args.has('--run')){console.log(JSON.stringify(plan,null,2));process.exit(0);}
await mkdir(resolve(output,'..'),{recursive:true});await mkdir(output);
const pool=new pg.Pool({connectionString:postgresDSN().dsn,options:'-c default_transaction_read_only=on -c statement_timeout=10000'});
const configured:Partial<Record<Role,string|null>>={},profileBindings:Partial<Record<Role,number|null>>={},boundTools:Partial<Record<Role,ToolDefinition[]>>={};
let profile;try{
  const db=new Database(pool);profile=await db.platform().activeProfile();
  if(production)for(const role of roles){
    configured[role]=await db.platform().getSetting(role+'_context_budget_tokens');
    profileBindings[role]=(await db.platform().getAgentByKey(role))?.llmProfileID??null;
    if(profileBindings[role]&&profileBindings[role]!==profile?.id)throw new Error('Role has a separate model profile; run with a role-specific harness rather than silently using the global model');
    boundTools[role]=await applyToolBindings(db,role,roleDefinitions(db,role).filter(t=>!TOOL_ALIASES[t.name]));
  }
}finally{await pool.end();}
if(!profile?.apiKey)throw new Error('No model profile');
const source=await buildModelSource(production?profile:{...profile,maxTokens:8192});
const sdkDefaults=SettingsManager.inMemory({}).getCompactionSettings(source.model);
const policies=Object.fromEntries(roles.map(role=>[role,roleContextPolicy(role,source.model.contextWindow,production?configured[role]:String(threshold))])) as Record<Role,ReturnType<typeof roleContextPolicy>>;
const resolvedPolicies=Object.fromEntries(roles.map(role=>{
  const policy=policies[role],settings={...sdkDefaults,...policy.compactionSettings};
  return [role,{configured:configured[role],profile_binding:profileBindings[role],policy,settings,effective_threshold:source.model.contextWindow-settings.reserveTokens}];
}));
const hash=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
const sourceFiles=['scripts/evaluate-role-compaction.mts','src/pi/runner.ts','src/pi/native-compaction.ts','src/pi/tool-declaration-window.ts','src/pi/tool-discovery.ts','src/pi/platform-mcp.ts','src/agent/tool-loading.ts','src/agent/tool-registry.ts','src/agent/tool-bindings.ts','src/agent/context-policy.ts','src/agent/context-needs.ts','src/agent/planner-memory.ts'];
const hashes:Record<string,string>={};
for(const file of sourceFiles){const data=await readFile(file);hashes[file]=hash(data);const dest=join(output,'source-snapshot',file);await mkdir(resolve(dest,'..'),{recursive:true});await writeFile(dest,data);}
const manifest={...plan,production,resume_from:resumeFrom,resolved_policies:resolvedPolicies,model:{id:profile.id,name:profile.name,model:profile.model,thinking:source.thinkingLevel,context_window:source.model.contextWindow,max_output_tokens:production?profile.maxTokens:8192},source_hashes:hashes,started_at:new Date().toISOString()};
if(resumeFrom){const previous=JSON.parse(await readFile(join(resumeFrom,'manifest.json'),'utf8'));if(previous.model.id!==profile.id||previous.model.context_window!==source.model.contextWindow||JSON.stringify(previous.resolved_policies)!==JSON.stringify(resolvedPolicies))throw new Error('Production settings changed; cannot silently continue a different threshold/model test');}
await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2));
const bases=Object.fromEntries(roles.map(role=>[role,(production?boundTools[role]!:roleDefinitions({} as Database,role).filter(t=>!TOOL_ALIASES[t.name])).map(compactToolSchema)])) as Record<Role,ToolDefinition[]>;
await writeFile(join(output,'tool-schemas.json'),JSON.stringify(Object.fromEntries(roles.map(role=>[role,bases[role].map(({name,description,parameters})=>({name,description,parameters}))])),null,2));
const history=Array.from({length:3},(_,block)=>`ARCHIVE_BLOCK_${block+1}: Synthetic historical log, not current product evidence.\n`+Array.from({length:240},(_,i)=>`Archive ${block+1}.${i}: component=fixture; status=reviewed; checksum=${hash(`${block}:${i}`).slice(0,16)}; note=historical synthetic observation, never current product evidence.`).join('\n'));
await writeFile(join(output,'history-fixtures.json'),JSON.stringify(history));
console.log(JSON.stringify({event:'start',output,model:manifest.model,runs:roles.length*arms.length*repeats}));

function fixture(role:Role,label:string,prior?:{reads:number[];writes:any[]}){
  let version=1;const reads:number[]=[...prior?.reads??[]],writes:any[]=[...prior?.writes??[]];
  const products=()=>({database:`CedarDB 8.${version}`,middleware:`OrchidAS 2.${version}.0`});
  const receipt=()=>`SYNTHETIC-${label}-V${version}`;
  const result=(body:unknown,isError=false)=>({content:[{type:'text' as const,text:JSON.stringify(body)}],details:{},...(isError?{isError:true}:{})});
  const tools=bases[role].map(t=>({...t,execute:async(_id:string,input:any)=>{
    if(t.name==='context_get'){
      const items=[];
      for(const item of input.items??[]){
        if(item.ref==='node:101'){reads.push(version);const p=products();items.push({ref:item.ref,version,view:'detail',content:JSON.stringify({...p,evidence:`${receipt()}: database=${p.database}; middleware=${p.middleware}`})});}
        else return result({error:'Only node:101 is a graph fixture; historical documents were provided in conversation messages'},true);
      }
      return items.length?result({items}):result({error:'items required'},true);
    }
    if(t.name==='graph_overview')return result({nodes:[{id:101,kind:'fact',version,summary:'Current synthetic evidence'}]});
    if(t.name==='context_search')return result({items:[{ref:'node:101',version,summary:'Current synthetic evidence'}]});
    if(t.name==='record_fact'){
      const facts=input.facts??[input];
      if(!reads.includes(version)||facts.some((f:any)=>!String(f.evidence??'').includes(receipt())))return result({error:'Read current evidence and retain its exact receipt'},true);
      writes.push(...facts.map((fact:any)=>({version,fact})));return result({saved:facts.length,facts:[{fact_id:200+writes.length,saved:true}]});
    }
    return result({error:'Unused fixture; no external operation performed'},true);
  }} as ToolDefinition));
  return {tools,setVersion:(v:number)=>{version=v;},judge:(final:string)=>{const p=products();return {version,reads:[...reads],writes:[...writes],
    success:reads.includes(version)&&(role==='planner'?[p.database,p.middleware,receipt()].every(s=>final.includes(s)):writes.some(w=>w.version===version&&[p.database,p.middleware].every(s=>(String(w.fact.summary??'')+' '+String(w.fact.detail??'')).includes(s))))};}};
}
function loadout(role:Role,arm:Arm,tools:ToolDefinition[]){
  const conf=toolLoadout(role,{customTools:tools,toolAllowlist:tools.map(t=>t.name)});
  if(arm==='resident')return conf;
  const initialActive=conf.toolLoading.initialActive.filter(n=>!['context_get','record_fact'].includes(n));
  const deferred=conf.toolAllowlist.filter(n=>!initialActive.includes(n));
  return {...conf,customTools:conf.customTools.map(t=>({...t,exposure:deferred.includes(t.name)?'deferred' as const:undefined})),toolLoading:{...conf.toolLoading,initialActive,deferred}};
}
const runs:any[]=[];
async function execute(role:Role,arm:Arm,rep:number){
  const id=`${role}-${rep+1}-${arm}`,dir=join(output,id);await mkdir(dir);const file=join(dir,'session.jsonl');
  const prior=resumeFrom?JSON.parse(await readFile(join(resumeFrom,id,'result.json'),'utf8')):undefined;
  if(prior){if(prior.role!==role||prior.arm!==arm||prior.health.some((h:any)=>h.completed))throw new Error('Only uncompressed matching calibration sessions can be continued');await copyFile(join(resumeFrom!,id,'session.jsonl'),file);}
  const inheritedWarmup=prior?.checkpoints.find((c:any)=>c.stage==='warmup');
  const f=fixture(role,`${role}-${rep+1}`,inheritedWarmup?.judge),conf=loadout(role,arm,f.tools),policy=policies[role];
  const hot=role==='planner'?['context_get','graph_overview']:['context_get','record_fact'];
  const requests:any[]=[],responses:any[]=[],events:any[]=[],checkpoints:any[]=[],health:any[]=[];
  let stage='warmup',purpose='conversation',lastText='',error:string|null=null,timedOut=false,runner:AgentRunner|undefined;
  const instrumentation:ExtensionFactory=api=>{
    api.on('before_provider_request',(event,ctx)=>{
      if(requests.length>=maxRequests){ctx.abort();throw new Error('Evaluation request cap');}
      const payload=event.payload as any,raw=JSON.stringify(payload);
      requests.push({stage,purpose:'conversation',bytes:Buffer.byteLength(raw),tools:(payload.tools??[]).map((t:any)=>t.function?.name??t.name),
        original_history_present:history.map(doc=>raw.includes(JSON.stringify(doc.slice(0,500)).slice(1,-1)))});
    });
  };
  const options:AgentRunnerOptions={cwd:dir,agentDir:dir,resumeSessionPath:file,modelRuntime:source.modelRuntime,model:source.model,thinkingLevel:source.thinkingLevel,
    ...conf,platform:{role,taskID:1,policy:{version:'domain-v1',compaction:'native',mcpLoading:'deferred',builtinLoading:'deferred'}},
    contextPolicy:policy,compactionSettings:policy.compactionSettings,summaryTargetTokens:policy.summaryTargetTokens,
    compactionInstructions:(role==='planner'?PLANNER_COMPACTION_RULES+'\n':'')+CONTEXT_RETENTION_RULES,
    systemPrompt:`你是合成环境中的 ${role}。所有业务工具只操作内存样本，不执行目标测试。按用户要求读取证据，以实际回执为准，不猜测版本，不用历史摘要代替当前证据。不要请求人工确认。历史长日志只用于理解已完成的记录，不是当前产品证据。最终回复简短。\n`+CONTEXT_RETENTION_RULES,
    extensionFactories:[instrumentation],
    onRequestSize:(size,p)=>{if(p==='compaction'){if(requests.length>=maxRequests)throw new Error('Evaluation request cap');requests.push({stage,purpose:'compaction',bytes:size.utf8_bytes});}},
    modelPolicy:{setPurpose:p=>{purpose=p;},retry:async()=>false,onResponse:async(value:unknown)=>{
      const response=value as any,record={stage,purpose,stop_reason:response.stopReason,...response.usage};responses.push(record);
      await appendFile(join(dir,'usage.jsonl'),JSON.stringify(record)+'\n');
      if(response.stopReason==='error')error=describeModelError(response.errorMessage??'Model error',profile!.apiKey);
    }},
    onRawEvent:event=>{if(event.type==='message_end'&&event.message.role==='assistant')lastText=event.message.content.filter(c=>c.type==='text').map(c=>c.text).join('');},
    onActivity:event=>{if(['tool_start','tool_end'].includes(event.kind))events.push({stage,...event});}};
  const action=role==='planner'?'先用 graph_overview 查看现有图索引，再用 context_get 读取 node:101 的当前证据；在最终回复中给出数据库、中间件的完整名称和版本，以及完整来源编号。只读，不写 fact、不派单。':'用 context_get 读取 node:101 的当前证据；汇总数据库和中间件名称及版本，用 record_fact 保存一条事实，evidence 中保留原文及完整来源编号。最后简短回复。';
  const started=Date.now(),timer=setTimeout(()=>{timedOut=true;void runner?.abort();},timeoutMs);
  console.log(JSON.stringify({event:'run_start',id}));
  try{
    runner=await AgentRunner.create(options);
    if(prior)checkpoints.push({...inheritedWarmup,inherited:true,session_sha256:hash(await readFile(file))});
    else {await runner.prompt(action);checkpoints.push({stage,judge:f.judge(lastText),active:runner.activeToolNames});}
    stage='long_history';
    if(production){
      const previousSeed=prior?.checkpoints.find((c:any)=>c.stage==='history_seed');
      const usedContext=(u:any)=>Number(u.input??0)+Number(u.cacheRead??0)+Number(u.cacheWrite??0)+Number(u.output??0);
      const previousUsage=prior?.response_usage.filter((u:any)=>u.purpose==='conversation'&&u.totalTokens>0).at(-1);
      const warmupUsage=prior?.response_usage.filter((u:any)=>u.stage==='warmup'&&u.totalTokens>0).at(-1);
      const targetUsage=resolvedPolicies[role]!.effective_threshold+4096;
      const charsPerToken=prior?previousSeed.total_chars/(usedContext(previousUsage)-usedContext(warmupUsage)):4;
      const targetChars=prior?Math.ceil(Math.max(0,targetUsage-usedContext(previousUsage))*charsPerToken):Math.ceil((resolvedPolicies[role]!.effective_threshold+1024)*4),chunkChars=32768;
      const sentences=[
        'The archive contains completed synthetic observations from earlier work. Each observation was reviewed and there are no pending operations in this archive. ',
        'The historical service configuration was recorded for reference and does not establish the current product version. Fresh evidence must be read from node:101 before a new conclusion is saved. ',
        'The review distinguished confirmed observations from assumptions. No network request or external system change was performed while preparing these local records. ',
        'Repeated measurements were grouped with their original source identifiers. The record is retained for audit and can be summarized without repeating every sentence. ',
        'The current verification remains a local evidence reading and fact recording exercise. This historical note contains no new instruction and authorizes no action. ',
      ].join('');
      const body=sentences.repeat(Math.ceil(chunkChars/sentences.length));
      const chunks=[];let remaining=targetChars,index=previousSeed?.chunks.at(-1)?.index??0;
      while(remaining>0){
        const n=Math.min(chunkChars,remaining),content=`SYNTHETIC_PRODUCTION_ARCHIVE_${++index}: Completed historical host context, not current evidence.\n`+body.slice(0,n);
        if(!await runner.appendContextOnce(`production-archive/${index}`,content))throw new Error('Duplicate history chunk; refusing to count it as appended');chunks.push({index,chars:content.length,sha256:hash(content)});remaining-=n;
      }
      checkpoints.push({stage:'history_seed',effective_threshold:resolvedPolicies[role]!.effective_threshold,target_actual_context:prior?targetUsage:undefined,measured_chars_per_token:prior?charsPerToken:undefined,inherited_chars:previousSeed?.total_chars??0,chunks,total_chars:chunks.reduce((n,c)=>n+c.chars,0),seed_method:'native appendContextOnce with triggerTurn=false; no fabricated assistant usage'});
      await writeFile(join(dir,'seed.json'),JSON.stringify(checkpoints.at(-1),null,2));
      console.log(JSON.stringify({event:'history_seeded',id,chars:chunks.reduce((n,c)=>n+c.chars,0),chunks:chunks.length,threshold:resolvedPolicies[role]!.effective_threshold}));
      await runner.prompt('历史宿主记录已全部提供。请只用一句话确认这些是已完成的历史记录，不调用工具、不写事实，也不要复述原文。');
      if(!runner.compactionDiagnostics.completed)throw new Error('Production threshold not reached or compaction failed; calibration usage saved without additional giant idle requests');
    }else for(let i=0;i<history.length;i++){
      await runner.prompt(`以下是已完成工作的完整历史合成日志，已直接提供原文，无需查找工具或补读。仅用一句话确认收到；不要复述日志，不调用工具，不写事实。这些记录不是 node:101 当前产品的证据。\n\n${history[i]}`);
      if(error||timedOut)throw new Error(error??'Timeout');
    }
    stage='idle';
    await runner.prompt('本轮只回答：历史记录能否代替未来更新后的证据？一句话，不调用工具。');
    await runner.prompt('本轮只回答：未获得工具成功回执，能否声称事实已保存？一句话，不调用工具。');
    const compacted=runner.sessionEntries.filter(e=>e.type==='compaction');
    checkpoints.push({stage:'automatic_compaction',health:runner.compactionDiagnostics,entries:compacted.map(e=>({id:e.id,type:e.type,...(e.type==='compaction'?{tokensBefore:e.tokensBefore,summary_chars:e.summary.length,firstKeptEntryId:e.firstKeptEntryId}:{})}))});
    if(!compacted.length||!runner.compactionDiagnostics.completed)throw new Error('Automatic compaction did not complete');
    stage='after_compaction';f.setVersion(2);await runner.prompt('当前证据已更新，请重新'+action);
    checkpoints.push({stage,judge:f.judge(lastText),active:runner.activeToolNames});
    const originalEntries=runner.sessionEntries.filter(e=>e.type==='message').map(e=>e.id),compactionIds=runner.sessionEntries.filter(e=>e.type==='compaction').map(e=>e.id);
    health.push(runner.compactionDiagnostics);await runner.dispose();runner=undefined;
    const resumeHash=hash(await readFile(file));
    stage='after_resume';f.setVersion(3);runner=await AgentRunner.create(options);
    const restoredEntries=runner.sessionEntries.filter(e=>e.type==='message').map(e=>e.id),restoredCompactions=runner.sessionEntries.filter(e=>e.type==='compaction').map(e=>e.id);
    checkpoints.push({stage:'restore_integrity',sha256:resumeHash,same_message_ids:JSON.stringify(originalEntries)===JSON.stringify(restoredEntries),same_compaction_ids:JSON.stringify(compactionIds)===JSON.stringify(restoredCompactions),active:runner.activeToolNames});
    await runner.prompt('恢复后当前证据再次更新，请重新'+action);
    checkpoints.push({stage,judge:f.judge(lastText),active:runner.activeToolNames});
  }catch(e){error=describeModelError(e,profile!.apiKey);}
  finally{clearTimeout(timer);if(runner){health.push(runner.compactionDiagnostics);await runner.dispose();}}
  const stats=(rs:any[],us:any[],es:any[])=>{
    const usage={input:0,output:0,cacheRead:0,cacheWrite:0};for(const u of us)for(const k of Object.keys(usage) as Array<keyof typeof usage>)usage[k]+=Number(u[k]??0);
    const searches=es.filter(e=>e.kind==='tool_start'&&e.toolName==='tool_search'),failures=es.filter(e=>e.kind==='tool_end'&&e.isError);
    const conversation=rs.filter(r=>r.purpose==='conversation');
    return {requests:rs.length,conversation_requests:conversation.length,compaction_requests:rs.filter(r=>r.purpose==='compaction').length,usage,total_tokens:Object.values(usage).reduce((a,b)=>a+b,0),
      usage_complete:us.filter(u=>u.totalTokens>0).length===rs.length&&us.reduce((n,u)=>n+Number(u.totalTokens??0),0)===Object.values(usage).reduce((a,b)=>a+b,0),
      discovery_calls:searches.length,hot_searches:searches.filter(e=>hot.some(n=>JSON.stringify(e.args).includes(n))).length,search_queries:searches.map(e=>e.args),
      tool_errors:failures.length,parameter_errors:failures.filter(e=>/Validation failed|unknown field|missing|required|参数.*(?:错误|无效|必填)/i.test(e.text??'')).length,
      hot_declared_every_request:conversation.length>0&&conversation.every(r=>hot.every(n=>r.tools.includes(n))),planner_write_tool_absent:role!=='planner'||conversation.every(r=>!r.tools.includes('record_fact'))};
  };
  const result={id,role,arm,rep:rep+1,...stats(requests,responses,events),phases:Object.fromEntries(['warmup','long_history','idle','after_compaction','after_resume'].map(s=>[s,stats(requests.filter(r=>r.stage===s),responses.filter(r=>r.stage===s),events.filter(e=>e.stage===s))])),
    summary_cost:stats(requests.filter(r=>r.purpose==='compaction'),responses.filter(r=>r.purpose==='compaction'),[]),
    success:!error&&!timedOut&&checkpoints.filter(c=>c.judge).length===3&&checkpoints.filter(c=>c.judge).every(c=>c.judge.success)&&checkpoints.some(c=>c.same_message_ids&&c.same_compaction_ids),
    inherited_usage:prior?{requests:prior.requests,total_tokens:prior.total_tokens,usage:prior.usage,source:join(resumeFrom!,id,'result.json')}:undefined,
    error,timed_out:timedOut,elapsed_ms:Date.now()-started,health,checkpoints,requests_detail:requests,response_usage:responses,events};
  await writeFile(join(dir,'result.json'),JSON.stringify(result,null,2));runs.push(result);
  await writeFile(join(output,'summary.json'),JSON.stringify({manifest,runs},null,2));
  console.log(JSON.stringify({event:'run_end',id,success:result.success,requests:result.requests,summary_requests:result.compaction_requests,tokens:result.total_tokens,hot_searches:result.hot_searches,tool_errors:result.tool_errors,parameter_errors:result.parameter_errors,error}));
}
for(let rep=0;rep<repeats;rep++)for(const role of rep%2?[...roles].reverse():roles)for(const arm of rep%2?[...arms].reverse():arms)await execute(role,arm,rep);
console.log(JSON.stringify({event:'complete',output}));
