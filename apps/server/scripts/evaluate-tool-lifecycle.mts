/** Opt-in three-role real-provider lifecycle check. Business implementations are
 * fixtures; registration, schemas, discovery, retirement and PI sessions are real. */
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import pg from 'pg';
import type {ExtensionFactory, ToolDefinition} from '@earendil-works/pi-coding-agent';
import {Database} from '../src/db/index.js';
import {postgresDSN} from '../src/config/index.js';
import {resolveModelProfiles} from '../src/pi/modelResolver.js';
import {buildModelSource, describeModelError} from '../src/pi/providerFromProfile.js';
import {AgentRunner, type AgentRunnerOptions} from '../src/pi/runner.js';
import {platformPolicy} from '../src/pi/platform-policy.js';
import {roleDefinitions} from '../src/agent/tool-catalog.js';
import {applyToolBindings} from '../src/agent/tool-bindings.js';
import {assertToolBinding, TOOL_ALIASES} from '../src/agent/tool-registry.js';
import {prepareToolLoading} from '../src/agent/tool-loading.js';

const args = new Map(process.argv.slice(2).map(arg => {const [k,...v]=arg.split('=');return [k!,v.join('=')];}));
const roles = ['planner','worker','mainagent'] as const;
const output = resolve(args.get('--out') || '../../docs/reviews/evidence/tool-lifecycle-'+Date.now());
const requestLimit = 28, timeoutMs = 240_000;
const plan = {
  roles, target_tool:'asset_get', request_limit_per_role:requestLimit, timeout_ms_per_role:timeoutMs,
  phases:['catalog_keyword_discovery','continuous_call','idle_1','idle_2','reload','idle_3','idle_4','disk_restore_reload'],
  capture:'Full JSON request bodies at global fetch immediately before transport, plus PI before_provider_request payloads. No authorization headers or credentials are saved.',
  scope:'Current role definitions, live bindings, role model resolution, prepareToolLoading and production AgentRunner. Only business execute handlers are replaced with synthetic in-memory receipts. No native execution tools or MCP connections.',
  limits:'Not a scheduler/dispatch integration test. Task and production DB writes are excluded. Model output capped at 4096 tokens for this test; configured thinking and protocol retained.',
};
if(!args.has('--run')){console.log(JSON.stringify(plan,null,2));process.exit(0);}
await mkdir(output,{recursive:false,mode:0o700});
const db = new Database(new pg.Pool({connectionString:postgresDSN().dsn,options:'-c default_transaction_read_only=on -c statement_timeout=10000'}));
const hash = (value:unknown) => createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const canonical = (v:any):any => Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const results:any[]=[];
const sourceFiles=['scripts/evaluate-tool-lifecycle.mts','src/agent/tool-loading.ts','src/agent/tool-registry.ts','src/agent/tool-bindings.ts','src/pi/tool-declaration-window.ts','src/pi/tool-discovery.ts','src/pi/platform-mcp.ts','src/pi/runner.ts'];
const sourceHashes:Record<string,string>={};
for(const file of sourceFiles){const text=await readFile(file,'utf8');sourceHashes[file]=hash(text);const dest=join(output,'source',file);await mkdir(resolve(dest,'..'),{recursive:true});await writeFile(dest,text);}
await writeFile(join(output,'manifest.json'),JSON.stringify({...plan,started_at:new Date().toISOString(),source_hashes:sourceHashes},null,2));
console.log(JSON.stringify({event:'start',output,...plan}));

async function run(role:typeof roles[number]) {
  const dir=join(output,role);await mkdir(dir);await mkdir(join(dir,'requests'));
  const resolved=await resolveModelProfiles(db,0,role),profile=resolved.profiles[0];
  assert(profile&&resolved.resolution.available,'No enabled role model');
  // This capture deliberately fails closed rather than silently labelling an SDK
  // hook as a wire body when an explicit proxy bypasses global fetch.
  assert(!profile.proxy,'This wire recorder requires a direct configured model transport');
  const policy=await platformPolicy(db,role);
  assert.equal(policy.builtinLoading,'deferred','Current role is not configured for idle retirement');
  const definitions=await applyToolBindings(db,role,roleDefinitions(db,role).filter(t=>!TOOL_ALIASES[t.name]));
  assert(definitions.some(t=>t.name==='asset_get'),'asset_get is not bound to this role');
  let stage='discover',version=1,receipt=randomUUID(),runner:AgentRunner|undefined,timedOut=false;
  const calls:any[]=[],events:any[]=[],requests:any[]=[],sdkRequests:any[]=[],usage:any[]=[],phases:any[]=[];
  const replies:any[]=[];
  const body=(data:unknown,isError=false)=>({content:[{type:'text' as const,text:JSON.stringify(data)}],details:{},...(isError?{isError:true}:{})});
  const tools=definitions.map(t=>({...t,execute:async(_id:string,input:any)=>{
    calls.push({stage,name:t.name,input,version,request:requests.length});
    if(t.name==='asset_get'){
      if(!Array.isArray(input.ids)||!input.ids.includes(101))return body({error:'Fixture asset ID is 101'},true);
      return body({items:[{id:101,version,identity:{title:'合成资产，非真实目标'},fingerprint:{database:'CedarDB 8.'+version,middleware:'OrchidAS 2.'+version},receipt}],source:'isolated fixture'});
    }
    if(t.name==='context_search')return body({items:[],hint:'本次样本在资产资料中，使用工具目录查找资产读取能力。'});
    return body({error:'此验收只需要读取合成资产；未执行任何业务动作。'},true);
  }} as ToolDefinition));
  const systemPrompt=`你是 ${role}，正在隔离环境验收内置工具的加载生命周期。所有业务工具实现均为内存样本。依据当前工具声明和真实回执完成用户要求，不猜测未读内容，不派单、不写事实、不执行目标探测。每个读取阶段只需调用一次正确的资产详情工具，最终回复包含数据库版本和完整 receipt。没有要求读取时严格不调用工具。无需请求人工确认。`;
  const session=join(dir,'session.jsonl');
  const loadout=await prepareToolLoading(db,role,{customTools:tools,toolAllowlist:tools.map(t=>t.name),systemPrompt,resumeSessionPath:session},false);
  assert(loadout.toolLoading.deferred.includes('asset_get'));
  const target=loadout.customTools.find(t=>t.name==='asset_get')!;
  await writeFile(join(dir,'loadout.json'),JSON.stringify({model:resolved.resolution,thinking:profile.thinkingType,output_cap:4096,policy,loading:loadout.toolLoading,schemas:loadout.customTools.map(({name,description,parameters})=>({name,description,parameters}))},null,2));
  function inspect(payload:any) {
    const declarations=(payload.tools??[]).map((t:any)=>t.function??t);
    const counts:Record<string,number>={};const descriptions:Record<string,number>={};
    function walk(value:any,depth=0){
      if(depth>40)return;
      if(typeof value==='string'){
        if(value.includes(target.description))descriptions.asset_get=(descriptions.asset_get??0)+value.split(target.description).length-1;
        if(value.startsWith('{')||value.startsWith('[')){try{walk(JSON.parse(value),depth+1);}catch{/* ordinary text */}}
      }else if(value&&typeof value==='object'){
        if(typeof value.name==='string'&&(value.parameters||value.input_schema))counts[value.name]=(counts[value.name]??0)+1;
        for(const v of Object.values(value))walk(v,depth+1);
      }
    }
    walk(payload);
    const selected=declarations.find((t:any)=>t.name==='asset_get');
    return {tools:declarations.map((t:any)=>t.name),schema_occurrences:counts,target_description_occurrences:descriptions.asset_get??0,
      target_schema_hash:selected?hash(canonical(selected.parameters??selected.input_schema)):null,
      schema_bytes:Buffer.byteLength(JSON.stringify(payload.tools??[])),body_bytes:Buffer.byteLength(JSON.stringify(payload))};
  }
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{
    const text=typeof init?.body==='string'?init.body:input instanceof Request?await input.clone().text():'';
    let payload:any;try{payload=JSON.parse(text);}catch{/* Ignore catalog and non-model traffic. */}
    if(payload?.model&&(payload.messages||payload.input)){
      if(requests.length>=requestLimit)throw new Error('Real model request cap reached');
      const seq=requests.length+1,entry={seq,stage,...inspect(payload)};
      requests.push(entry);writeFileSync(join(dir,'requests',String(seq).padStart(3,'0')+'-wire.json'),JSON.stringify(payload,null,2),{mode:0o600});
      console.log(JSON.stringify({event:'request',role,seq,stage,target_schema_copies:entry.schema_occurrences.asset_get??0,tools:entry.tools.length}));
    }
    return originalFetch(input,init);
  };
  const instrumentation:ExtensionFactory=api=>{
    api.on('before_provider_request',event=>{
      const entry={seq:sdkRequests.length+1,stage,...inspect(event.payload)};sdkRequests.push(entry);
      writeFileSync(join(dir,'requests',String(entry.seq).padStart(3,'0')+'-sdk.json'),JSON.stringify(event.payload,null,2),{mode:0o600});
    });
  };
  const controller=new AbortController();
  const timer=setTimeout(()=>{timedOut=true;controller.abort('Lifecycle test timeout');void runner?.abort();},timeoutMs);
  let error:string|undefined;
  try{
    const source=await buildModelSource({...profile,maxTokens:4096});
    const options:AgentRunnerOptions={...source,...loadout,cwd:dir,agentDir:dir,resumeSessionPath:session,systemPrompt,
      contextLayout:'stable-prefix-v1',platform:{role,taskID:0,policy},signal:controller.signal,maxTurns:requestLimit,maxDurationMs:timeoutMs,
      discoveryGuard:name=>assertToolBinding(db,role,name),guard:async g=>{await assertToolBinding(db,role,g.toolName);return undefined;},
      extensionFactories:[instrumentation],onActivity:e=>{if(e.kind==='tool_start'||e.kind==='tool_end')events.push({stage,request:requests.length,...e});},
      onRawEvent:e=>{if(e.type==='message_end'&&e.message.role==='assistant')usage.push({stage,stop_reason:e.message.stopReason,...e.message.usage});}};
    runner=await AgentRunner.create(options);
    async function prompt(name:string,text:string,read=false){
      stage=name;const start=requests.length,callStart=calls.length,eventStart=events.length;
      const response=await runner!.prompt(text);
      const made=calls.slice(callStart),phaseEvents=events.slice(eventStart);
      phases.push({stage:name,requests:requests.length-start,active_after:runner!.activeToolNames,tool_calls:made.map(c=>c.name),
        searches:phaseEvents.filter(e=>e.kind==='tool_start'&&e.toolName==='tool_search').map(e=>e.args),
        fresh_receipt:read?response.lastAssistantText?.includes(receipt):undefined,stop_reason:response.stopReason});
      replies.push({stage:name,...response});
      assert.equal(response.stopReason,'completed',`${name}: model did not complete`);
      if(read){assert.equal(made.filter(c=>c.name==='asset_get').length,1,`${name}: expected one fresh read`);assert(response.lastAssistantText?.includes(receipt),`${name}: missing actual receipt`);}
      else assert.equal(made.length,0,`${name}: unexpected business call during idle`);
    }
    await prompt('discover','先用 tool_search 的 catalog 模式查看可用目录，再以 keyword 模式搜索“读取资产身份和指纹详情”。依据候选选择合适工具读取资产 ID 101；必要时用候选完整名称精确加载。只回复数据库版本和完整 receipt。',true);
    version++;receipt=randomUUID();
    await prompt('continuous','请再次读取资产 ID 101 的当前详情，返回新版本和完整 receipt。继续使用已经可调用的读取工具。',true);
    await prompt('idle_1','本轮只回复“空闲一”，不调用任何工具。');
    await prompt('idle_2','本轮只回复“空闲二”，不调用任何工具。');
    assert(!runner.activeToolNames.includes('asset_get'),'Tool did not retire after idle requests');
    version++;receipt=randomUUID();
    await prompt('reload','资产 ID 101 的资料已更新。请重新读取当前详情，返回新的数据库版本和完整 receipt。遵循当前声明，缺少能力时从工具目录发现并加载。',true);
    await prompt('idle_3','本轮只回复“空闲三”，不调用任何工具。');
    await prompt('idle_4','本轮只回复“空闲四”，不调用任何工具。');
    assert(!runner.activeToolNames.includes('asset_get'));
    const historyBefore=await readFile(session,'utf8');
    await runner.dispose();runner=await AgentRunner.create(options);
    version++;receipt=randomUUID();
    await prompt('restore','会话已恢复，资产 ID 101 的资料再次更新。请读取其当前详情，返回新的数据库版本和完整 receipt。遵循当前声明，缺少能力时从工具目录发现并加载。',true);
    const checks={
      catalog_seen:events.some(e=>e.kind==='tool_start'&&e.toolName==='tool_search'&&e.args?.mode==='catalog'),
      keyword_seen:events.some(e=>e.kind==='tool_start'&&e.toolName==='tool_search'&&e.args?.mode==='keyword'),
      initial_schema_absent:!requests[0]?.tools.includes('asset_get'),
      continuous_no_search:phases.find(p=>p.stage==='continuous')?.searches.length===0,
      idle_unloaded:['idle_2','idle_4'].every(s=>requests.some(r=>r.stage===s&&!r.tools.includes('asset_get'))),
      reload_found:['reload','restore'].every(s=>phases.find(p=>p.stage===s)?.searches.length>0&&phases.find(p=>p.stage===s)?.fresh_receipt),
      restore_initial_schema_absent:!requests.find(r=>r.stage==='restore')?.tools.includes('asset_get'),
      no_duplicate_schemas:requests.every(r=>Object.values(r.schema_occurrences).every(n=>Number(n)===1)),
      no_duplicate_target_help:requests.every(r=>r.target_description_occurrences===(r.tools.includes('asset_get')?1:0)),
      stable_reloaded_schema:new Set(requests.map(r=>r.target_schema_hash).filter(Boolean)).size===1,
      hook_matches_wire:requests.length===sdkRequests.length&&requests.every((r,i)=>JSON.stringify(r.tools)===JSON.stringify(sdkRequests[i].tools)&&r.target_schema_hash===sdkRequests[i].target_schema_hash),
      no_tool_errors:!events.some(e=>e.kind==='tool_end'&&e.isError),
      original_history_preserved:(await readFile(session,'utf8')).startsWith(historyBefore),
    };
    assert(Object.values(checks).every(Boolean),'Lifecycle checks failed: '+JSON.stringify(checks));
    await finish(checks);
  }catch(e){error=describeModelError(e,profile.apiKey);await finish({});}
  finally{clearTimeout(timer);await runner?.dispose();globalThis.fetch=originalFetch;}
  async function finish(checks:Record<string,boolean>){
    const totals={input:0,output:0,cacheRead:0,cacheWrite:0};for(const u of usage)for(const k of Object.keys(totals) as (keyof typeof totals)[])totals[k]+=Number(u[k]??0);
    const result={role,model:resolved.resolution,success:!error&&!timedOut,checks,error,timed_out:timedOut,requests:requests.length,usage:totals,
      total_tokens:Object.values(totals).reduce((a,b)=>a+b,0),request_shapes:requests,phases,events,replies};
    await writeFile(join(dir,'result.json'),JSON.stringify(result,null,2),{mode:0o600});results.push(result);
    await writeFile(join(output,'summary.json'),JSON.stringify({plan,results},null,2),{mode:0o600});
    console.log(JSON.stringify({event:'role_complete',role,success:result.success,requests:requests.length,error,checks}));
  }
}
try{for(const role of roles){try{await run(role);}catch(e){results.push({role,success:false,error:String(e)});console.error(role,String(e));}}}
finally{await db.close();}
await writeFile(join(output,'summary.json'),JSON.stringify({plan,results},null,2),{mode:0o600});
if(results.length!==3||results.some(r=>!r.success))process.exitCode=1;
console.log(JSON.stringify({event:'complete',output,success:results.length===3&&results.every(r=>r.success)}));
