/** Opt-in real-model check of user-configured native tools. Reads one temporary
 * fixture file only; production DB is read-only and no task is started. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {Database} from '../src/db/index.js';
import {postgresDSN} from '../src/config/index.js';
import {resolveModelProfiles} from '../src/pi/modelResolver.js';
import {buildModelSource} from '../src/pi/providerFromProfile.js';
import {AgentRunner} from '../src/pi/runner.js';
import {toolLoadout} from '../src/agent/tool-loading.js';

if(!process.argv.includes('--run')){console.log('Pass --run to verify Planner, Worker and Main using configured models and a local grep fixture.');process.exit(0);}
const out=resolve(process.argv.find(a=>a.startsWith('--out='))?.slice(6)??'../../docs/reviews/evidence/configured-tools-'+Date.now());
await mkdir(out,{recursive:false,mode:0o700});
const db=new Database(new pg.Pool({connectionString:postgresDSN().dsn,options:'-c default_transaction_read_only=on'}));
const originalFetch=globalThis.fetch,summary=[];
try{
 for(const role of ['planner','worker','mainagent']){
  const dir=join(out,role);await mkdir(dir);const secret=randomUUID();await writeFile(join(dir,'fixture.txt'),'TOOL_POLICY_RECEIPT='+secret+'\n');
  const resolved=await resolveModelProfiles(db,0,role),profile=resolved.profiles[0];assert(profile&&!profile.proxy,'Requires configured direct model transport');
  const source=await buildModelSource({...profile,maxTokens:2048});
  let requests=0,called=false;const schemaCopies:number[]=[];
  globalThis.fetch=async(input,init)=>{
   let payload:any;try{payload=JSON.parse(typeof init?.body==='string'?init.body:'');}catch{}
   if(payload?.model&&(payload.messages||payload.input)){
    assert(++requests<=8,'Request budget exceeded');let count=0;
    const visit=(v:any)=>{if(!v||typeof v!=='object')return;if(v.name==='grep'&&(v.parameters||v.input_schema))count++;for(const x of Object.values(v))if(typeof x==='object')visit(x);};visit(payload);
    assert(count<=1,'Duplicate grep schema');schemaCopies.push(count);
    writeFileSync(join(dir,`request-${requests}.json`),JSON.stringify(payload,null,2),{mode:0o600});
   }
   return originalFetch(input,init);
  };
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort('verification timeout'),120_000);
  let runner:AgentRunner|undefined;
  try{
   runner=await AgentRunner.create({...source,cwd:dir,agentDir:join(dir,'agent'),inMemory:true,signal:controller.signal,maxTurns:6,
    platform:{role,taskID:0,policy:{version:'domain-v1',compaction:'native',mcpLoading:'deferred'}},
    ...toolLoadout(role,{toolAllowlist:['grep']},{overrides:{grep:'deferred'}}),
    systemPrompt:'这是用户工具配置的隔离验收。你有权使用已配置的 grep 读取当前目录中的 fixture.txt。按需工具先用 tool_search 精确加载。只读取这个本地测试文件，然后给出其中 TOOL_POLICY_RECEIPT 的完整值。',
    onActivity:a=>{if(a.kind==='tool_end'&&a.toolName==='grep'&&!a.isError)called=true;},
   });
   const result=await runner.prompt('读取 fixture.txt 中 TOOL_POLICY_RECEIPT 的值。');
   assert(called,'Model did not call grep');assert(result.lastAssistantText?.includes(secret),'Model did not read the real fixture');assert.equal(schemaCopies[0],0);
   summary.push({role,model:profile.model,requests,grep_called:true,correct_receipt:true,no_duplicate_schema:true,initially_deferred:true});
   console.log(JSON.stringify(summary.at(-1)));
  }finally{clearTimeout(timer);await runner?.dispose();globalThis.fetch=originalFetch;}
 }
 await writeFile(join(out,'summary.json'),JSON.stringify(summary,null,2));
}finally{globalThis.fetch=originalFetch;await db.close();}
