import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {classifyResourceCall} from './resource-usage.js';
import {withNativeActivity,nativeToolActivities,type NativeActivityIdentity} from './native-activity.js';
import {AgentRunner,type RunnerActivity} from './runner.js';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {openDatabase} from '../db/index.js';
import {projectActivity} from '../db/activity-projection.js';
import {projectResourceUsage,resourceUsageDetail,resourceUsageList,resourceUsageRows} from '../db/resource-usage.js';
import {runnerActivityMetadata} from '../engine/live-stream.js';
import {ActivityOutbox} from '../engine/activity-outbox.js';
import {registerNativeActivityRun,NativeActivityRecovery} from '../engine/native-activity-recovery.js';
import type {Activity} from '../db/exploration.js';
import Fastify from 'fastify';
import {registerMcpMgmtRoutes} from '../http/routes/mcp-mgmt.js';
import {registerSkillMgmtRoutes} from '../http/routes/skills-mgmt.js';
import {requireJWT,signJWT} from '../http/auth.js';

test('resource identity uses exact native registration and entry file, never tool-name guessing',()=>{
 const owners=new Map([['mcp__ambiguous_name',{server:'a__b',tool:'c__d'}]]),servers=new Map([['a__b',9]]),options={cwd:'/workspace',skillsDir:'/skills'};
 assert.deepEqual(classifyResourceCall('mcp__ambiguous_name',{},options,owners,servers),{kind:'mcp',name:'a__b',operation:'c__d',server_id:9});
 for(const tool of ['tool_search','mcp__fake__tool','bash'])assert.equal(classifyResourceCall(tool,{path:'/skills/test/SKILL.md'},options,owners,servers),undefined);
 assert.deepEqual(classifyResourceCall('read',{path:'/skills/test/SKILL.md'},options,owners,servers),{kind:'skill',name:'test',operation:'read'});
 for(const file of ['/skills/test/references/readme.md','/skills-other/test/SKILL.md','/skills/test/../SKILL.md','/skills/test/file.txt'])assert.equal(classifyResourceCall('read',{path:file},options,owners,servers),undefined);
});
test('native call identities survive replay; same tool/arguments in another response remain distinct',()=>{
 const start=withNativeActivity({kind:'tool_start',toolCallId:'same',toolName:'read',args:{path:'/skills/a/SKILL.md'}},'runtime',1);
 const result=withNativeActivity({kind:'tool_end',toolCallId:'same',toolName:'read',isError:false,text:'ok'},'runtime',1);
 assert.equal(start.native_event?.call_key,result.native_event?.call_key);
 const replay=nativeToolActivities({role:'toolResult',toolCallId:'same',toolName:'read',content:[{type:'text',text:'ok'}]}, {content:[{type:'toolCall',id:'same',name:'read',arguments:{path:'/skills/a/SKILL.md'}}]},'runtime',1);
 assert.deepEqual(replay.map(a=>a.native_event),[start.native_event,result.native_event]);
 assert.notEqual(start.native_event?.call_key,withNativeActivity(start.kind==='tool_start'?{kind:start.kind,toolName:start.toolName,toolCallId:start.toolCallId,args:start.args}:start,'runtime',2).native_event?.call_key);
});

const dsn=process.env.TEST_RESOURCE_USAGE_DSN;
test('native Skill/MCP accounting: seven roles, parallel Workers, conversations, restore, result recovery and HTTP statistics', {skip:!dsn&&'isolated PostgreSQL required'},async t=>{
 assert.match(new URL(dsn!).pathname,/^\/test_resource_usage_[a-z0-9_]+$/);process.env.SERIES_PG_DSN=dsn;
 const db=await openDatabase(),dir=await mkdtemp(path.join(tmpdir(),'fate-resource-meter-'));
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
 const skills=path.join(dir,'skills'),skill=path.join(skills,'fixture','SKILL.md');await mkdir(path.dirname(skill),{recursive:true});await writeFile(skill,'---\nname: fixture\ndescription: local synthetic instructions\n---\nLocal synthetic content.');
 const serverFile=path.join(dir,'mcp.mjs');await writeFile(serverFile,`import{createInterface}from'node:readline';for await(const l of createInterface({input:process.stdin})){const m=JSON.parse(l);if(m.id===undefined)continue;const r=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',description:'local fixture echo',inputSchema:{type:'object',properties:{fail:{type:'boolean'}}}}]}:{content:[{type:'text',text:'local fixture'}],isError:!!m.params.arguments.fail};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:r})+'\\n');}`);
 const exp=await db.createExploration('synthetic resource metering','local fixture'),task=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,paused,status) VALUES('synthetic','local',$1,true,'paused') RETURNING id",[exp])).rows[0]!.id);
 const serverID=Number((await db.query("INSERT INTO mcp_servers(name,transport,command) VALUES('usage_fixture','stdio','node') RETURNING id")).rows[0]!.id);
 const captured:Activity[]=[];let executions=0, nextIntent=100;
 async function run(role:string,opts:{conversation?:boolean;bound?:boolean;mcp?:boolean;dropEnd?:boolean;resume?:string}={}){
  const id=randomUUID(),turnID=randomUUID(),sessionFile=opts.resume??path.join(dir,id+'.jsonl');
  const taskID=opts.conversation&&!opts.bound?null:task; const intentID=role==='worker'?++nextIntent:undefined;
  let identity:NativeActivityIdentity={source:{scope:'task',scopeID:exp,taskID:task},worker:role,turn_id:turnID};
  let conversation:number|undefined;
  if(opts.conversation){
   conversation=Number((await db.query('INSERT INTO conversations(agent_key) VALUES($1) RETURNING id',[role])).rows[0]!.id);
   const runID=Number((await db.query("INSERT INTO conversation_runs(conversation_id,message,token,turn_id,status) VALUES($1,'synthetic',$2,$3,'running') RETURNING id",[conversation,id,turnID])).rows[0]!.id);
   identity={source:{scope:'conversation',scopeID:conversation,runID,token:id,turnID},worker:'assistant',turn_id:turnID};
  }
  await db.query("INSERT INTO runtime_role_configs(id,task_id,conversation_id,role,configured,effective,expires_at) VALUES($1,$2,$3,$4,'{}',$5::jsonb,now()+interval '5 minutes')",[id,taskID,conversation??null,role,JSON.stringify({usage_scope:{turnID,intentID}})]);
  const runtime=await ModelRuntime.create({authPath:path.join(dir,id+'-auth.json'),modelsPath:path.join(dir,id+'-models.json'),refreshOnCreate:false});
  const faux=fauxProvider({provider:'local-'+id});runtime.registerNativeProvider(faux.provider);
  const responses=opts.mcp?[fauxAssistantMessage([fauxToolCall('tool_search',{query:'usage_fixture echo'})]),fauxAssistantMessage([fauxToolCall('mcp__usage_fixture__echo',{})]),fauxAssistantMessage([fauxToolCall('mcp__usage_fixture__echo',{fail:true})]),fauxAssistantMessage('done')]:[fauxAssistantMessage([fauxToolCall('read',{path:skill})]),fauxAssistantMessage('done')];
  faux.setResponses(responses);
  const activities:Activity[]=[];
  const runner=await AgentRunner.create({cwd:dir,agentDir:dir,resumeSessionPath:sessionFile,modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Read local fixtures only.',toolAllowlist:opts.mcp?['mcp__*']:['read'],skillsDir:skills,allowedSkills:['fixture'],nativeActivityRuntime:id,
   resourceServers:new Map([['usage_fixture',serverID]]),...(opts.mcp?{mcpEntries:[{name:'usage_fixture',config:{transport:'stdio',command:process.execPath,args:[serverFile],exposure:'deferred'}}]}:{}),
   onActivity:async a=>{
    if(!['tool_start','tool_end'].includes(a.kind))return;
    const event=a as Extract<RunnerActivity,{kind:'tool_start'|'tool_end'}>;
    const detail=event.kind==='tool_start'?JSON.stringify(event.args):event.text??'';
    const activity:Activity={worker:identity.worker,kind:event.kind==='tool_start'?'tool_use':'tool_result',tool:event.toolName,tool_use_id:event.toolCallId,is_error:event.kind==='tool_end'&&event.isError,detail,summary:detail.slice(0,80),metadata:{turn_id:turnID,...runnerActivityMetadata(event)}};
    activities.push(activity);captured.push(activity);
    if(event.kind==='tool_end'){executions++;if(opts.dropEnd)return;}
    await db.transaction(tx=>projectActivity(tx,identity.source,activity,true));
   }});
  await registerNativeActivityRun(db,id,runner,identity);
  try{await runner.prompt('local fixture');}finally{await runner.dispose();}
  await db.query('UPDATE runtime_role_configs SET finished_at=now(),expires_at=now() WHERE id=$1',[id]);
  // Replay through an independent native-file recovery object (new executor).
  const recovery=new NativeActivityRecovery(db,dir);
  await recovery.recover(id);await recovery.recover(id);await recovery.close();
  await Promise.all([1,2].map(()=>db.transaction(async tx=>{for(const a of activities)await projectActivity(tx,identity.source,a,true);}))); // duplicates across consumers
  return {id,sessionFile,conversation,activities,identity};
 }
 const runs=[];
 for(const role of ['goals','planner','mainagent','auto','pentest','reporter'])runs.push(await run(role,{conversation:['auto','pentest','reporter'].includes(role),bound:role!=='auto'}));
 runs.push(...await Promise.all([run('worker',{dropEnd:true}),run('worker')]));
 runs.push(await run('mainagent',{resume:runs[2]!.sessionFile}));
 const mcp=await run('worker',{mcp:true,dropEnd:true});
 let skillStats=(await resourceUsageList(db,'skill')).get('fixture')!;
 assert.equal(skillStats.calls,9);assert.equal(skillStats.succeeded,9);assert.equal(skillStats.conversations,3);assert.equal(skillStats.tasks,1);assert.equal(skillStats.usage_agents.length,7);
 const mcpStats=(await resourceUsageList(db,'mcp')).get(String(serverID))!;assert.equal(mcpStats.calls,2);assert.equal(mcpStats.succeeded,1);assert.equal(mcpStats.failed,1);
 assert.equal(Number((await db.query("SELECT count(DISTINCT intent_id) n FROM resource_usage WHERE agent_key='worker'")).rows[0]!.n),3);
 await db.query("INSERT INTO mcp_tools_cache(server_id,tool_name,description) VALUES($1,'echo','fixture')",[serverID]);
 assert.equal((await db.query(`SELECT count(*) n FROM (${resourceUsageRows}) u WHERE source='native-v1'`)).rows[0]!.n,'11');
 // Result delivered before start; then repeat it. No lost completion or double count.
 const example=runs[0]!,start=example.activities.find(a=>a.kind==='tool_use')!,end=example.activities.find(a=>a.kind==='tool_result')!;
 await db.query('DELETE FROM resource_usage WHERE runtime_id=$1',[example.id]);
 await db.transaction(async tx=>{await projectResourceUsage(tx,end,end.metadata!.native_event as any);await projectResourceUsage(tx,start,start.metadata!.native_event as any);});
 assert.equal((await resourceUsageList(db,'skill')).get('fixture')!.succeeded,9);
 // DB rollback then durable receipt replay preserves exactly one call.
 const count=Number((await db.query('SELECT count(*) n FROM resource_usage')).rows[0]!.n);
 await assert.rejects(db.transaction(async tx=>{await projectResourceUsage(tx,start,start.metadata!.native_event as any);throw new Error('injected database failure');}));
 assert.equal(Number((await db.query('SELECT count(*) n FROM resource_usage')).rows[0]!.n),count);
 // Real fsynced activity outbox survives transaction failure and a fresh consumer.
 await db.query('DELETE FROM resource_usage WHERE runtime_id=$1',[example.id]);
 const realTransaction=db.transaction.bind(db);let unavailable=true;
 const flaky=new Proxy(db,{get(target,key){if(key==='transaction')return (...args:Parameters<typeof db.transaction>)=>unavailable?Promise.reject(new Error('fixture DB unavailable')):realTransaction(...args);const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const outbox=new ActivityOutbox(flaky,dir),journal=outbox.writer(example.identity.source);
 await assert.rejects(journal.append(start),/fixture DB unavailable/);
 await assert.rejects(journal.append(end),/fixture DB unavailable/);
 await assert.rejects(journal.close(),/fixture DB unavailable/);await outbox.close();unavailable=false;
 const replay=new ActivityOutbox(db,dir);await replay.replay();await replay.replay();await replay.close();
 assert.equal((await resourceUsageList(db,'skill')).get('fixture')!.calls,9);
 assert.equal((await resourceUsageList(db,'skill')).get('fixture')!.succeeded,9);

 // Interrupted attempts have unknown results, not fabricated successes.
 await db.query("UPDATE resource_usage SET outcome='pending',finished_at=NULL WHERE runtime_id=$1",[example.id]);
 assert.equal((await resourceUsageList(db,'skill')).get('fixture')!.unknown,1);
 await db.transaction(tx=>projectResourceUsage(tx,end,end.metadata!.native_event as any));
 const detail=await resourceUsageDetail(db,'mcp',serverID,1);assert.equal(detail.calls.length,1);assert.equal(detail.stats[0]!.calls,2);
 const app=Fastify();app.decorate('db',db);app.decorate('skillsRoot',skills);app.addHook('preHandler',requireJWT('fixture-key'));registerMcpMgmtRoutes(app);registerSkillMgmtRoutes(app);
 try{const h={authorization:`Bearer ${signJWT('fixture-key')}`};assert.equal((await app.inject({url:`/api/mcp/${serverID}/tools`,headers:h})).json().tools[0].calls,2);assert.equal((await app.inject(`/api/mcp/${serverID}/usage`)).statusCode,401);const headers={authorization:`Bearer ${signJWT('fixture-key')}`};for(const url of [`/api/mcp/${serverID}/usage`,'/api/skills/fixture/usage']){const r=await app.inject({url,headers});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().metering.version,'native-v1');}}
 finally{await app.close();}
 // Removing domain/config/history records cannot erase already metered usage.
 await db.query('DELETE FROM conversations WHERE id=ANY($1::bigint[])',[runs.flatMap(r=>r.conversation?[r.conversation]:[])]);
 await db.query('DELETE FROM mcp_servers WHERE id=$1',[serverID]);
 assert.equal(Number((await db.query('SELECT count(*) n FROM resource_usage')).rows[0]!.n),11);
 assert.equal(executions,12,'nine reads, one search and two MCP tools; recovery never reexecutes');
 // Kill a real child after native result persistence but before result projection.
 const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/resource-usage-crash.ts',import.meta.url))],{env:{...process.env,RESOURCE_CRASH_DIR:dir,TEST_RESOURCE_USAGE_DSN:dsn},stdio:['ignore','pipe','pipe']});
 let errors='';child.stderr.on('data',b=>errors+=b);const signal=await new Promise<string|null>((resolve,reject)=>{child.on('error',reject);child.on('exit',(_code,signal)=>resolve(signal));});assert.equal(signal,'SIGKILL',errors);
 const crash=JSON.parse(await readFile(path.join(dir,'crash-runtime.json'),'utf8'));
 assert.equal((await db.query('SELECT outcome FROM resource_usage WHERE runtime_id=$1',[crash.id])).rows[0]!.outcome,'pending');
 await db.query("UPDATE runtime_role_configs SET expires_at=now()-interval '1 second' WHERE id=$1",[crash.id]);
 assert.equal((await resourceUsageList(db,'skill')).get('fixture')!.unknown,1);
 const restarted=new NativeActivityRecovery(db,dir);await restarted.recover(crash.id);await restarted.recover(crash.id);await restarted.close();
 assert.equal((await db.query('SELECT outcome FROM resource_usage WHERE runtime_id=$1',[crash.id])).rows[0]!.outcome,'succeeded');
 assert.equal((await resourceUsageList(db,'skill')).get('fixture')!.calls,10);
 assert.equal((await resourceUsageList(db,'skill')).get('fixture')!.succeeded,10);

});
