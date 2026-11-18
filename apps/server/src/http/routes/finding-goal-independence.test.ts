import assert from 'node:assert/strict';
import {test} from 'node:test';
import Fastify from 'fastify';
import {openDatabase} from '../../db/index.js';
import {runContext} from '../../tools/context.js';
import {reportFindingTool} from '../../tools/findings.js';
import {registerCompatRoutes} from './compat.js';

const dsn=process.env.TEST_GOAL_INTEGRITY_DSN;
test('saved findings and reports remain readable independently of task goal success',{
 skip:!dsn&&'isolated PostgreSQL required',
},async t=>{
 assert.match(new URL(dsn!).pathname,/^\/test_[a-z0-9_]+$/);process.env.SERIES_PG_DSN=dsn;
 const db=await openDatabase(),app=Fastify();app.decorate('db',db);registerCompatRoutes(app);
 t.after(async()=>{await app.close();await db.close();});
 const exp=await db.createExploration('local synthetic fixture','验证合成输出');
 const task=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,status) VALUES('fixture','验证合成输出',$1,'running') RETURNING id",[exp])).rows[0]!.id);
 const graph=db.exploration(exp);await graph.addGoal({text:'验证合成输出'},'user');
 const intent=await graph.addNode('intent',{summary:'本地合成观察'},0,'running','fixture',[]);
 await db.query("UPDATE exploration_nodes SET owner='fixture-worker' WHERE id=$1",[intent]);
 let notifications=0;
 const tool=reportFindingTool(runContext(db,task,exp,'worker',{intentID:intent,workerName:'fixture-worker',hooks:{notifyFinding:()=>notifications++}}));
 const args={vulnclass:'Synthetic fixture',name:'本地合成问题',severity:'high' as const,summary:'合成服务返回了不应显示的固定样本文本',evidence:'本地合成证据：expected=hidden, actual=fixture'};
 const result=await tool.execute('same-call',args);assert.notEqual(result.isError,true,JSON.stringify(result));
 const saved=JSON.parse((result.content[0] as {text:string}).text);
 const again=await tool.execute('same-call',args);assert.notEqual(again.isError,true);
 assert.equal(JSON.parse((again.content[0] as {text:string}).text).finding_id,saved.finding_id);assert.equal(notifications,1);
 assert.equal((await graph.executionCounts()).met,0,'a finding is not goal acceptance');
 await db.query("UPDATE findings SET report='合成报告完整保留',status='confirmed' WHERE id=$1",[saved.finding_id]);
 for(const status of ['needs_attention','failed','timeout','paused']){
  await db.query('UPDATE tasks SET status=$2,paused=$3 WHERE id=$1',[task,status,status==='paused']);
  const list=await app.inject(`/api/exploration/findings?context_task=${task}`);assert.equal(list.statusCode,200,list.body);assert.equal(list.json().total,1);
  const detail=await app.inject(`/api/exploration/findings/${saved.finding_id}?id_kind=record&context_task=${task}`);assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.json().report,'合成报告完整保留');assert.equal(detail.json().evidence,args.evidence);
  const exported=await app.inject(`/api/exploration/findings/export?format=csv&context_task=${task}&scope=filtered`);assert.equal(exported.statusCode,200);assert.ok(exported.body.includes('本地合成问题'));
  assert.equal((await graph.executionCounts()).met,0);
 }
 assert.equal((await db.query('SELECT count(*) n FROM findings WHERE task_id=$1',[task])).rows[0]!.n,'1');
});
