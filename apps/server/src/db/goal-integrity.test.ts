import assert from 'node:assert/strict';
import {test} from 'node:test';
import Fastify from 'fastify';
import {openDatabase} from './index.js';
import {proposeGoalAcceptance,goalAcceptanceDetails,isCoverageGoal} from './goal-integrity.js';
import {registerTaskRoutes} from '../http/routes/tasks.js';
import {registerCompatRoutes} from '../http/routes/compat.js';
import {requireJWT,signJWT} from '../http/auth.js';
import {goalIntegritySQL} from './goal-integrity-migration.js';

const dsn=process.env.TEST_GOAL_INTEGRITY_DSN;
test('coverage recognition is deliberately narrow',()=>{
 assert.equal(isCoverageGoal('资产测试覆盖度100%'),true);
 for(const text of ['覆盖度100%并完成其他要求','资产测试覆盖度100%，限昨天','分析覆盖情况','资产测试覆盖度0%'])assert.equal(isCoverageGoal(text),false);
});
test('direct evidence acceptance, invalidation and retired review endpoint', {skip:!dsn&&'isolated PostgreSQL required'},async t=>{
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
 assert.equal(proposal.verification,'evidence_verified');assert.equal(proposal.met,true);assert.equal(proposal.all_goals_met,false);
 assert.equal((await proposeGoalAcceptance(db,a.task,a.goal,a.evidence,'合成证明','call-1')).acceptance_id,proposal.acceptance_id);
 const detail=(await goalAcceptanceDetails(db,a.task,a.goal))!;
 const url=`/api/tasks/${a.task}/goals/${a.goal}/acceptance`,headers={authorization:`Bearer ${signJWT('synthetic-key')}`};
 assert.equal((await app.inject({url})).statusCode,401);
 assert.equal((await app.inject({url:`/api/tasks/${b.task}/goals/${a.goal}/acceptance`,headers})).statusCode,404);
 const body={action:'approve',acceptance_id:detail.id,goal_hash:detail.goal_hash,evidence_hash:detail.evidence_hash};
 const responses=await Promise.all([1,2].map(()=>app.inject({url,method:'POST',headers,payload:body})));
 assert.deepEqual(responses.map(r=>r.statusCode),[404,404]);
 assert.equal((await app.inject({url,headers})).json().acceptance.valid,true);
 assert.equal((await a.g.executionCounts()).met,1);
 assert.equal(await db.tasks().setTaskStatusGuarded(a.task,'done'),false);
 const p2=await proposeGoalAcceptance(db,a.task,second,a.evidence);assert.equal(p2.all_goals_met,true);
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
 await db.query("UPDATE exploration_nodes SET payload=payload||'{\"observation_type\":\"negative\"}'::jsonb WHERE id=$1",[c.evidence]);
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
 await Promise.all([db.tasks().finishManually(race.task),race.g.updateGoalPayload(race.goal,'changed','')]);
 assert.equal((await race.g.executionCounts()).met,0);assert.notEqual((await db.query('SELECT task_display_status($1) s',[race.task])).rows[0]!.s,'done');
 // Changed evidence invalidates the proof; resubmission verifies the new snapshot without starting executors.
 const stale=await fixture();await proposeGoalAcceptance(db,stale.task,stale.goal,stale.evidence);const before=(await goalAcceptanceDetails(db,stale.task,stale.goal))!;
 await db.query("UPDATE exploration_nodes SET payload=payload||'{\"evidence\":\"new observation\"}'::jsonb WHERE id=$1",[stale.evidence]);
 assert.equal((await goalAcceptanceDetails(db,stale.task,stale.goal))!.valid,false);
 const refreshed=await proposeGoalAcceptance(db,stale.task,stale.goal,stale.evidence);
 assert.equal(refreshed.met,true);assert.notEqual(refreshed.acceptance_id,before.id);
 assert.equal((await db.query('SELECT count(*) n FROM engine_task_leases WHERE task_id=$1',[stale.task])).rows[0]!.n,'0');

 // Reject unusable proof rather than turning removal of review into unconditional success.
 const invalid=await fixture();
 for(const payload of [{observation_type:'inferred'}, {observation_type:'unknown'}, {evidence:''}, {acceptance_status:'unverified'}]){
  const node=await invalid.g.addNode('fact',{evidence:'fixture',observation_type:'observed',...payload},0,'confirmed','fixture',[]);
  await assert.rejects(proposeGoalAcceptance(db,invalid.task,invalid.goal,node),/证据/);
 }
 await assert.rejects(proposeGoalAcceptance(db,invalid.task,invalid.goal,b.evidence),/授权|范围|不存在/);
 assert.equal((await invalid.g.executionCounts()).met,0);

 // Upgrade old review rows without approving pending/rejected requests or resuming tasks.
 const legacy=await fixture();
 await proposeGoalAcceptance(db,legacy.task,legacy.goal,legacy.evidence);
 await db.query(`ALTER TABLE goal_acceptance DROP CONSTRAINT goal_acceptance_method_check;
  ALTER TABLE goal_acceptance DROP CONSTRAINT goal_acceptance_status_check;
  ALTER TABLE goal_acceptance ADD CONSTRAINT goal_acceptance_method_check CHECK(method IN ('manual','coverage','evidence'));
  ALTER TABLE goal_acceptance ADD CONSTRAINT goal_acceptance_status_check CHECK(status IN ('pending','rejected','approved','invalidated'));`);
 await db.query("UPDATE goal_acceptance SET method='manual',status='pending' WHERE task_id=$1",[legacy.task]);
 await db.query("UPDATE goal_acceptance SET method='manual' WHERE task_id=$1",[stale.task]);
 await db.query("UPDATE tasks SET status='needs_attention',status_reason='目标证据已提交，等待人工确认；无待执行工作' WHERE id=$1",[legacy.task]);
 await db.query(goalIntegritySQL);
 await db.query(goalIntegritySQL);
 const old=(await goalAcceptanceDetails(db,legacy.task,legacy.goal))!;
 assert.equal(old.method,'evidence');assert.equal(old.status,'invalidated');assert.equal(old.state,'open');
 assert.equal((await db.tasks().getTask(legacy.task))!.status,'needs_attention');
 assert.equal((await db.query('SELECT count(*) n FROM engine_task_leases WHERE task_id=$1',[legacy.task])).rows[0]!.n,'0');
 assert.equal((await goalAcceptanceDetails(db,stale.task,stale.goal))!.valid,true,'prior approved proofs remain valid');
 assert.equal((await proposeGoalAcceptance(db,legacy.task,legacy.goal,legacy.evidence)).met,true);

});
