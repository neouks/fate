import assert from 'node:assert/strict';
import {test} from 'node:test';
import Fastify from 'fastify';
import {openDatabase} from './index.js';
import {proposeGoalAcceptance,reviewGoalAcceptance,goalAcceptanceDetails,isCoverageGoal} from './goal-integrity.js';
import {registerGoalAcceptanceRoutes} from '../http/routes/goal-acceptance.js';
import {registerTaskRoutes} from '../http/routes/tasks.js';
import {registerCompatRoutes} from '../http/routes/compat.js';
import {requireJWT,signJWT} from '../http/auth.js';

const dsn=process.env.TEST_GOAL_INTEGRITY_DSN;
test('coverage recognition is deliberately narrow',()=>{
 assert.equal(isCoverageGoal('资产测试覆盖度100%'),true);
 for(const text of ['覆盖度100%并完成其他要求','资产测试覆盖度100%，限昨天','分析覆盖情况','资产测试覆盖度0%'])assert.equal(isCoverageGoal(text),false);
});
test('versioned acceptance, task states and authenticated human review', {skip:!dsn&&'isolated PostgreSQL required'},async t=>{
 assert.match(new URL(dsn!).pathname,/^\/test_[a-z0-9_]+$/);process.env.SERIES_PG_DSN=dsn;
 const db=await openDatabase();const app=Fastify();app.decorate('db',db);app.addHook('preHandler',requireJWT('synthetic-key'));registerTaskRoutes(app);registerCompatRoutes(app);
 t.after(async()=>{await app.close();await db.close()});
 async function fixture(text='检查本地合成文本'){
  const exp=await db.createExploration('合成样本',text);
  const task=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id) VALUES('fixture',$1,$2) RETURNING id",[text,exp])).rows[0]!.id);
  const g=db.exploration(exp),goal=await g.addGoal({text},'user');
  const evidence=await g.addNode('fact',{evidence:'本地文本的合成观察',summary:'已核对合成内容',observation_type:'observed'},0,'confirmed','fixture',[]);
  return {exp,task,g,goal,evidence};
 }
 const a=await fixture(),b=await fixture();
 const second=await a.g.addGoal({text:'第二项合成要求'},'user');
 await a.g.setNodeState(a.goal,'met');
 assert.equal((await a.g.executionCounts()).met,0,'bare met cannot prove a goal');
 assert.equal(await db.tasks().setTaskStatusGuarded(a.task,'done'),false);
 await assert.rejects(db.query("UPDATE tasks SET status='done' WHERE id=$1",[a.task]),/尚未核验/);
 const proposal=await proposeGoalAcceptance(db,a.task,a.goal,a.evidence,'合成证明','call-1');
 assert.equal(proposal.verification,'awaiting_confirmation');assert.equal(proposal.met,false);
 assert.equal((await proposeGoalAcceptance(db,a.task,a.goal,a.evidence,'合成证明','call-1')).acceptance_id,proposal.acceptance_id);
 const detail=(await goalAcceptanceDetails(db,a.task,a.goal))!;
 const url=`/api/tasks/${a.task}/goals/${a.goal}/acceptance`,headers={authorization:`Bearer ${signJWT('synthetic-key')}`};
 assert.equal((await app.inject({url})).statusCode,401);
 assert.equal((await app.inject({url:`/api/tasks/${b.task}/goals/${a.goal}/acceptance`,headers})).statusCode,404);
 const body={action:'approve',acceptance_id:detail.id,goal_hash:detail.goal_hash,evidence_hash:detail.evidence_hash};
 const responses=await Promise.all([1,2].map(()=>app.inject({url,method:'POST',headers,payload:body})));
 assert.deepEqual(responses.map(r=>r.statusCode).sort(),[200,409]);
 assert.equal((await a.g.executionCounts()).met,1);
 assert.equal(await db.tasks().setTaskStatusGuarded(a.task,'done'),false);
 const p2=await proposeGoalAcceptance(db,a.task,second,a.evidence);
 const d2=(await goalAcceptanceDetails(db,a.task,second))!;
 await reviewGoalAcceptance(db,a.task,second,p2.acceptance_id,d2,true,'test-user');
 assert.equal((await a.g.executionCounts()).met,2);
 assert.equal(await db.tasks().setTaskStatusGuarded(a.task,'done'),true);
 await a.g.updateGoalPayload(a.goal,'修改后的要求','');
 assert.equal((await db.tasks().getTask(a.task))!.status,'needs_attention');
 assert.equal((await a.g.executionCounts()).met,1);
 await a.g.updateGoalPayload(a.goal,'检查本地合成文本','');
 await a.g.setNodeState(a.goal,'met');
 assert.equal((await a.g.executionCounts()).met,1,'changing back cannot resurrect a prior acceptance');
 // A confirmed evidence edit invalidates a previous proof without deleting history.
 await db.query("UPDATE exploration_nodes SET payload=payload||'{\"evidence\":\"观察已变化\"}'::jsonb WHERE id=$1",[a.evidence]);
 assert.equal((await a.g.executionCounts()).met,0);
 assert.equal((await db.query('SELECT count(*) n FROM goal_acceptance WHERE task_id=$1',[a.task])).rows[0]!.n,'2');
 const empty=await fixture();await empty.g.deleteGoal(empty.goal);
 assert.equal(await db.tasks().setTaskStatusGuarded(empty.task,'done',true),false);
 assert.equal(await db.tasks().finishManually(empty.task),'needs_attention');
 // Status is the same SQL projection used by filtering, summaries and DTOs.
 const state=async()=>String((await db.query('SELECT task_display_status($1) s',[b.task])).rows[0]!.s);
 await db.query("UPDATE tasks SET status='running' WHERE id=$1",[b.task]);assert.equal(await state(),'needs_attention');
 await db.query("INSERT INTO engine_task_leases(task_id,owner,token,expires_at) VALUES($1,'fixture','fixture',now()+interval '1 minute')",[b.task]);assert.equal(await state(),'running');
 await assert.rejects(db.tasks().finishManually(b.task),/执行器尚未退出/);
 await db.query("UPDATE tasks SET paused=true WHERE id=$1",[b.task]);
 await db.query("INSERT INTO runtime_task_commands(task_id,command) VALUES($1,'pause')",[b.task]);assert.equal(await state(),'pausing');
 await db.query("UPDATE runtime_task_commands SET status='acknowledged' WHERE task_id=$1",[b.task]);assert.equal(await state(),'paused');
 const c=await fixture('资产测试覆盖度100%');
 await assert.rejects(proposeGoalAcceptance(db,c.task,c.goal,c.evidence),/覆盖度未达成/);
 const asset=Number((await db.query("INSERT INTO assets(type,domain) VALUES('subdomain','fixture.invalid') RETURNING id")).rows[0]!.id);
 await db.query('INSERT INTO task_asset_links(task_id,asset_id) VALUES($1,$2)',[c.task,asset]);
 await db.query('INSERT INTO exploration_anchors(node_id,asset_id) VALUES($1,$2)',[c.evidence,asset]);
 await db.query(`UPDATE exploration_nodes SET payload=payload||'{"scope":{"tested":"合成资产观察"},"writeback":{"coverage_eligible":true}}'::jsonb WHERE id=$1`,[c.evidence]);
 const cov=await proposeGoalAcceptance(db,c.task,c.goal,c.evidence);assert.equal(cov.met,true);
 assert.equal(await db.tasks().setTaskStatusGuarded(c.task,'done'),true);
 const asset2=Number((await db.query("INSERT INTO assets(type,domain) VALUES('subdomain','second.invalid') RETURNING id")).rows[0]!.id);
 await db.query('INSERT INTO task_asset_links(task_id,asset_id) VALUES($1,$2)',[c.task,asset2]);
 const otherFact=await c.g.addNode('fact',{summary:'新发现未测试资产'},0,'origin','fixture',[asset2]);assert.ok(otherFact);
 assert.equal((await c.g.executionCounts()).met,0,'growing denominator invalidates coverage proof');
 assert.equal((await db.query('SELECT task_display_status($1) s',[c.task])).rows[0]!.s,'needs_attention');
 await assert.rejects(db.query("UPDATE tasks SET status='done' WHERE id=$1",[c.task]),/尚未核验/);
 const graphPage=await app.inject({url:`/api/exploration/graph?task=${c.task}&view=page`,headers});assert.equal(graphPage.statusCode,200,graphPage.body);assert.equal(graphPage.json().nodes.find((n:any)=>Number(n.id)===c.goal)?.state,'open');
 const current=await db.taskScope().taskCoverage(c.task,c.exp);assert.equal(current.denominator,2);assert.equal(current.tested,1);
 for(const id of [a.task,b.task,c.task,empty.task]){
  const expected=(await db.query('SELECT task_display_status($1) s',[id])).rows[0]!.s;
  const detail=await app.inject({url:`/api/tasks/${id}`,headers});assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.json().status,expected);
  const stats=await app.inject({url:`/api/stats?task=${id}`,headers});assert.equal(stats.statusCode,200,stats.body);assert.equal(stats.json().active_task.status,expected);
  const list=await app.inject({url:`/api/tasks?page=1&page_size=20&status=${expected}`,headers});assert.equal(list.statusCode,200,list.body);assert.ok(list.json().tasks.some((t:any)=>Number(t.id)===id));
 }
 const summary=await app.inject({url:'/api/tasks/summary',headers});assert.equal(summary.json().by_status.needs_attention,3);
 // Concurrent editing and finalization use the same task -> graph lock order.
 const race=await fixture();await proposeGoalAcceptance(db,race.task,race.goal,race.evidence);
 const receipt=(await goalAcceptanceDetails(db,race.task,race.goal))!;await reviewGoalAcceptance(db,race.task,race.goal,receipt.id,receipt,true,'fixture');
 await Promise.all([db.tasks().finishManually(race.task),race.g.updateGoalPayload(race.goal,'changed','')]);
 assert.equal((await race.g.executionCounts()).met,0);assert.notEqual((await db.query('SELECT task_display_status($1) s',[race.task])).rows[0]!.s,'done');
 // A stale evidence review is rejected; approval has no executor side effects.
 const stale=await fixture();await proposeGoalAcceptance(db,stale.task,stale.goal,stale.evidence);const before=(await goalAcceptanceDetails(db,stale.task,stale.goal))!;
 await db.query("UPDATE exploration_nodes SET payload=payload||'{\"evidence\":\"new observation\"}'::jsonb WHERE id=$1",[stale.evidence]);
 await assert.rejects(reviewGoalAcceptance(db,stale.task,stale.goal,before.id,before,true,'fixture'),/已变化/);
 assert.equal((await db.query('SELECT count(*) n FROM engine_task_leases WHERE task_id=$1',[stale.task])).rows[0]!.n,'0');

});
