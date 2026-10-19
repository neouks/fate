import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import pg from 'pg';
import {openDatabase,type Database} from '../db/index.js';
import {TriggerScheduler} from './triggers.js';
import {reportFindingTool} from '../tools/findings.js';
import {runContext} from '../tools/context.js';

let db:Database;
let serial=0;
const dbName=`series_trigger_review_${process.pid}`;
beforeAll(async()=>{
  process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${dbName}?sslmode=disable`;
  db=await openDatabase();
});
beforeEach(async()=>{
  await db.query('UPDATE agent_triggers SET enabled=false');
  await db.query("DELETE FROM scheduler_state WHERE key LIKE 'pi_trigger_%'");
});
afterAll(async()=>{
  await db.close();
  const admin=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres?sslmode=disable'});
  await admin.connect();await admin.query(`DROP DATABASE ${dbName}`);await admin.end();
});
async function trigger(options:{interval?:number;finding?:boolean;goal?:boolean;timeout?:boolean}={}){
  const key=`trigger_review_${++serial}`;
  await db.query("INSERT INTO agents(key,name,role,builtin,enabled,trigger_run_mode,trigger_merge_mode) VALUES($1,$1,'assistant',false,true,'serial','all')",[key]);
  const r=await db.query('INSERT INTO agent_triggers(agent_key,enabled,interval_sec,on_finding,on_goal_met,on_task_timeout) VALUES($1,true,$2,$3,$4,$5) RETURNING id',[key,options.interval??0,!!options.finding,!!options.goal,!!options.timeout]);
  return Number(r.rows[0]!.id);
}
async function deliveries(id:number){
  return (await db.query('SELECT e.*,r.message,r.event_keys FROM agent_trigger_deliveries d JOIN agent_trigger_events e ON e.id=d.event_id JOIN conversation_runs r ON r.id=d.run_id WHERE d.trigger_id=$1 ORDER BY e.id',[id])).rows;
}

describe('durable trigger acceptance',()=>{
  it('starts interval scheduling at enablement and deduplicates concurrent ticks',async()=>{
    const id=await trigger({interval:60});
    const scheduler=new TriggerScheduler(db);
    await scheduler.tick();
    expect(await deliveries(id)).toHaveLength(0);
    await db.query("UPDATE agent_triggers SET last_fire=now()-interval '61 seconds' WHERE id=$1",[id]);
    await Promise.all([scheduler.tick(),new TriggerScheduler(db).tick()]);
    expect(await deliveries(id)).toHaveLength(1);
    await scheduler.tick();expect(await deliveries(id)).toHaveLength(1);
    await db.query("UPDATE agent_triggers SET enabled=false,last_fire=now()-interval '61 seconds' WHERE id=$1",[id]);
    await scheduler.tick();expect(await deliveries(id)).toHaveLength(1);
  });

  it('does not replay a delivered event when its conversation is deleted',async()=>{
    const id=await trigger({interval:60}),scheduler=new TriggerScheduler(db);
    await scheduler.tick();await db.query("UPDATE agent_triggers SET last_fire=now()-interval '61 seconds' WHERE id=$1",[id]);
    await scheduler.tick();
    const row=(await db.query('SELECT r.conversation_id,d.event_id FROM agent_trigger_deliveries d JOIN conversation_runs r ON r.id=d.run_id WHERE d.trigger_id=$1',[id])).rows[0]!;
    await db.query('DELETE FROM conversations WHERE id=$1',[row.conversation_id]);
    await scheduler.tick();
    expect((await db.query('SELECT run_id,delivered_at FROM agent_trigger_deliveries WHERE trigger_id=$1 AND event_id=$2',[id,row.event_id])).rows[0]).toMatchObject({run_id:null,delivered_at:expect.any(Date)});
    expect(await deliveries(id)).toHaveLength(0);
  });

  it('drains goal and timeout events beyond the first page without replaying history',async()=>{
    const id=await trigger({goal:true,timeout:true});
    const old=await db.tasks().createTaskWithOptions('old trigger fixture','',{});
    await db.exploration(old.exploration_id).addNode('goal',{text:'historical'},0,'met','user',[]);
    await db.query("UPDATE tasks SET status='timeout' WHERE id=$1",[old.id]);
    const scheduler=new TriggerScheduler(db);await scheduler.tick();
    expect(await deliveries(id)).toHaveLength(0);
    const fresh=await db.tasks().createTaskWithOptions('fresh goals','',{});
    await db.query("INSERT INTO exploration_nodes(exploration_id,kind,payload,state) SELECT $1,'goal',jsonb_build_object('text','goal-'||i),'met' FROM generate_series(1,501) i",[fresh.exploration_id]);
    await db.query("WITH e AS (INSERT INTO explorations(description,goal) SELECT 'timeout page fixture','' FROM generate_series(1,501) RETURNING id) INSERT INTO tasks(exploration_id,description,goal,status) SELECT id,'timeout page fixture','','timeout' FROM e");
    await scheduler.tick();await scheduler.tick();await scheduler.tick();
    const events=await deliveries(id);
    expect(events.filter(e=>e.kind==='goal')).toHaveLength(501);
    expect(events.filter(e=>e.kind==='task_timeout')).toHaveLength(501);
    expect(new Set(events.map(e=>e.event_key)).size).toBe(1002);
  });

  it('delivers late commits even when a newer finding id has already been observed',async()=>{
    const tid=await trigger({finding:true}),scheduler=new TriggerScheduler(db);await scheduler.tick();
    const first=await db.tasks().createTaskWithOptions('delayed commit','',{}),second=await db.tasks().createTaskWithOptions('early commit','',{});
    let ready!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r);
    const insert=async(tx:Database,task:typeof first)=>{const node=await tx.exploration(task.exploration_id).addNode('finding',{summary:'LOCAL commit ordering'},0,'confirmed','fixture',[]);await tx.query("INSERT INTO findings(task_id,node_id,name) VALUES($1,$2,'LOCAL fixture')",[task.id,node]);return node;};
    const pending=db.transaction(async tx=>{const node=await insert(tx,first);ready();await gate;return node;});
    await entered;
    try{await db.transaction(tx=>insert(tx,second));await scheduler.tick();expect(await deliveries(tid)).toHaveLength(1);}
    finally{release();await pending;}
    await scheduler.tick();expect(await deliveries(tid)).toHaveLength(2);
  });

  it.each([['serial','all',1],['serial','by_task',2],['serial','none',4],['parallel','all',4]] as const)('groups %s / %s deliveries into %i conversations without dropping events',async(mode,merge,count)=>{
    const tid=await trigger({goal:true});await db.query('UPDATE agents SET trigger_run_mode=$2,trigger_merge_mode=$3 WHERE key=(SELECT agent_key FROM agent_triggers WHERE id=$1)',[tid,mode,merge]);
    const scheduler=new TriggerScheduler(db);await scheduler.tick();
    for(let n=0;n<2;n++){const t=await db.tasks().createTaskWithOptions('LOCAL grouping fixture','',{});for(let i=0;i<2;i++)await db.exploration(t.exploration_id).addNode('goal',{text:'LOCAL goal'},0,'met','fixture',[]);}
    await scheduler.tick();const runs=(await db.query('SELECT event_keys FROM conversation_runs WHERE trigger_id=$1',[tid])).rows;
    expect(runs).toHaveLength(count);expect(runs.flatMap(r=>r.event_keys)).toHaveLength(4);
  });

  it('triggers only committed findings and passes the report record id, not the graph node id',async()=>{
    const id=await trigger({finding:true});
    const scheduler=new TriggerScheduler(db);await scheduler.tick();
    const task=await db.tasks().createTaskWithOptions('LOCAL FIXTURE ONLY','no network',{});
    const store=db.exploration(task.exploration_id);
    await store.addNode('finding',{summary:'legacy orphan'},0,'confirmed','fixture',[]);
    await scheduler.tick();expect(await deliveries(id)).toHaveLength(0);
    const intent=await store.addIntent({summary:'local fixture',dispatch_requested:true},1,[],'user');await store.claimNextWorker('work#1');
    const tool=reportFindingTool(runContext(db,task.id,task.exploration_id,'worker',{intentID:intent,workerName:'work#1'}));
    const args={vulnclass:'local-fixture',severity:'low' as const,summary:'LOCAL FIXTURE — NOT A TARGET VULNERABILITY',evidence:'synthetic regression data'};
    const result=await tool.execute('fixture-once',args);
    expect(result.isError,JSON.stringify(result)).not.toBe(true);
    const saved=JSON.parse(result.content[0]!.text!);
    await tool.execute('fixture-once',args);
    await scheduler.tick();await scheduler.tick();
    const events=await deliveries(id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({finding_id:saved.finding_id,finding_node_id:saved.finding_node_id,summary:args.summary});
    expect(saved.finding_id).not.toBe(saved.finding_node_id);
    expect(JSON.parse(events[0]!.message)).toMatchObject({source:'blackboard',finding_id:saved.finding_id});
  });
});
