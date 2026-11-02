import {afterAll,beforeAll,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {openDatabase,type Database} from '../db/index.js';
import {runGoalsDecompose} from './roles.js';
import {goalsBootstrap,SERIES_GOALS_POLICY} from '../db/goals-bootstrap.js';
import {setConstraintsTool,setGoalsTool} from '../tools/goals.js';
import {runContext} from '../tools/context.js';
import {migrateSeriesGoals,PREVIOUS_ISOLATED_PROMPT,SERIES_GOALS_MIGRATION} from './goals-series-migration.js';
import {GOALS_PROMPT} from './prompts.js';
const dir=mkdtempSync(path.join(tmpdir(),'fate-goals-series-')),name=`fate_goals_series_${process.pid}`;
let db:Database;
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;db=await openDatabase();});
afterAll(async()=>{await db?.close();const p=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await p.connect();await p.query(`DROP DATABASE IF EXISTS ${name}`);await p.end();rmSync(dir,{recursive:true,force:true});});
async function fixture(goal='交付本地样本覆盖清单'){
 const task=await db.tasks().createTaskWithOptions('架构分析和接口梳理是背景。\n测试目标 http://127.0.0.1:19090\n\n只允许读取当前目标，不写入；本地合成资料。',goal,{initializeGoals:true});
 await db.query("UPDATE tasks SET status='running' WHERE id=$1",[task.id]);
 const faux=fauxProvider({provider:`series-goals-${task.id}`}),modelRuntime=await ModelRuntime.create({refreshOnCreate:false});await modelRuntime.registerNativeProvider(faux.provider);
 const ctx={...runContext(db,task.id,task.exploration_id,'goals'),goalsPhase:'combined' as const};
 const input={db,taskID:task.id,expID:task.exploration_id,description:task.description,dataDir:dir,model:{modelRuntime,model:faux.getModel() as never},maxTurns:5};
 const goalCall=()=>fauxAssistantMessage([fauxToolCall('set_goals',{goals:[{text:goal,source_quote:goal}]})]);
 return {task,faux,ctx,input,goalCall};
}
const call=(t:ReturnType<typeof setConstraintsTool>|ReturnType<typeof setGoalsTool>,a:unknown)=>t.execute('fixture',a as never);
it('one native session retains source context, commits only goal-field results and stops without another request',async()=>{
 const f=await fixture();let last='';
 f.faux.setResponses([fauxAssistantMessage([fauxToolCall('set_constraints',{constraints:[{kind:'allow',text:'只允许读取 127.0.0.1:19090，不写入；本地合成资料。',source_quote:'只允许读取当前目标，不写入；本地合成资料。'}]})]),c=>{last=JSON.stringify(c);return f.goalCall();}]);
 await runGoalsDecompose(f.input);
 expect(last).toContain('架构分析');expect(last).toContain('只允许读取 127.0.0.1:19090');
 expect((await db.query('SELECT text,source FROM task_constraints WHERE exploration_id=$1',[f.task.exploration_id])).rows).toEqual([expect.objectContaining({text:'只允许读取 127.0.0.1:19090，不写入；本地合成资料。',source:expect.objectContaining({quote:'只允许读取当前目标，不写入；本地合成资料。'})})]);
 expect(f.faux.state.callCount).toBe(2);expect((await goalsBootstrap(db,f.task.id))?.policy).toBe(SERIES_GOALS_POLICY);
 const goals=await db.exploration(f.task.exploration_id).listByKind('goal');expect(goals.map(g=>g.payload.text)).toEqual([f.task.goal]);
 expect(goals[0]!.payload.source).toMatchObject({quote:f.task.goal});
 const runtime=(await db.query('SELECT effective FROM runtime_role_configs WHERE task_id=$1',[f.task.id])).rows;
 expect(runtime).toHaveLength(1);expect(runtime[0].effective.active_tools.sort()).toEqual(['register_user_target','set_constraints','set_goals']);expect(runtime[0].effective.goals_phase).toBe('combined');
 await runGoalsDecompose(f.input);expect(f.faux.state.callCount).toBe(2);
});
it('durable failed saves prevent goal commit; a successful correction clears the blocker',async()=>{
 const f=await fixture();
 expect((await call(setConstraintsTool(f.ctx),{constraints:[{kind:'deny',text:'模型捏造的约束'}]})).isError).toBe(true);
 expect((await call(setGoalsTool(f.ctx),{goals:[{text:f.task.goal,source_quote:f.task.goal}]})).isError).toBe(true);
 expect((await goalsBootstrap(db,f.task.id))?.phase).toBe('constraints');
 expect((await call(setConstraintsTool(f.ctx),{constraints:[{kind:'deny',text:'不得写入本地样本',source_quote:'只允许读取当前目标，不写入；本地合成资料。'}]})).isError).not.toBe(true);
 f.faux.setResponses([f.goalCall()]);await runGoalsDecompose(f.input);expect((await goalsBootstrap(db,f.task.id))?.phase).toBe('completed');
});
it('unresolved errors survive native session restart and prevent fallback',async()=>{
 const f=await fixture();await call(setConstraintsTool(f.ctx),{constraints:[{kind:'deny',text:'无来源的规则'}]});
 f.faux.setResponses([fauxAssistantMessage('结束')]);await expect(runGoalsDecompose(f.input)).rejects.toThrow('保存错误');expect(await db.exploration(f.task.exploration_id).listByKind('goal')).toHaveLength(0);
});
it('normal no-output falls back but cancellation and disabled writers never do',async()=>{
 const f=await fixture();f.faux.setResponses([fauxAssistantMessage('没有提交')]);await runGoalsDecompose(f.input);expect((await goalsBootstrap(db,f.task.id))?.fallback).toBe(true);
 const cancelled=await fixture(),c=new AbortController();cancelled.faux.setResponses([()=>{c.abort();return fauxAssistantMessage('cancel');}]);await expect(runGoalsDecompose({...cancelled.input,signal:c.signal})).rejects.toThrow();expect((await goalsBootstrap(db,cancelled.task.id))?.phase).toBe('constraints');
 const disabled=await fixture();await db.query("UPDATE tools SET enabled=false WHERE key='set_goals'");try{await expect(runGoalsDecompose(disabled.input)).rejects.toThrow('禁用');expect(disabled.faux.state.callCount).toBe(0);}finally{await db.query("UPDATE tools SET enabled=true WHERE key='set_goals'");}
});
it('rejects description-only goal provenance',async()=>{const f=await fixture();expect((await call(setGoalsTool(f.ctx),{goals:[{text:'架构分析',source_quote:'架构分析'}]})).isError).toBe(true);});
it('upgrades only shipped templates and preserves custom selection',async()=>{
 const a=(await db.platform().getAgentByKey('goals'))!;
 for(const [source,expected] of [[PREVIOUS_ISOLATED_PROMPT,GOALS_PROMPT],['custom 保留','custom 保留']]){await db.platform().savePrompt(a.id,source!,'fixture','test');await db.platform().setSetting(SERIES_GOALS_MIGRATION,'');await migrateSeriesGoals(db);expect(await db.platform().currentPrompt(a.id)).toBe(expected);}
 await db.platform().savePrompt(a.id,GOALS_PROMPT,'restore','test');
});
it('cannot finish before later saves in the same native batch, including schema errors',async()=>{
 const f=await fixture();
 f.faux.setResponses([fauxAssistantMessage([fauxToolCall('set_goals',{goals:[{text:f.task.goal,source_quote:f.task.goal}]}),fauxToolCall('set_constraints',{constraints:[{kind:'invalid',text:'bad'}]})]),fauxAssistantMessage('结束')]);
 await expect(runGoalsDecompose(f.input)).rejects.toThrow('保存错误');
 expect(await db.exploration(f.task.exploration_id).listByKind('goal')).toHaveLength(0);
 expect(Object.keys((await goalsBootstrap(db,f.task.id))!.pending_errors).length).toBeGreaterThan(0);
});
it('native schema validation failure is durable and cannot silently trigger fallback',async()=>{
 const f=await fixture();f.faux.setResponses([fauxAssistantMessage([fauxToolCall('set_constraints',{constraints:[{kind:'invalid',text:'bad'}]})]),fauxAssistantMessage('结束')]);
 await expect(runGoalsDecompose(f.input)).rejects.toThrow('保存错误');
 expect((await goalsBootstrap(db,f.task.id))?.pending_errors).toHaveProperty('set_constraints');
 expect(await db.exploration(f.task.exploration_id).listByKind('goal')).toHaveLength(0);
});
it('single-session SIGKILL recovery preserves writes and never replays completed initialization',async()=>{
 const {spawn}=await import('node:child_process');const {fileURLToPath}=await import('node:url');const f=await fixture();
 const description='禁止写入生产数据；仅本地合成资料。';
 await db.query('UPDATE tasks SET description=$2 WHERE id=$1',[f.task.id,description]);await db.query('UPDATE goals_bootstrap SET description=$2 WHERE task_id=$1',[f.task.id,description]);
 const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('../../test-fixtures/goals-crash-child.mts',import.meta.url)),String(f.task.id),dir],{env:{...process.env},stdio:['ignore','ignore','pipe','ipc']});
 let errors='';child.stderr!.on('data',chunk=>errors+=chunk);
 try{
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('child checkpoint timeout '+errors)),15000);child.once('message',()=>{clearTimeout(timer);resolve();});child.once('exit',code=>{clearTimeout(timer);reject(new Error('child exited '+code+' '+errors));});});
  const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
  f.faux.setResponses([c=>{expect(JSON.stringify(c)).toContain(description);return fauxAssistantMessage([fauxToolCall('set_constraints',{constraints:[{kind:'deny',text:description}]})]);},f.goalCall()]);
  await runGoalsDecompose({...f.input,description});
  expect((await db.query('SELECT id FROM task_constraints WHERE exploration_id=$1',[f.task.exploration_id])).rowCount).toBe(1);
  const calls=f.faux.state.callCount;await runGoalsDecompose({...f.input,description});expect(f.faux.state.callCount).toBe(calls);
  expect(await db.exploration(f.task.exploration_id).listByKind('goal')).toHaveLength(1);
 }finally{if(child.exitCode===null)child.kill('SIGKILL');}
});
