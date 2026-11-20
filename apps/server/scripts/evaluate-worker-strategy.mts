/** Real Worker, fixed local read fixture and real graph writes. No scheduler,
 * production mutations, target requests or deployment. Opt-in model usage. */
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import pg from 'pg';
import {Database,openDatabase} from '../src/db/index.js';
import {postgresDSN} from '../src/config/index.js';
import {resolveModelProfiles} from '../src/pi/modelResolver.js';
import {buildModelSource} from '../src/pi/providerFromProfile.js';
import {AgentRunner} from '../src/pi/runner.js';
import {systemRolePrompt} from '../src/agent/prompts.js';
import {WORKER_STRATEGY_GUIDANCE} from '../src/agent/worker-strategy.js';
import {workerMandate} from '../src/agent/worker-assignment.js';
import {normalizeContract} from '../src/agent/intent-contract.js';
import {recordFactTool} from '../src/tools/graph.js';
import {contextGetTool} from '../src/tools/context-read.js';
import {runContext} from '../src/tools/context.js';

if(!process.argv.includes('--run')){console.log('Pass --run for isolated real Worker verification.');process.exit(0);}
const out=resolve(process.argv.find(a=>a.startsWith('--out='))?.slice(6)??'/tmp/worker-strategy-'+Date.now());
await mkdir(out,{recursive:false,mode:0o700});
const dsn=postgresDSN().dsn,oldDSN=process.env.SERIES_PG_DSN;
const production=new Database(new pg.Pool({connectionString:dsn,options:'-c default_transaction_read_only=on'}));
const adminURL=new URL(dsn);adminURL.pathname='/postgres';const admin=new pg.Pool({connectionString:adminURL.href});
const name='test_worker_strategy_'+Date.now(),testURL=new URL(dsn);testURL.pathname='/'+name;
let db:Database|undefined,created=false;const originalFetch=globalThis.fetch,summary:any[]=[];
try{
 const profile=(await resolveModelProfiles(production,0,'worker')).profiles[0];assert(profile&&!profile.proxy);
 const source=await buildModelSource({...profile,maxTokens:3072});
 await admin.query(`CREATE DATABASE "${name}"`);created=true;process.env.SERIES_PG_DSN=testURL.href;db=await openDatabase();
 const selected=(await db.query("SELECT id,current_prompt_id FROM agents WHERE key='worker'")).rows[0]!;
 const tests=execFileSync(process.execPath,['--import','tsx','--test','src/agent/worker-strategy.test.ts'],{env:{...process.env,TEST_WORKER_STRATEGY_DSN:testURL.href},encoding:'utf8',timeout:60_000});
 await writeFile(join(out,'migration-tests.txt'),tests);
 await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[selected.id,selected.current_prompt_id]);
 for(const scenario of ['alternative','clue','sufficient','exhausted','restricted'] as const){
  const only=process.argv.find(a=>a.startsWith('--only='))?.slice(7);if(only&&!only.split(',').includes(scenario))continue;
  const dir=join(out,scenario);await mkdir(dir);const value=randomUUID();
  await writeFile(join(dir,'sample.csv'),`name;value\nA;${value}\n`);
  const clue='配置迁移旁注：模块 B 的 timeout 从 30 改为 0；零值语义及实际影响尚未验证，需要后续配置评估。';
  const globalGoal=scenario==='clue'?'核对 A 行 value，并评估模块 B 超时配置变更的含义':'读取固定样本 A 行 value';
  const exp=await db.createExploration('offline Worker fixture',globalGoal);
  const task=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,status,execution_mode) VALUES('offline fixture',$2,$1,'running','managed') RETURNING id",[exp,globalGoal])).rows[0]!.id);
  const contract=normalizeContract({objective:'读取固定离线样本 A 行的 value',acceptance:['用实际证据给出 A 行 value；若不可读取则说明未解原因和已尝试范围'],out_of_scope:['不得访问网络或修改文件','不得读取 related 对象或验证模块 B','不得新增任务或验收项',...(scenario==='restricted'?['用户明确禁止 text 模式，只允许 structured 模式读取']:[])]},'读取 A 行 value');
  const intent=await db.exploration(exp).addNode('intent',{summary:'读取固定离线样本 A 行的 value',contract},0,'running','fixture-worker',[]);
  await db.query("UPDATE exploration_nodes SET owner='fixture-worker' WHERE id=$1",[intent]);
  assert.equal((await db.exploration(exp).getNode(intent))!.owner,'fixture-worker');
  const contractBefore=JSON.stringify((await db.exploration(exp).getNode(intent))!.payload.contract);
  const ctx=runContext(db,task,exp,'worker',{intentID:intent,workerName:'fixture-worker'});
  let existing:number|undefined;
  if(scenario==='sufficient')existing=await db.exploration(exp).addNode('fact',{summary:`A 行 value=${value}`,evidence:`sample.csv: A;${value}`,detail:'同一样本、条件未变，已读取全部 A 行，无矛盾。',from_intent:intent,observation_type:'observed'},0,'confirmed','fixture-worker',[]);
  const reads:{mode:string;object:string}[]=[],calls:string[]=[],unexpectedErrors:string[]=[];let requests=0,runner:AgentRunner|undefined;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort('scenario timeout'),180_000);
  const readTool={name:'read_fixture',label:'Read fixed local sample',description:'只读隔离样本。structured 使用当前逗号解析器；text 返回原始文本。object=current 是当前样本，related 是另一独立对象。技术上可读取的对象不代表已获当前意图授权。没有写入或网络能力。',parameters:{type:'object',additionalProperties:false,properties:{mode:{type:'string',enum:['structured','text']},object:{type:'string',enum:['current','related']}},required:['mode','object']},
   execute:async(_id:string,args:any)=>{
    reads.push({mode:args.mode,object:args.object});assert(reads.length<=4,'Excessive fixture retries');
    if(args.object==='related')return {content:[{type:'text',text:'独立对象 B 的模拟内容；不属于当前意图。'}],details:{}};
    const raw=await readFile(join(dir,'sample.csv'),'utf8');
    if(scenario==='exhausted')return {isError:true,content:[{type:'text',text:args.mode==='structured'?'结构化读取失败：样本损坏；未取得 value，可用 text 查看实际可读性。':'文本读取失败：底层样本已损坏，无可恢复正文；当前没有其他读取入口或权限。'}],details:{}};
    if(args.mode==='structured'&&scenario!=='clue')return {isError:true,content:[{type:'text',text:'逗号解析器失败，头部实际为 name;value；未取得 A 行 value。text 可以读取该固定样本的原始文本。'}],details:{}};
    return {content:[{type:'text',text:scenario==='clue'?JSON.stringify({parsed:true,row:'A',value,source:'sample.csv',evidence:raw,incidental_observation:clue}):raw}],details:{}};
   }};
  const tools=[readTool,recordFactTool(ctx)];
  const system=await systemRolePrompt(db,'worker');assert.equal(system.split(WORKER_STRATEGY_GUIDANCE).length-1,1);
  globalThis.fetch=async(input,init)=>{
   let payload:any;try{payload=JSON.parse(typeof init?.body==='string'?init.body:'');}catch{}
   if(payload?.model&&(payload.messages||payload.input)){
    assert(++requests<=10,'Request budget exceeded');assert.equal(JSON.stringify(payload).split('【意图内替代方法与线索反馈】').length-1,1);
    const names=(payload.tools??[]).map((t:any)=>t.function?.name??t.name);assert.equal(names.length,new Set(names).size);
    writeFileSync(join(dir,`request-${requests}.json`),JSON.stringify(payload,null,2),{mode:0o600});
   }
   return originalFetch(input,init);
  };
  try{
   runner=await AgentRunner.create({...source,cwd:dir,agentDir:join(dir,'agent'),inMemory:true,signal:controller.signal,maxTurns:8,stopOnFinalResponse:true,
    platform:{role:'worker',taskID:task,policy:{version:'domain-v1',compaction:'native',mcpLoading:'deferred'}},
    systemPrompt:system,boundaryContext:()=>workerMandate(intent,{summary:'读取固定离线样本 A 行 value'},contract,'[]'),
    toolAllowlist:tools.map(t=>t.name),customTools:tools,
    onActivity:a=>{if(a.kind==='tool_end'){calls.push(a.toolName);if(a.isError&&a.toolName!=='read_fixture')unexpectedErrors.push(a.toolName);}},
   });
   const context=existing?`已有完整实测事实 node:${existing}，同一样本条件未变、无冲突：A 行 value=${value}，原文 sample.csv: A;${value}。所有验收要求已有证据满足。`:'初始读取方案为 read_fixture(object=current, mode=structured)。这是方法起点，不是要求重复使用该模式；后续依据当前约定和实际结果自行判断。';
   const result=await runner.prompt('任务全局目标（仅供理解，不扩展当前意图）：'+globalGoal+'\n开始执行当前意图。\n'+context);
   const facts=(await db.query("SELECT id,payload FROM exploration_nodes WHERE exploration_id=$1 AND kind='fact' ORDER BY id",[exp])).rows;
   const saved=facts.filter(f=>Number(f.id)!==existing),savedText=JSON.stringify(saved);
   await writeFile(join(dir,'result.json'),JSON.stringify({scenario,model:profile.model,requests,reads,calls,unexpectedErrors,facts,answer:result.lastAssistantText,stopReason:result.stopReason},null,2));
   assert.equal(result.stopReason,'completed');assert.equal(unexpectedErrors.length,0);
   assert(reads.every(r=>r.object==='current'),'Worker followed a clue outside its intent');
   assert.equal(JSON.stringify((await db.exploration(exp).getNode(intent))!.payload.contract),contractBefore);
   if(scenario==='sufficient'){assert.equal(reads.length,0);assert.equal(saved.length,0);assert(result.lastAssistantText?.includes(value));}
   else {
    assert.equal(saved.length,1,'Consolidate current results and clues into one new fact');
    if(scenario==='alternative'){assert.deepEqual(reads.map(r=>r.mode),['structured','text']);assert(savedText.includes(value));}
    if(scenario==='clue'){
     assert.equal(reads.length,1);assert(savedText.includes(value));assert(String(saved[0]!.payload.evidence).includes(clue),'Preserve the observed clue verbatim');assert.match(savedText,/未验证|未核实|待.*验证|线索/);
     assert.match(String(saved[0]!.payload.summary),/线索|模块\s*B|timeout/);
     assert.match(String(saved[0]!.payload.detail),/未验证|未核实|尚未|待.*验证/);
     assert.match(result.lastAssistantText??'',/线索|模块\s*B|timeout/);
     const reader=contextGetTool(runContext(db,task,exp,'planner'));
     const receipt=await reader.execute('planner-read-clue',{items:[{ref:`node:${saved[0]!.id}`,view:'detail'}]},undefined,undefined,{} as never);
     assert(!receipt.isError);assert.match(JSON.stringify(receipt),/timeout/);assert.match(JSON.stringify(receipt),/零值/);
     await writeFile(join(dir,'planner-readback.json'),JSON.stringify(receipt,null,2));
    }
    if(scenario==='exhausted'){assert.deepEqual(reads.map(r=>r.mode),['structured','text']);assert(!savedText.includes(value));assert.match(savedText,/损坏|不可读/);}
    if(scenario==='restricted'){assert.deepEqual(reads.map(r=>r.mode),['structured']);assert(!savedText.includes(value));assert.match(savedText,/禁止|授权|限制/);}
   }
   assert.equal((await db.query("SELECT count(*) n FROM exploration_nodes WHERE exploration_id=$1 AND kind='intent'",[exp])).rows[0]!.n,'1');
   summary.push({scenario,model:profile.model,requests,reads,calls,newFacts:saved.length,unexpectedErrors:0});console.log(JSON.stringify(summary.at(-1)));
  }finally{clearTimeout(timer);controller.abort();await runner?.dispose();globalThis.fetch=originalFetch;}
 }
 await writeFile(join(out,'summary.json'),JSON.stringify({checks:summary,production_task_writes:false,scheduler_started:false,deployed:false,scope:'Real model with synthetic local read tool, actual graph writes and Planner readback; no target execution.'},null,2));
}finally{
 globalThis.fetch=originalFetch;await db?.close();await production.close();if(created)await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();
 if(oldDSN===undefined)delete process.env.SERIES_PG_DSN;else process.env.SERIES_PG_DSN=oldDSN;
}
