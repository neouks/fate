import {beforeAll,afterAll,it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {postgresDSN} from '../config/index.js';
import {openDatabase,type Database} from '../db/index.js';
import {Engine,defaultEngineConfig} from '../engine/engine.js';
import {buildApp} from './app.js';
import {signJWT} from './auth.js';
import {runContext} from '../tools/context.js';
import {recordFactTool} from '../tools/graph.js';
import {reportFindingTool} from '../tools/findings.js';
import {insertAssetsTool} from '../tools/assets.js';
import {retireWorkerTablePrompt} from '../agent/worker-output-prompt.js';
import {WORKER_PROMPT,hostProtocol,resolveRolePrompt} from '../agent/prompts.js';
import type {ToolDefinition} from '@earendil-works/pi-coding-agent';

const name=`fate_worker_output_${process.pid}`,connection=new URL(postgresDSN().dsn);
connection.pathname=`/${name}`;const dsn=connection.toString();connection.pathname='/postgres';const adminDSN=connection.toString();
const previousDSN=process.env.SERIES_PG_DSN,key='local-writeback-fixture',headers={'x-series-token':signJWT(key)};
let db:Database,engine:Engine,app:ReturnType<typeof buildApp>,dir:string;
beforeAll(async()=>{
 process.env.SERIES_PG_DSN=dsn;db=await openDatabase();dir=await mkdtemp(path.join(tmpdir(),'worker-output-'));
 engine=new Engine(db,defaultEngineConfig(),async()=>null,dir);
 app=buildApp({db,engine,version:'writebacks-test',startedAt:Date.now(),jwtKey:key,dataDir:dir,skillsRoot:dir});
});
afterAll(async()=>{await engine?.shutdown();await app?.close();await db?.close();const c=new pg.Client({connectionString:adminDSN});await c.connect();await c.query(`DROP DATABASE IF EXISTS ${name}`);await c.end();if(dir)await rm(dir,{recursive:true,force:true});if(previousDSN===undefined)delete process.env.SERIES_PG_DSN;else process.env.SERIES_PG_DSN=previousDSN;});
async function fixture(){
 const task=await db.tasks().createTaskWithOptions('LOCAL Worker 结果','',{executionMode:'manual'}),store=db.exploration(task.exploration_id);
 const intent=await store.addIntent({summary:'仅整理本地合成资料'},1,[],'user');
 await db.query("UPDATE exploration_nodes SET state='running',owner='work#1' WHERE id=$1",[intent]);
 const ctx={...runContext(db,task.id,task.exploration_id,'worker'),intentID:intent,workerName:'work#1'};
 const activity=(turn:string,kind:string,extra:Record<string,unknown>={})=>store.appendActivity({worker:'work#1',node_id:intent,kind,...extra,metadata:{turn_id:turn,...extra.metadata as object}});
 const start=(turn:string)=>activity(turn,'status',{metadata:{event_type:'turn_start',role:'worker'}});
 const end=(turn:string,status='done')=>activity(turn,'result',{summary:'合成结论',metadata:{event_type:'outcome',status}});
 async function call(turn:string,id:string,tool:ToolDefinition,args:unknown){
   await activity(turn,'tool_use',{tool_use_id:id,tool:tool.name});
   const r=await tool.execute(id,args as never,undefined,undefined,{} as never);
   await activity(turn,'tool_result',{tool_use_id:id,tool:tool.name,is_error:r.isError===true});
   return JSON.parse((r.content[0] as {text:string}).text);
 }
 const get=(turn:string,query='')=>app.inject({url:`/api/tasks/${task.id}/turns/${turn}/writebacks${query}`,headers});
 return {task,store,intent,ctx,activity,start,end,call,get};
}
it('removes the table API while preserving real writes, tool receipts and the original conclusion',async()=>{
 const f=await fixture();await f.start('one');
 const assets=await f.call('one','assets',insertAssetsTool(f.ctx),{assets:[{type:'endpoint',url:'http://127.0.0.1:18899/forum',method:'GET'},{type:'invalid'}]});
 const facts=await f.call('one','facts',recordFactTool(f.ctx),{facts:[{summary:'本地合成观察',evidence:'LOCAL',detail:'保留完整证据与测试影响'},{summary:'缺失证据'}]});
 const finding=await f.call('one','finding',reportFindingTool(f.ctx),{summary:'LOCAL confirmed',evidence:'LOCAL proof',severity:'low',vulnclass:'fixture'});
 expect(assets.results[0].id).toBeTruthy();expect(facts.fact_ids.filter(Boolean)).toHaveLength(1);expect(finding.finding_id).toBeTruthy();
 expect((await db.query('SELECT id FROM assets WHERE id=$1',[assets.results[0].id])).rowCount).toBe(1);
 const fact=(await db.query('SELECT payload FROM exploration_nodes WHERE id=$1 AND exploration_id=$2',[facts.fact_ids[0],f.task.exploration_id])).rows[0]!;
 expect(fact.payload.summary).toBe('本地合成观察');expect(fact.payload.detail).toContain('测试影响');
 expect((await db.query('SELECT id FROM findings WHERE id=$1',[finding.finding_id])).rowCount).toBe(1);
 await f.end('one');
 expect((await f.get('one')).statusCode).toBe(404);
 const response=await app.inject({url:`/api/tasks/${f.task.id}/turns?ids=one`,headers});expect(response.statusCode,response.body).toBe(200);
 const summary=response.json().items[0];expect(summary).not.toHaveProperty('writebacks');
 expect(summary).toMatchObject({status:'done',tool_calls:3,final_activity:{summary:'合成结论'}});
});
it('keeps partial writes through interruption and idempotent recovery without a table endpoint',async()=>{
 const f=await fixture();await f.start('old');const args={summary:'已保存部分结果',evidence:'LOCAL'};
 const first=await f.call('old','stable-call',recordFactTool(f.ctx),args);await f.end('old','paused');
 await f.start('resumed');const replay=await f.call('resumed','stable-call',recordFactTool(f.ctx),args);
 expect(first.fact_id,JSON.stringify(first)).toBeGreaterThan(0);expect(replay.fact_id,JSON.stringify(replay)).toBe(first.fact_id);
 expect((await db.query("SELECT count(*)::int AS n FROM exploration_nodes WHERE exploration_id=$1 AND kind='fact' AND tool_call_id='stable-call'",[f.task.exploration_id])).rows[0]!.n).toBe(1);
 const response=await app.inject({url:`/api/tasks/${f.task.id}/turns?ids=old,resumed`,headers});
 expect(response.json().items.map((x:any)=>x.status)).toEqual(['paused','running']);
});
it('retires only exact table-era defaults, preserving custom text, history and explicit rollback',async()=>{
 const agent=await db.platform().getAgentByKey('worker');expect(agent).toBeTruthy();
 const old=WORKER_PROMPT.replace('summary 用一句通俗结论；细节与测试影响放 detail/evidence。最后简述结论、已保存的记录 ID、未完成原因及测试影响。','summary 用一句通俗结论；细节与测试影响放 detail/evidence。结尾简述结论、线索或未完成原因及影响；不重复平台表格，不额外调用工具。');
 async function select(text:string){const row=(await db.query("INSERT INTO agent_prompts(agent_id,version,template_text) SELECT $1,COALESCE(max(version),0)+1,$2 FROM agent_prompts WHERE agent_id=$1 RETURNING id",[agent!.id,text])).rows[0]!;await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[agent!.id,row.id]);return row.id;}
 const oldID=await select(old);await db.query("DELETE FROM settings WHERE key='worker_plain_result_v1'");
 await retireWorkerTablePrompt(db,WORKER_PROMPT);
 expect(await db.platform().currentPrompt(agent!.id)).toBe(WORKER_PROMPT);
 expect((await db.query('SELECT template_text FROM agent_prompts WHERE id=$1',[oldID])).rows[0]!.template_text).toBe(old);
 await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[agent!.id,oldID]);await retireWorkerTablePrompt(db,WORKER_PROMPT);
 expect(await db.platform().currentPrompt(agent!.id)).toBe(old);
 const custom=old+'\n用户自定义要求';await select(custom);await db.query("DELETE FROM settings WHERE key='worker_plain_result_v1'");
 await retireWorkerTablePrompt(db,WORKER_PROMPT);
 expect(await resolveRolePrompt(db,'worker')).toMatchObject({template:custom,source:'custom',candidate:WORKER_PROMPT});
 expect(WORKER_PROMPT+hostProtocol('worker')).not.toContain('表格');
 expect(WORKER_PROMPT).toContain('边发现边写回');
});
