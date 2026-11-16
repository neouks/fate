import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {openDatabase} from '../db/index.js';
import {proposeGoalAcceptance,goalAcceptanceDetails,reviewGoalAcceptance} from '../db/goal-integrity.js';
import {Engine,defaultEngineConfig} from './engine.js';

const dsn=process.env.TEST_GOAL_INTEGRITY_DSN;
test('idle unfinished tasks hold without restarting, accepted goals settle without another model call',{
 skip:!dsn&&'isolated PostgreSQL required',
},async t=>{
 assert.match(new URL(dsn!).pathname,/^\/test_[a-z0-9_]+$/);process.env.SERIES_PG_DSN=dsn;
 const db=await openDatabase(),dir=await mkdtemp(join(tmpdir(),'fate-settlement-'));let requests=0;
 const engine=new Engine(db,{...defaultEngineConfig(),debounceMs:1,heartbeatMs:10},async()=>{requests++;throw new Error('fixture: no model');},dir);
 t.after(async()=>{await engine.shutdown();await db.close();await rm(dir,{recursive:true,force:true});});
 async function fixture(){
  const exp=await db.createExploration('synthetic','核验合成文本');
  const task=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,status) VALUES('synthetic','核验合成文本',$1,'running') RETURNING id",[exp])).rows[0]!.id);
  const graph=db.exploration(exp),goal=await graph.addGoal({text:'核验合成文本'},'user');return {exp,task,graph,goal};
 }
 const a=await fixture();
 // Exercise the exact settlement boundary with no model or worker execution.
 const internals=engine as any;
 const rt=await internals.loadRuntime(a.task);rt.lease=await internals.coordinator.acquire(a.task);rt.started=true;
 await db.query("INSERT INTO blackboard_wakeups(exploration_id,kind,event_key) VALUES($1,'control','fixture-control')",[a.exp]);
 assert.equal(await internals.holdUnfinishedTask(rt),false,'unread durable work is not idle');
 await db.query('UPDATE blackboard_wakeups SET acknowledged_at=now() WHERE exploration_id=$1',[a.exp]);
 const executing=Promise.resolve();rt.executions.add(executing);
 assert.equal(await internals.holdUnfinishedTask(rt),false,'exiting worker must settle before releasing');rt.executions.delete(executing);
 assert.equal(await internals.holdUnfinishedTask(rt),true);
 assert.equal((await db.tasks().getTask(a.task))!.status,'needs_attention');
 assert.equal((await db.query('SELECT 1 FROM engine_task_leases WHERE task_id=$1',[a.task])).rowCount,0);
 await engine.run(a.task);assert.equal(requests,0,'raw run cannot implicitly revive a held task');
 const pending=await fixture(),pendingEvidence=await pending.graph.addNode('fact',{evidence:'A/B observed'},0,'confirmed','fixture',[]);
 await proposeGoalAcceptance(db,pending.task,pending.goal,pendingEvidence);
 const pendingRt=await internals.loadRuntime(pending.task);pendingRt.lease=await internals.coordinator.acquire(pending.task);pendingRt.started=true;
 assert.equal(await internals.holdUnfinishedTask(pendingRt),true);
 assert.match(String((await db.query('SELECT status_reason FROM tasks WHERE id=$1',[pending.task])).rows[0]!.status_reason),/等待人工确认/);
 assert.equal((await pending.graph.executionCounts()).met,0);
 await engine.run(pending.task);assert.equal(requests,0,'waiting for human confirmation cannot restart probing');
 const b=await fixture(),evidence=await b.graph.addNode('fact',{evidence:'synthetic observation'},0,'confirmed','fixture',[]);
 await proposeGoalAcceptance(db,b.task,b.goal,evidence);
 assert.equal(await db.tasks().setTaskStatusGuarded(b.task,'done'),false);
 const proof=(await goalAcceptanceDetails(db,b.task,b.goal))!;await reviewGoalAcceptance(db,b.task,b.goal,proof.id,proof,true,'fixture');
 await engine.run(b.task);
 for(let i=0;i<160&&(await db.tasks().getTask(b.task))!.status!=='done';i++)await wait(50);
 assert.equal((await db.tasks().getTask(b.task))!.status,'done');assert.equal(requests,0);
});
