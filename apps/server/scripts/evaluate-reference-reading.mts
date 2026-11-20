/** Opt-in real role models, live public docs and controlled long-page fixtures. */
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {Database} from '../src/db/index.js';
import {postgresDSN} from '../src/config/index.js';
import {resolveModelProfiles} from '../src/pi/modelResolver.js';
import {buildModelSource,describeModelError} from '../src/pi/providerFromProfile.js';
import {AgentRunner,type AgentRunnerOptions} from '../src/pi/runner.js';
import {runContext} from '../src/tools/context.js';
import {workerTools,plannerTools,mainTools} from '../src/tools/index.js';
import {applyToolBindings} from '../src/agent/tool-bindings.js';
import {prepareToolLoading} from '../src/agent/tool-loading.js';
import {assertToolBinding} from '../src/agent/tool-registry.js';
import {publicTransport} from '../src/search/public-web.js';
import {WEB_CONTEXT_CHARS} from '../src/search/context.js';
import {WEB_SEARCH_DESCRIPTION} from '../src/search/policy.js';

const out=resolve(process.argv.find(a=>a.startsWith('--out='))?.slice(6)??'../../docs/reviews/evidence/reference-reading-'+Date.now());
if(!process.argv.includes('--run')){console.log('Use --run [--out=path]: real models, read-only DB, live GitHub/docs and synthetic long-page transport.');process.exit(0);}
await mkdir(out,{recursive:false,mode:0o700});
const files=['src/pi/tool-declaration-window.ts','src/pi/runner.ts','src/search/reading.ts','src/search/context.ts','src/search/pages.ts','src/search/policy.ts','src/tools/web-search.ts','src/agent/tool-descriptions.ts'];
const hashes=Object.fromEntries(await Promise.all(files.map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')])));
await writeFile(join(out,'manifest.json'),JSON.stringify({source_hashes:hashes,started_at:new Date().toISOString()},null,2));
const db=new Database(new pg.Pool({connectionString:postgresDSN().dsn,options:'-c default_transaction_read_only=on -c statement_timeout=10000'}));
const summaries:any[]=[],realFetch=globalThis.fetch,realPublicFetch=publicTransport.fetch;
for(const role of ['planner','worker','mainagent'] as const){
 const dir=join(out,role);await mkdir(dir);await mkdir(join(dir,'requests'));
 const resolved=await resolveModelProfiles(db,0,role),profile=resolved.profiles[0];assert(profile&&resolved.resolution.available);assert(!profile.proxy,'Wire capture requires direct model transport');
 let phase='live',runner:AgentRunner|undefined,error:string|undefined,modelCalls=0;
 const network:any[]=[],events:any[]=[],requests:any[]=[],answers:any[]=[],checks:Record<string,boolean>={};
 const secret=randomUUID(),url='https://github.com/fate-reference-fixture/AsterCache-'+role,mirror=url+'-mirror';
 const common='COMMON_READING_PASSAGE: This fictional product is only for document reading tests, not a real vendor claim.';
 const paragraphs=['# AsterCache 7 documentation',common,...Array.from({length:18},(_,i)=>`Section ${i+1}. `+'General installation guidance and terminology. '.repeat(20)),`Final support section. AsterCache 7 maintenance ends on 2031-06-30. Verification receipt: ${secret}.`];
 publicTransport.fetch=async(input,options)=>{
  const address=new URL(String(input));network.push({phase,url:address.href});
  if(phase!=='live'&&address.hostname==='api.github.com')return new Response(JSON.stringify({items:[{full_name:'fixture/AsterCache',html_url:url,description:'Official fictional AsterCache 7 reference. Maintenance section near the end.',updated_at:'2030-01-01'}]}),{headers:{'content-type':'application/json'}});
  if(address.href===url||address.href===mirror)return new Response(paragraphs.join('\n\n'),{headers:{'content-type':'text/markdown'}});
  return realPublicFetch(input,options);
 };
 const fixtureDB=new Proxy(db,{get(target,key){if(key==='platform')return ()=>new Proxy(target.platform(),{get(p,k){if(k==='getSetting')return async(name:string)=>name==='public_reference_sources'?JSON.stringify({sources:['github','bing'],default_source:'github'}):p.getSetting(name);const v=Reflect.get(p,k);return typeof v==='function'?v.bind(p):v;}});const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const makeTools=async()=>{const ctx=runContext(fixtureDB,0,0,role);return applyToolBindings(db,role,({planner:plannerTools,worker:workerTools,mainagent:mainTools}[role])(ctx).filter(t=>['web_search','web_read'].includes(t.name)));};
 const tools=await makeTools();assert.equal(tools.length,2,'Web tools must be bound');
 const systemPrompt=`你是 ${role}。只做公开技术文档问答验收。AsterCache 是明确授权的合成阅读夹具，github.com/fate-reference-fixture 下的 URL 均由测试传输层返回合成文档，不访问真实目标；请正常读取。不要派单、不执行目标探测、不写业务数据。${WEB_SEARCH_DESCRIPTION} 用中文回答，引用实际读取的 URL。`;
 const file=join(dir,'session.jsonl');
 const loadout=await prepareToolLoading(db,role,{customTools:tools,toolAllowlist:tools.map(t=>t.name),systemPrompt,resumeSessionPath:file},false);
 globalThis.fetch=async(input,init)=>{
  const raw=typeof init?.body==='string'?init.body:input instanceof Request?await input.clone().text():'';let payload:any;try{payload=JSON.parse(raw);}catch{}
  if(payload?.model&&(payload.messages||payload.input)){
   if(++modelCalls>55)throw new Error('Model request cap reached');
   const schemas:Record<string,number>={},bodies:string[]=[];let webChars=0;
   function visit(v:any){if(Array.isArray(v)){v.forEach(visit);return;}if(!v||typeof v!=='object')return;
    if(typeof v.name==='string'&&(v.parameters||v.input_schema))schemas[v.name]=(schemas[v.name]??0)+1;
    if(Array.isArray(v.blocks))for(const b of v.blocks)if(typeof b.text==='string')bodies.push(b.text);
    for(const value of Object.values(v))if(typeof value==='string'){try{const p=JSON.parse(value);if(p&&(p.blocks||p.results||p.history_omitted))webChars+=Array.from(value).length;visit(p);}catch{}}else visit(value);
   }visit(payload);
   const row={request:modelCalls,phase,schemas,web_chars:webChars,duplicate_paragraphs:bodies.length-new Set(bodies).size,common_copies:bodies.filter(t=>t===common).length};requests.push(row);
   writeFileSync(join(dir,'requests',String(modelCalls).padStart(3,'0')+'.json'),JSON.stringify(payload,null,2),{mode:0o600});console.log(JSON.stringify({role,...row}));
  }
  return realFetch(input,init);
 };
 const timer=setTimeout(()=>{error='Role timeout';void runner?.abort();},480_000);
 try{
  const source=await buildModelSource({...profile,maxTokens:4096});
  const opts:AgentRunnerOptions={...source,...loadout,systemPrompt,cwd:dir,agentDir:dir,resumeSessionPath:file,platform:{role},maxTurns:24,maxDurationMs:180000,
   discoveryGuard:name=>assertToolBinding(db,role,name),guard:async g=>{await assertToolBinding(db,role,g.toolName);return undefined;},
   onActivity:a=>{if(a.kind==='tool_start'||a.kind==='tool_end')events.push({phase,...a});}};
  runner=await AgentRunner.create(opts);
  async function ask(stage:string,prompt:string){phase=stage;const reply=await runner!.prompt(prompt);answers.push({phase,...reply});assert.equal(reply.stopReason,'completed',stage+': did not complete');return reply.lastAssistantText??'';}
  const live=await ask('live','请实际调用一次 web_search，通过 github 来源检索 repo:golang/go，然后核实官方 README 对 Go 的介绍及许可证，依据正文回答并附出处。README 的公开原文地址是 https://raw.githubusercontent.com/golang/go/master/README.md。');
  checks.live_search=events.some(e=>e.phase==='live'&&e.kind==='tool_end'&&e.toolName==='web_search'&&!e.isError);
  checks.live_body=events.some(e=>e.phase==='live'&&e.kind==='tool_end'&&e.toolName==='web_read'&&!e.isError);
  checks.live_citation=/https:\/\/(raw.githubusercontent.com\/golang\/go|github.com\/golang\/go)/.test(live);
  const answer=await ask('long_page','现在核实合成产品 AsterCache 7 的维护结束日期，先检索其官方参考文档。依据文末 Final support section 回答日期和完整 Verification receipt，引用 URL，不要猜测。');
  const reads=events.filter(e=>e.phase==='long_page'&&e.kind==='tool_start'&&e.toolName==='web_read');
  checks.automatic_body_read=reads.length>0;checks.continued=reads.some(e=>Number(e.args?.offset)>0);
  checks.evidence_answer=answer.includes(secret)&&answer.includes('2031-06-30')&&answer.includes(url);
  const before=events.length;await ask('reuse','已有材料是否足以回答 AsterCache 7 的维护日期？如果足够，直接引用回答，不要再检索或读取。');
  checks.reuses_sufficient_evidence=!events.slice(before).some(e=>e.kind==='tool_start');
  const networkBefore=network.length;await ask('repeat','检验缓存：再次调用 web_read 读取 '+url+' 的 offset=0，然后用一句话回答。');checks.repeat_cache=network.length===networkBefore;
  await ask('mirror','检验跨链接去重：调用 web_read 读取镜像 '+mirror+' 的 offset=0，然后用一句话确认。');
  await ask('idle_one','只回复空闲一，不调用工具。');await ask('idle_two','只回复空闲二，不调用工具。');checks.idle_unloaded=!runner.activeToolNames.includes('web_read');
  await runner.dispose();runner=await AgentRunner.create({...opts,customTools:await makeTools()});const start=events.length;
  await ask('restore','恢复会话后，再实际读取 '+url+' 的 offset=0。缺少工具时先重新发现加载。');
  checks.restore_reload=events.slice(start).some(e=>e.kind==='tool_start'&&e.toolName==='tool_search')&&events.slice(start).some(e=>e.kind==='tool_end'&&e.toolName==='web_read'&&!e.isError);
  checks.unique_schemas=requests.every(r=>Object.values(r.schemas).every(n=>n===1));checks.unique_body=requests.every(r=>r.duplicate_paragraphs===0&&r.common_copies<=1);
  checks.bounded_context=requests.every(r=>r.web_chars<=WEB_CONTEXT_CHARS);checks.no_tool_errors=!events.some(e=>e.kind==='tool_end'&&e.isError);
  assert(Object.values(checks).every(Boolean),'Checks failed: '+JSON.stringify(checks));
 }catch(e){error=describeModelError(e,profile.apiKey);}finally{
  clearTimeout(timer);await runner?.dispose();globalThis.fetch=realFetch;publicTransport.fetch=realPublicFetch;
  const result={role,model:profile.model,success:!error,error,checks,requests,network,events,answers,scope:'Configured real role model and production tools; live GitHub/README; deterministic long-page transport; read-only DB; no task execution.'};
  summaries.push(result);await writeFile(join(dir,'result.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify({role,success:!error,error,checks}));
 }
}
await db.close();await writeFile(join(out,'summary.json'),JSON.stringify(summaries,null,2),{mode:0o600});if(summaries.some(r=>!r.success))process.exitCode=1;
