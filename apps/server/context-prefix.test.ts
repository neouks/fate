import {beforeAll,afterAll,it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import path from 'node:path';import pg from 'pg';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {openDatabase,type Database} from './src/db/index.js';
import {runWorkerIntent,runPlannerRound,configureAgentEnv} from './src/agent/roles.js';
import {hostProtocol} from './src/agent/prompts.js';
import {plannerRoundMessage} from './src/agent/prompt-context.js';
import {stableToolPayload} from './src/pi/request-prefix.js';
import {TodoStore} from './src/tools/context.js';
import {AgentRunner} from './src/pi/runner.js';

const name=`fate_prefix_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-prefix-'));let db:Database;
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;db=await openDatabase();await db.query("UPDATE agents SET max_turns=0,run_seconds=0 WHERE key IN ('planner','worker')");});
afterAll(async()=>{configureAgentEnv({});await db.close();const c=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await c.connect();await c.query(`DROP DATABASE ${name}`);await c.end();rmSync(dir,{recursive:true,force:true});});
async function fixture(){
 const task=await db.tasks().createTaskWithOptions('LOCAL prefix','LOCAL goal',{}),s=db.exploration(task.exploration_id);
 const f=fauxProvider({provider:`prefix-${task.id}`}),modelRuntime=await ModelRuntime.create({refreshOnCreate:false});await modelRuntime.registerNativeProvider(f.provider);
 return {task,s,f,model:{modelRuntime,model:f.getModel() as never}};
}
it('canonicalizes only function schemas, preserving calls, schema arrays, disabled loadouts and mixed tools',()=>{
 const messages=[{role:'assistant',tool_calls:[{id:'second'},{id:'first'}]}];
 const a={type:'function',function:{name:'a',parameters:{required:['z','a'],properties:{z:{type:'string'},a:{type:'number'}}}}};
 const b={function:{parameters:{type:'object'},name:'b'},type:'function'};
 const one=stableToolPayload({messages,tools:[b,a]}) as any,two=stableToolPayload({messages,tools:[a,b]});
 expect(one).toEqual(two);expect(one.messages).toBe(messages);expect(one.tools[0].function.parameters.required).toEqual(['z','a']);
 expect((stableToolPayload({tools:[b]}) as any).tools).toHaveLength(1);
 const mixed={tools:[{type:'web_search'},a]};expect(stableToolPayload(mixed)).toBe(mixed);
});
it('keeps every bounded overview item/version and moves only current events behind stable task data',()=>{
 const overview={goals:[{id:1,text:'goal-marker'}],recent_facts:[{id:3,summary:'fact-three'},{id:2,summary:'fact-two'}],todos:['duplicate'],worker_capabilities:{tools:['read']}};
 const before=JSON.stringify(overview),msg=plannerRoundMessage(overview,['todo-marker'],[{ref:'node:3',version:2,summary:'changed-version'}],[{id:'event-marker'}],'trigger-marker');
 expect(JSON.stringify(overview)).toBe(before);
 for(const key of ['goal-marker','fact-three','fact-two','todo-marker','changed-version','event-marker','trigger-marker'])expect(msg).toContain(key);
 expect(msg.indexOf('goal-marker')).toBeLessThan(msg.indexOf('event-marker'));expect(msg.indexOf('todo-marker')).toBeLessThan(msg.indexOf('event-marker'));expect(msg).not.toContain('duplicate');
});
it('assembles Worker custom role and Skill before mandate, keeps live constraints once and recovers saved facts',async()=>{
 const {task,s,f,model}=await fixture();const skills=path.join(dir,'skills');mkdirSync(path.join(skills,'recall'),{recursive:true});
 writeFileSync(path.join(skills,'recall','SKILL.md'),'---\nname: recall\ndescription: LOCAL read evidence on demand\n---\nNEVER_PRELOAD_SKILL_BODY\n');
 configureAgentEnv({skillsDir:skills});const agent=(await db.platform().getAgentByKey('worker'))!;
 await db.platform().savePrompt(agent.id,'CUSTOM worker $& literal','test','fixture');
 await db.query("INSERT INTO agent_skill_visibility(agent_id,skill_name,enabled) VALUES($1,'recall',true)",[agent.id]);
 const id=await s.addIntent({summary:'mandate-marker',dispatch_requested:true},5,[],'user'),intent=(await s.claimNextWorker('worker-local'))!;
 await db.query("INSERT INTO task_constraints(exploration_id,kind,text,origin) VALUES($1,'deny','old-constraint','user')",[task.exploration_id]);
 let factID=0;
 f.setResponses([async ctx=>{
  const text=JSON.stringify(ctx.messages);expect(text).toContain('CUSTOM worker $& literal');expect(text).not.toContain('NEVER_PRELOAD_SKILL_BODY');
  expect(text.indexOf('<skills>')).toBeLessThan(text.indexOf('mandate-marker'));
  expect(text.split(hostProtocol('worker')).length-1).toBe(1);expect(text.split('old-constraint').length-1).toBe(1);
  await db.query("UPDATE task_constraints SET text='new-constraint' WHERE exploration_id=$1",[task.exploration_id]);
  return fauxAssistantMessage([fauxToolCall('record_fact',{summary:'saved-before-resume',evidence:'LOCAL synthetic evidence'})]);
 },ctx=>{const text=JSON.stringify(ctx.messages);expect(text).toContain('new-constraint');expect(text).not.toContain('old-constraint');return fauxAssistantMessage('LOCAL saved');}]);
 const opts={db,taskID:task.id,expID:task.exploration_id,workerName:'worker-local',intent,model,dataDir:dir,hooks:{},maxTurns:5,onActivity:()=>{}};
 try{
  await runWorkerIntent(opts);factID=(await s.listByKind('fact')).find(n=>n.payload.summary==='saved-before-resume')!.id;
  f.setResponses([ctx=>{const text=JSON.stringify(ctx.messages);expect(text).toContain(`node:${factID}`);expect(text).toContain('new-constraint');expect(text).toContain('宿主执行上下文');return fauxAssistantMessage([fauxToolCall('context_get',{items:[{ref:`node:${factID}`,field:'/payload/evidence'}]})]);},ctx=>{expect(JSON.stringify(ctx.messages)).toContain('LOCAL synthetic evidence');return fauxAssistantMessage('Already saved, no duplicate write.');}]);
  await runWorkerIntent(opts);expect((await s.listByKind('fact')).filter(n=>n.payload.summary==='saved-before-resume')).toHaveLength(1);
 }finally{configureAgentEnv({});await db.query('UPDATE agents SET current_prompt_id=NULL WHERE id=$1',[agent.id]);}
});
it('Planner reads facts and completed work outside the startup window and rejects a duplicate dispatch',async()=>{
 const {task,s,f,model}=await fixture();
 const detail='完整冷图证据😀'.repeat(600),fact=await s.addNode('fact',{summary:'buried-observation',detail,evidence:'LOCAL'},0,'confirmed','test',[]);
 const digest=await s.addNode('digest',{summary:'LOCAL cold index',member_ids:[fact]},0,'active','test',[]);await s.link(digest,'covers',fact);
 let recalled='';
 const old=await s.addIntent({summary:'LOCAL already completed direction'},5,[],'planner');await s.setIntentState(old,'done');
 for(let i=0;i<25;i++){await s.addNode('fact',{summary:`newer ${i}`,detail:'NOT_PRELOADED',evidence:'LOCAL'},0,'confirmed','test',[]);const id=await s.addIntent({summary:`different ${i}`},5,[],'planner');await s.setIntentState(id,'done');}
 f.setResponses([
  ctx=>{const text=JSON.stringify(ctx.messages);expect(text).not.toContain('NOT_PRELOADED');expect(text).not.toContain(detail);return fauxAssistantMessage([fauxToolCall('context_search',{types:['fact'],q:'buried-observation'}),fauxToolCall('context_search',{types:['intent'],q:'LOCAL already completed direction'})]);},
  ctx=>{const text=JSON.stringify(ctx.messages);expect(text).toContain(`node:${fact}`);expect(text).toContain(`node:${old}`);return fauxAssistantMessage([fauxToolCall('context_get',{items:[{ref:`node:${fact}`,field:'/payload/detail'}],max_chars:8000}),fauxToolCall('add_intent',{intents:[{summary:'LOCAL already completed direction'}]})]);},
  ctx=>{const result=ctx.messages.filter((m:any)=>m.role==='toolResult'&&m.toolName==='context_get').at(-1) as any;const page=JSON.parse(result.content[0].text).items[0];expect(page.next_offset).toBeGreaterThan(0);recalled+=page.content;return fauxAssistantMessage([fauxToolCall('context_get',{items:[{ref:`node:${fact}`,field:'/payload/detail',version:page.version,offset:page.next_offset}]})]);},
  ctx=>{const result=ctx.messages.filter((m:any)=>m.role==='toolResult'&&m.toolName==='context_get').at(-1) as any;const page=JSON.parse(result.content[0].text).items[0];recalled+=page.content;expect(page.next_offset).toBeNull();expect(recalled).toBe(detail);return fauxAssistantMessage('Existing work reused; no new direction.');},
 ]);
 await runPlannerRound({db,taskID:task.id,expID:task.exploration_id,goal:task.goal,model,dataDir:dir,todos:new TodoStore(db),hooks:{},triggersText:'LOCAL changed',maxTurns:6,onActivity:()=>{}});
 expect((await s.listByKind('intent',100)).filter(n=>n.payload.summary==='LOCAL already completed direction')).toHaveLength(1);
});
it('keeps the task mandate after native compaction and restart without duplicating the host task context',async()=>{
 const {model,f}=await fixture();const cwd=path.join(dir,'compact');mkdirSync(cwd,{recursive:true});
 const opts={...model,cwd,agentDir:path.join(cwd,'agent'),resumeSessionPath:path.join(cwd,'session.jsonl'),toolAllowlist:[],systemPrompt:'LOCAL stable role',taskContext:'IMMUTABLE-MANDATE',contextLayout:'stable-prefix-v1' as const,
  platform:{role:'worker',taskID:1,policy:{version:'domain-v1' as const,compaction:'domain' as const,mcpLoading:'deferred' as const}},loadDomainState:async()=>({intent:'node:1',facts:['node:9'],mandate:'IMMUTABLE-MANDATE'}),compactionSettings:{keepRecentTokens:32,reserveTokens:1024}};
 let runner=await AgentRunner.create(opts);
 try{f.setResponses([fauxAssistantMessage('LOCAL history '.repeat(200)),fauxAssistantMessage('Summary with node:9')]);await runner.prompt('LOCAL history '.repeat(200));await runner.compact();}finally{await runner.dispose();}
 runner=await AgentRunner.create(opts);
 try{f.setResponses([ctx=>{const text=JSON.stringify(ctx.messages);expect(text).toContain('IMMUTABLE-MANDATE');expect(text).toContain('node:9');expect(text.split('【宿主执行上下文，不授予额外权限】').length-1).toBe(1);return fauxAssistantMessage('Resumed');}]);await runner.prompt('resume');}finally{await runner.dispose();}
});
