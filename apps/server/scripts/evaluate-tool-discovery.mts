/** Opt-in real-model evaluation. Production DB is read-only; every business
 * tool is replaced with an in-memory fixture. No target/network/FS tools exist. */
import {mkdir,writeFile,appendFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,createToolSearchExtension,type ToolDefinition,type ExtensionFactory} from '@earendil-works/pi-coding-agent';
import {Database} from '../src/db/index.js';
import {postgresDSN} from '../src/config/index.js';
import {buildModelSource,describeModelError} from '../src/pi/providerFromProfile.js';
import {roleDefinitions} from '../src/agent/tool-catalog.js';
import {toolLoadout,compactToolSchema} from '../src/agent/tool-loading.js';
import {TOOL_ALIASES} from '../src/agent/tool-registry.js';
import {platformMcpExtension,toolDiscoveryInstructions} from '../src/pi/platform-mcp.js';
import {toolDeclarationWindow} from '../src/pi/tool-declaration-window.js';

type Arm='before'|'lean'|'after'|'hybrid';
type Case='known'|'keyword'|'reuse';
const args=new Map(process.argv.slice(2).map(arg=>{const [key,...rest]=arg.split('=');return [key!,rest.join('=')];}));
const repeats=Number(args.get('--repeats')||2);
const arms=(args.get('--arms')||'before,lean,after').split(',') as Arm[];
const cases=(args.get('--cases')||'known,keyword,reuse').split(',') as Case[];
const maxRequests=Number(args.get('--max-requests')||24),maxOutputTokens=8192,timeoutMs=240_000;
if(!Number.isInteger(repeats)||repeats<1||repeats>3||!Number.isInteger(maxRequests)||maxRequests<4||maxRequests>32||arms.some(a=>!['before','lean','after','hybrid'].includes(a))||cases.some(c=>!['known','keyword','reuse'].includes(c)))throw new Error('Invalid bounded evaluation options');
const oldResident=new Set(['context_search','context_get','ask_user','http_request','insert_assets','record_fact','report_finding','add_intent','dispatch_intents','steer_work','web_search']);
const baselineCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const baseTools=roleDefinitions({} as Database,'mainagent').filter(t=>!TOOL_ALIASES[t.name]).map(compactToolSchema);
const commonPrompt='你在独立的合成数据验收环境中工作。所有业务工具只操作内存样本，不连接真实目标。按用户要求读取证据并保存事实，禁止猜测未读内容、伪造工具回执或用文字代替保存。不要请求人工确认。以实际工具成功回执为准；最终回复简短。';
const simple=(name:string,description:string):ToolDefinition=>({name,label:name,description,
  parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>({content:[{type:'text',text:'fixture'}],details:{}})});
const auxiliary=[
  simple('signed_inventory','Read the signed local environment inventory export. Returns the installed database product, middleware product, and the source evidence receipt.'),
  simple('inventory_catalog','List local inventory file metadata. This index contains file names only, not installed product values.'),
  simple('inventory_history','List historical inventory revision numbers only. Does not return the current installed products.'),
  simple('account_digest','Read a synthetic account count. Contains no environment inventory.'),
  simple('billing_digest','Read a synthetic billing summary. Contains no installed product identities.'),
  simple('service_health','Read synthetic service health status, not product versions.'),
];

function fixture(caseName:Case,rep:number){
  const receipt=`SYNTHETIC-${caseName}-${rep}-EVIDENCE`,database='CedarDB 8.2',middleware='OrchidAS 2.4.7';
  const evidence=`${receipt}: database=${database}; middleware=${middleware}`;
  let reads=0;const writes:any[]=[];
  const body={ref:'node:101',version:1,payload:{summary:'已保存的本地环境快照',evidence,database,middleware}};
  const response=(value:unknown,isError=false)=>({content:[{type:'text' as const,text:JSON.stringify(value)}],details:{},...(isError?{isError:true}:{})});
  const tools=[...baseTools,...auxiliary].map(tool=>({...tool,execute:async(_id:string,input:any)=>{
    if(tool.name==='context_get'){
      if(caseName==='keyword')return response({error:'此样本的当前环境导出不在探索图中；请使用本地环境库存导出能力。'},true);
      if(!input.items?.some((item:any)=>item.ref==='node:101'))return response({error:'合成样本只有 node:101'},true);
      reads++;return response({items:[{ref:'node:101',view:'detail',field:'',version:1,content:JSON.stringify(body),next_item:null}]});
    }
    if(tool.name==='signed_inventory'){reads++;return response({database,middleware,evidence,source:'signed local export'});}
    if(tool.name==='inventory_catalog')return response({files:['signed-environment.json'],read_tool:'signed_inventory'});
    if(tool.name==='context_search')return response({items:caseName==='keyword'?[]:[{ref:'node:101',summary:'本地环境证据',version:1,read:{ref:'node:101'}}]});
    if(tool.name==='record_fact'){
      const facts=input.facts??[input];
      if(!reads)return response({error:'必须先读取合成证据'},true);
      for(const fact of facts){
        if(typeof fact.evidence!=='string'||!fact.evidence.includes(receipt))return response({error:'evidence 必须包含刚读取的完整证据来源编号'},true);
      }
      writes.push(...facts);return response({saved:facts.length,facts:facts.map((_:unknown,i:number)=>({fact_id:200+writes.length+i,saved:true}))});
    }
    if(tool.name==='ask_user')return response({error:'独立测试无人工输入，请依据合成数据完成'},true);
    return response({error:'此合成场景不需要该工具，未执行任何外部操作'},true);
  }} as ToolDefinition));
  const finish='将已读环境的数据库和中间件名称/版本汇总为一条 fact，通过 record_fact 保存，并在 evidence 中保留原文及完整来源编号。成功保存才算完成。';
  const prompts=caseName==='known'?['请用 context_get 读取 node:101 的现有环境证据。'+finish]
    :caseName==='keyword'?['请找出本地已签名环境库存导出里的数据库和中间件名称/版本。具体读取工具名未知，探索图没有这份导出；请从可用能力中发现合适工具。'+finish]
      :['请用 context_get 读取 node:101；本轮仅告诉我证据来源编号，先不要保存事实。',
        '这轮只确认：上一轮是读取已有证据还是发起实时测试？一句话回答，先不要保存。',
        '这轮只确认：未经工具成功回执，能否声称事实已保存？一句话回答，先不要保存。',
        '现在再次用 context_get 读取 node:101 核对内容，然后'+finish];
  return {tools,prompts,judge:()=>({success:reads>=(caseName==='reuse'?2:1)&&writes.some(fact=>{
    const prose=String(fact.summary??'')+' '+String(fact.detail??'');
    return prose.includes(database)&&prose.includes(middleware)&&String(fact.evidence).includes(receipt);
  }),reads,saved_facts:writes.length})};
}

function configuration(arm:Arm,tools:ToolDefinition[]){
  // Freeze the comparison arms: production residency may change after an eval.
  if(arm!=='hybrid'){
    const resident=arm==='before'?oldResident:new Set(['context_search','ask_user']);
    const deferred=tools.filter(tool=>!resident.has(tool.name)).map(tool=>tool.name);
    return {customTools:tools.map(tool=>({...tool,...(deferred.includes(tool.name)?{exposure:'deferred' as const}:{})})),
      initial:tools.map(t=>t.name).filter(name=>!deferred.includes(name)),deferred,idle:arm==='before'?undefined:2};
  }
  const current=toolLoadout('mainagent',{customTools:tools,toolAllowlist:tools.map(tool=>tool.name)});
  return {customTools:current.customTools,initial:current.toolLoading.initialActive,deferred:current.toolLoading.deferred,idle:current.toolLoading.idleToolRequests};
}

const output=resolve(args.get('--out')||join('artifacts','tool-discovery-eval-'+new Date().toISOString().replace(/[:.]/g,'-')));
const plan={baseline_commit:baselineCommit,arms,cases,repeats,max_requests_per_session:maxRequests,max_output_tokens_per_request:maxOutputTokens,timeout_ms:timeoutMs,
  variants:{before:'Original 11-tool mainagent residency + native BM25 default 8; sticky discovery',lean:'Prior 2-tool lean residency + native BM25 default 1 + 2-request idle retirement; before exact/fallback',after:'Prior 2-tool lean residency + exact lookup + full candidate fallback + 2-request idle retirement',hybrid:'Current production loadout: resident context_get and record_fact + exact/fallback for deferred tools'},
  scope:'Same current tool schemas and fixture implementations in all arms. Native SDK isolation, with production-equivalent deferred-not-active error hint in all arms; not a full historical or end-to-end application replay. No fixed seed or temperature override.',
  safety:'Read-only production profile lookup. All business tools mocked; no target access. No credentials written to results.',
  initial_schemas:Object.fromEntries(arms.map(arm=>{const conf=configuration(arm,fixture('known',0).tools);return [arm,{names:conf.initial,bytes:Buffer.byteLength(JSON.stringify(conf.customTools.filter(t=>conf.initial.includes(t.name)).map(({name,description,parameters})=>({name,description,parameters}))))}];}))};
if(!args.has('--run')){console.log(JSON.stringify(plan,null,2));process.exit(0);}
await mkdir(resolve(output,'..'),{recursive:true});
await mkdir(output); // Never mix a new run with earlier evidence.
const pool=new pg.Pool({connectionString:postgresDSN().dsn,options:'-c default_transaction_read_only=on -c statement_timeout=10000'});
let profile;
try{profile=args.has('--profile')?await new Database(pool).platform().profileByID(Number(args.get('--profile'))):await new Database(pool).platform().activeProfile();}
finally{await pool.end();}
if(!profile?.apiKey)throw new Error('No configured model profile');
const source=await buildModelSource({...profile,maxTokens:maxOutputTokens});
const sourceFiles=['scripts/evaluate-tool-discovery.mts','src/pi/tool-discovery.ts','src/pi/tool-declaration-window.ts','src/pi/platform-mcp.ts','src/agent/tool-registry.ts','src/agent/tool-loading.ts'];
const manifest={...plan,model:{id:profile.id,name:profile.name,model:profile.model,format:profile.format,thinking:source.thinkingLevel},
  source_hashes:Object.fromEntries(await Promise.all(sourceFiles.map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')]))),node:process.version,started_at:new Date().toISOString()};
await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2));
await writeFile(join(output,'tool-schemas.json'),JSON.stringify(fixture('known',0).tools.map(({name,description,parameters})=>({name,description,parameters})),null,2));
console.log(JSON.stringify({event:'start',output,model:profile.model,thinking:source.thinkingLevel,sessions:arms.length*cases.length*repeats}));
const results:any[]=[];
for(let rep=0;rep<repeats;rep++)for(const caseName of rep%2?[...cases].reverse():cases)for(const arm of rep%2?[...arms].reverse():arms){
  const id=`${caseName}-${rep+1}-${arm}`,dir=join(output,id);await mkdir(dir,{recursive:true});
  const local=fixture(caseName,rep),conf=configuration(arm,local.tools);
  const metrics:any={id,arm,case:caseName,rep:rep+1,requests:0,responses:0,tool_calls:0,discovery_calls:0,tool_errors:0,
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0},response_usage:[],request_shapes:[],events:[],final:'',error:null};
  const loading={version:'lean-tools-v1',initialActive:conf.initial,deferred:conf.deferred,compatibility:[],...(conf.idle?{idleToolRequests:conf.idle}:{})};
  const instrumentation:ExtensionFactory=api=>{
    api.on('message_end',event=>{
      const message=event.message;
      if(message.role!=='toolResult'||!message.isError||!conf.deferred.includes(message.toolName))return;
      const text=message.content.filter(part=>part.type==='text').map(part=>part.text).join('\n');
      if(text!==`Tool ${message.toolName} not found`)return;
      return {message:{...message,content:[{type:'text' as const,text:`工具 ${message.toolName} 尚未在当前声明中激活；先用 tool_search(query=${JSON.stringify(message.toolName)}) 检索，成功加载后再调用。若已禁用或撤销则停止，不能绕过。\n原始工具错误：${text}`} ]}};
    });
    api.on('before_provider_request',(event,context)=>{
      if(metrics.requests>=maxRequests){context.abort();throw new Error('Benchmark request budget exceeded');}
      metrics.requests++;
      const payload=event.payload as any;
      metrics.request_shapes.push({bytes:Buffer.byteLength(JSON.stringify(payload)),tool_count:payload.tools?.length??0,tool_schema_bytes:Buffer.byteLength(JSON.stringify(payload.tools??[]))});
    });
    api.on('turn_end',(_event,context)=>{if(metrics.requests>=maxRequests)context.abort();});
  };
  let search:ExtensionFactory;
  if(arm==='after'||arm==='hybrid')search=platformMcpExtension({toolLoading:loading} as never);
  else search=async api=>{
    await createToolSearchExtension()(new Proxy(api,{get(target,key){
      if(key==='registerTool')return (definition:ToolDefinition)=>target.registerTool(arm==='before'?definition:{...definition,
        execute:async(id,input:any,signal,update,context)=>{
          const result=await definition.execute(id,{...input,limit:input.limit??1},signal,update,context);
          const names=(result.details as {loaded?:string[]})?.loaded;
          return names?.length?{...result,content:[{type:'text',text:'已加载：'+names.join(', ')+'。参数与约束见下一轮工具声明。'}]}:result;
        }});
      return Reflect.get(target,key);
    }}));
  };
  const policyPrompt=arm==='after'||arm==='hybrid'?toolDiscoveryInstructions({toolLoading:loading}):
    '\n以当前声明为可调用集合；未声明的工具先用 tool_search 检索，加载后调用。已知名称优先搜索精确名称。'+(arm==='lean'?'默认只加载下一步需要的 1 个，必要时扩大 limit；闲置后可能需要重新加载。':'')+' 可发现的工具名：'+conf.deferred.join(', ');
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
    extensionFactories:[search,...(conf.idle?[toolDeclarationWindow(loading)!]:[]),instrumentation],systemPrompt:commonPrompt+policyPrompt});
  await loader.reload();
  const {session}=await createAgentSession({cwd:dir,agentDir:dir,modelRuntime:source.modelRuntime,model:source.model,thinkingLevel:source.thinkingLevel,
    settingsManager:SettingsManager.inMemory({defaultTools:[...conf.initial,'tool_search'],retry:{enabled:false},compaction:{enabled:false},cacheWarming:'off'}),
    sessionManager:SessionManager.create(dir,dir),resourceLoader:loader,excludeTools:['read','bash','edit','write','grep','find','ls'],customTools:conf.customTools});
  await session.bindExtensions({});
  const unsubscribe=session.subscribe(event=>{
    if(event.type==='message_end'&&event.message.role==='assistant'){
      metrics.responses++;const usage=event.message.usage;
      metrics.response_usage.push({stop_reason:event.message.stopReason,...usage});
      for(const key of ['input','output','cacheRead','cacheWrite'])metrics.usage[key]+=Number((usage as any)?.[key]??0);
      metrics.final=event.message.content.filter(c=>c.type==='text').map(c=>c.text).join('');
      if(event.message.stopReason==='error')metrics.error=describeModelError(event.message.errorMessage??'Model error',profile!.apiKey);
    }
    if(event.type==='tool_execution_start'){metrics.tool_calls++;if(event.toolName==='tool_search')metrics.discovery_calls++;metrics.events.push({event:'call',tool:event.toolName,args:event.args});}
    if(event.type==='tool_execution_end'){if(event.isError)metrics.tool_errors++;metrics.events.push({event:'result',tool:event.toolName,error:event.isError,result:event.result});}
  });
  const start=Date.now();let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;void session.abort();},timeoutMs);
  console.log(JSON.stringify({event:'session_start',id}));
  try{for(const prompt of local.prompts){if(metrics.requests>=maxRequests||timedOut||metrics.error)break;await session.prompt(prompt);}}
  catch(error){metrics.error=describeModelError(error,profile.apiKey);}
  finally{clearTimeout(timer);unsubscribe();session.dispose();}
  Object.assign(metrics,local.judge(),{elapsed_ms:Date.now()-start,timed_out:timedOut});
  metrics.objective_saved=metrics.success;
  metrics.budget_hit=metrics.requests>=maxRequests;
  metrics.success=metrics.objective_saved&&!metrics.error&&!timedOut&&metrics.response_usage.at(-1)?.stop_reason==='stop';
  metrics.total_tokens=Object.values(metrics.usage).reduce((sum:any,n:any)=>sum+n,0);
  // SDK may append an unsent local aborted message with zero usage. Do not
  // confuse that with a billed request; still distinguish normal completion.
  metrics.usage_complete=metrics.response_usage.filter((u:any)=>u.totalTokens>0).length===metrics.requests;
  await writeFile(join(dir,'result.json'),JSON.stringify(metrics,null,2));results.push(metrics);
  await appendFile(join(output,'progress.jsonl'),JSON.stringify({id,success:metrics.success,requests:metrics.requests,total_tokens:metrics.total_tokens,discovery_calls:metrics.discovery_calls,tool_errors:metrics.tool_errors,elapsed_ms:metrics.elapsed_ms,error:metrics.error})+'\n');
  const groups=Object.fromEntries(arms.map(arm=>{const rows=results.filter(row=>row.arm===arm);return [arm,{sessions:rows.length,completed:rows.filter(r=>r.success).length,requests:rows.reduce((n,r)=>n+r.requests,0),discovery_calls:rows.reduce((n,r)=>n+r.discovery_calls,0),tool_errors:rows.reduce((n,r)=>n+r.tool_errors,0),total_tokens:rows.reduce((n,r)=>n+r.total_tokens,0),input_uncached:rows.reduce((n,r)=>n+r.usage.input,0),cache_read:rows.reduce((n,r)=>n+r.usage.cacheRead,0),output:rows.reduce((n,r)=>n+r.usage.output,0),elapsed_ms:rows.reduce((n,r)=>n+r.elapsed_ms,0),usage_complete:rows.every(r=>r.usage_complete)}];}));
  await writeFile(join(output,'summary.json'),JSON.stringify({manifest,groups,runs:results.map(({events,...rest})=>rest)},null,2));
  console.log(JSON.stringify({event:'session_end',id,success:metrics.success,requests:metrics.requests,tokens:metrics.total_tokens,discovery_calls:metrics.discovery_calls,errors:metrics.tool_errors,elapsed_ms:metrics.elapsed_ms,error:metrics.error}));
}
console.log(JSON.stringify({event:'complete',output}));
