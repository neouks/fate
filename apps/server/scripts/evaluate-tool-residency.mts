/** Opt-in real-model checks of idle reuse and native old-session restoration.
 * Uses the production AgentRunner; every business execution is an in-memory mock. */
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import pg from 'pg';
import type {ToolDefinition,ExtensionFactory} from '@earendil-works/pi-coding-agent';
import {Database} from '../src/db/index.js';
import {postgresDSN} from '../src/config/index.js';
import {buildModelSource,describeModelError} from '../src/pi/providerFromProfile.js';
import {AgentRunner} from '../src/pi/runner.js';
import {roleDefinitions} from '../src/agent/tool-catalog.js';
import {toolLoadout,compactToolSchema} from '../src/agent/tool-loading.js';
import {TOOL_ALIASES} from '../src/agent/tool-registry.js';

type Arm='deferred'|'resident';
const args=new Map(process.argv.slice(2).map(a=>{const [k,...v]=a.split('=');return [k!,v.join('=')];}));
const repeats=Number(args.get('--repeats')||2),maxRequests=24,timeoutMs=180_000;
if(!Number.isInteger(repeats)||repeats<1||repeats>3)throw new Error('repeats must be 1–3');
const output=resolve(args.get('--out')||join('artifacts','residency-'+Date.now()));
const plan={repeats,arms:['deferred','resident'],cases:['idle_reuse','old_session_resume'],max_requests_per_run:maxRequests,
  model_output_limit:8192,timeout_ms:timeoutMs,
  method:'Production AgentRunner with identical current schemas and mocked tools. Deferred baseline keeps only ask_user/context_search resident; both arms use exact lookup and keyword fallback. Current arm uses toolLoadout(mainagent) without overrides. Each resume pair starts from byte-identical real-model old-policy JSONL. Two idle user turns, followed by fresh version-2 evidence and another write.',
  safety:'Read-only model profile lookup; no business database writes, target requests, native shell/file tools, or MCP bindings.',
  limitations:'Synthetic Main Agent workflow, not a full application task or Worker/Planner run; no fixed model seed, provider cache not reset. Resume preparation is measured separately.'};
if(!args.has('--run')){console.log(JSON.stringify(plan,null,2));process.exit(0);}
await mkdir(resolve(output,'..'),{recursive:true});await mkdir(output);
const pool=new pg.Pool({connectionString:postgresDSN().dsn,options:'-c default_transaction_read_only=on -c statement_timeout=10000'});
let profile;
try{profile=await new Database(pool).platform().activeProfile();}finally{await pool.end();}
if(!profile?.apiKey)throw new Error('No configured model profile');
const source=await buildModelSource({...profile,maxTokens:8192});
const base=roleDefinitions({} as Database,'mainagent').filter(t=>!TOOL_ALIASES[t.name]).map(compactToolSchema);
const sourcePaths=['scripts/evaluate-tool-residency.mts','src/pi/runner.ts','src/pi/tool-discovery.ts','src/pi/tool-declaration-window.ts','src/pi/platform-mcp.ts','src/agent/tool-loading.ts','src/agent/tool-registry.ts'];
const hashes:Record<string,string>={};
for(const path of sourcePaths){const data=await readFile(path);hashes[path]=createHash('sha256').update(data).digest('hex');const dest=join(output,'source-snapshot',path);await mkdir(resolve(dest,'..'),{recursive:true});await writeFile(dest,data);}
const manifest={...plan,model:{id:profile.id,name:profile.name,model:profile.model,thinking:source.thinkingLevel,format:profile.format},source_hashes:hashes,started_at:new Date().toISOString()};
await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2));
await writeFile(join(output,'tool-schemas.json'),JSON.stringify(base.map(({name,description,parameters})=>({name,description,parameters})),null,2));
console.log(JSON.stringify({event:'start',output,model:manifest.model,runs:repeats*4,seeds:repeats}));

function fixture(label:string,initialVersion=1){
  let version=initialVersion;const reads:number[]=[],writes:any[]=[];
  const receipt=()=>`SYNTHETIC-${label}-V${version}`;
  const products=()=>version===1?{database:'CedarDB 8.2',middleware:'OrchidAS 2.4.7'}:{database:'CedarDB 8.3',middleware:'OrchidAS 2.5.1'};
  const result=(body:unknown,isError=false)=>({content:[{type:'text' as const,text:JSON.stringify(body)}],details:{},...(isError?{isError:true}:{})});
  const tools=base.map(t=>({...t,execute:async(_id:string,input:any)=>{
    if(t.name==='context_get'){
      if(!input.items?.some((i:any)=>i.ref==='node:101'))return result({error:'Only node:101 exists'},true);
      reads.push(version);const p=products();
      return result({items:[{ref:'node:101',version,view:'detail',content:JSON.stringify({...p,evidence:`${receipt()}: database=${p.database}; middleware=${p.middleware}`})}]});
    }
    if(t.name==='record_fact'){
      const facts=input.facts??[input];
      if(!reads.includes(version)||facts.some((f:any)=>!String(f.evidence??'').includes(receipt())))return result({error:'Read the current version and preserve its source receipt in evidence'},true);
      writes.push(...facts.map((fact:any)=>({version,fact})));
      return result({saved:facts.length,facts:facts.map((_:unknown,i:number)=>({fact_id:200+writes.length+i,saved:true}))});
    }
    if(t.name==='context_search')return result({items:[{ref:'node:101',version,summary:'Synthetic local evidence'}]});
    return result({error:'Unneeded tool: fixture only, no external action executed'},true);
  }} as ToolDefinition));
  return {tools,advance:()=>{version=2;},judge:()=>{
    const p=products();return {version,reads,writes,success:reads.includes(version)&&writes.some(w=>w.version===version&&[p.database,p.middleware].every(v=>(String(w.fact.summary??'')+' '+String(w.fact.detail??'')).includes(v)))};
  }};
}
function loadout(arm:Arm,tools:ToolDefinition[]){
  const current=toolLoadout('mainagent',{customTools:tools,toolAllowlist:tools.map(t=>t.name)});
  if(arm==='resident')return current;
  const initialActive=current.toolAllowlist.filter(n=>['ask_user','context_search'].includes(n));
  const deferred=current.toolAllowlist.filter(n=>!initialActive.includes(n));
  return {...current,customTools:current.customTools.map(t=>({...t,exposure:deferred.includes(t.name)?'deferred' as const:undefined})),toolLoading:{...current.toolLoading,initialActive,deferred,idleToolRequests:2}};
}
const action='用 context_get 读取 node:101 的当前证据，把数据库和中间件名称及版本汇总为一条 fact，用 record_fact 保存；evidence 保留原文和完整来源编号。以成功回执为准，最后简短回复。';
const prompts=[action,'本轮仅一句话确认：刚才读取的是已有证据还是实时测试？不要调用工具或新增事实。','本轮仅一句话确认：没有成功回执能否声称事实已保存？不要调用工具或新增事实。','已有证据已更新，请再次'+action];
const summarize=(requests:any[],responses:any[],events:any[])=>{
  const usage={input:0,output:0,cacheRead:0,cacheWrite:0};
  for(const r of responses)for(const k of Object.keys(usage) as Array<keyof typeof usage>)usage[k]+=Number(r[k]??0);
  const searches=events.filter(e=>e.kind==='tool_start'&&e.toolName==='tool_search');
  return {requests:requests.length,responses:responses.length,usage,total_tokens:Object.values(usage).reduce((a,b)=>a+b,0),
    usage_complete:responses.filter(r=>r.totalTokens>0).length===requests.length&&responses.reduce((n,r)=>n+Number(r.totalTokens??0),0)===Object.values(usage).reduce((a,b)=>a+b,0),
    discovery_calls:searches.length,discovery_queries:searches.map(e=>e.args),
    hot_tool_searches:searches.filter(e=>/context_get|record_fact/.test(JSON.stringify(e.args))).length,
    tool_errors:events.filter(e=>e.kind==='tool_end'&&e.isError).length,
    hot_tools_declared_every_request:requests.length>0&&requests.every(r=>['context_get','record_fact'].every(n=>r.tools.includes(n)))};
};
const runs:any[]=[],seeds:any[]=[];
async function execute(id:string,arm:Arm,kind:'idle_reuse'|'old_session_resume'|'seed',label:string,seedFile?:string){
  const dir=join(output,id);await mkdir(dir);const file=join(dir,'session.jsonl');
  if(seedFile)await copyFile(seedFile,file);
  const startHash=seedFile?createHash('sha256').update(await readFile(file)).digest('hex'):undefined;
  const f=fixture(label,kind==='old_session_resume'?2:1),conf=loadout(arm,f.tools);
  const requestShapes:any[]=[],responseUsage:any[]=[],events:any[]=[],turnResults:any[]=[];
  let stage=kind==='old_session_resume'?'focus':'preparation',error:string|null=null,timedOut=false;
  let runner:AgentRunner|undefined;
  const instrumentation:ExtensionFactory=api=>{
    api.on('before_provider_request',(event,context)=>{
      if(requestShapes.length>=maxRequests){context.abort();throw new Error('Benchmark request cap');}
      const payload=event.payload as any;
      requestShapes.push({stage,bytes:Buffer.byteLength(JSON.stringify(payload)),tools:(payload.tools??[]).map((t:any)=>t.function?.name??t.name),schema_bytes:Buffer.byteLength(JSON.stringify(payload.tools??[]))});
    });
    api.on('turn_end',(_event,context)=>{if(requestShapes.length>=maxRequests)context.abort();});
  };
  const started=Date.now();const timer=setTimeout(()=>{timedOut=true;void runner?.abort();},timeoutMs);
  console.log(JSON.stringify({event:'run_start',id}));
  try{
    runner=await AgentRunner.create({cwd:dir,agentDir:dir,resumeSessionPath:file,modelRuntime:source.modelRuntime,model:source.model,thinkingLevel:source.thinkingLevel,
      systemPrompt:'你在合成环境验收中。所有业务工具仅操作内存样本。根据实际证据回执完成用户要求；不能猜测内容，不能用口头声明代替事实写入。无需人工确认。',
      ...conf,extensionFactories:[instrumentation],onRawEvent:event=>{
        if(event.type==='message_end'&&event.message.role==='assistant'){
          responseUsage.push({stage,stop_reason:event.message.stopReason,...event.message.usage});
          if(event.message.stopReason==='error')error=describeModelError(event.message.errorMessage??'Model error',profile!.apiKey);
        }
      },onActivity:event=>{if(['tool_start','tool_end'].includes(event.kind))events.push({stage,...event});}});
    const activeAtStart=runner.activeToolNames;
    for(const [index,prompt] of (kind==='old_session_resume'?[prompts[3]!]:kind==='seed'?prompts.slice(0,3):prompts).entries()){
      if(requestShapes.length>=maxRequests||timedOut||error)break;
      if(kind==='idle_reuse'&&index===3){f.advance();stage='focus';}
      turnResults.push(await runner.prompt(prompt));
    }
    const judge=f.judge(),stats=summarize(requestShapes,responseUsage,events);
    return await save({id,arm,case:kind,label,session_file:file,seed_hash:startHash,active_at_start:activeAtStart,active_at_end:runner.activeToolNames,
      ...stats,focus:summarize(requestShapes.filter(r=>r.stage==='focus'),responseUsage.filter(r=>r.stage==='focus'),events.filter(e=>e.stage==='focus')),
      success:judge.success&&!error&&!timedOut&&responseUsage.at(-1)?.stop_reason==='stop',judge,error,timed_out:timedOut,budget_hit:requestShapes.length>=maxRequests,
      compaction:runner.compactionDiagnostics,elapsed_ms:Date.now()-started,request_shapes:requestShapes,response_usage:responseUsage,events,turn_results:turnResults});
  }catch(e){error=describeModelError(e,profile!.apiKey);return await save({id,arm,case:kind,error,success:false,...summarize(requestShapes,responseUsage,events),request_shapes:requestShapes,response_usage:responseUsage,events});}
  finally{clearTimeout(timer);await runner?.dispose();}
  async function save(value:any){await writeFile(join(dir,'result.json'),JSON.stringify(value,null,2));console.log(JSON.stringify({event:'run_end',id,success:value.success,requests:value.requests,tokens:value.total_tokens,hot_searches:value.hot_tool_searches,errors:value.tool_errors,error:value.error}));return value;}
}
for(let rep=0;rep<repeats;rep++){
  const order:Arm[]=rep%2?['resident','deferred']:['deferred','resident'];
  for(const arm of order)runs.push(await execute(`idle-${rep+1}-${arm}`,arm,'idle_reuse',`idle-${rep+1}`));
  const seed=await execute(`seed-${rep+1}`,'deferred','seed',`restore-${rep+1}`);seeds.push(seed);
  if(!seed.success)throw new Error('Seed failed; refusing incomparable resume runs. See saved result.');
  for(const arm of [...order].reverse())runs.push(await execute(`restore-${rep+1}-${arm}`,arm,'old_session_resume',`restore-${rep+1}`,seed.session_file));
  await writeFile(join(output,'summary.json'),JSON.stringify({manifest,seeds,runs},null,2));
}
console.log(JSON.stringify({event:'complete',output}));
