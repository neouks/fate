import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {openDatabase} from '../db/index.js';
import {markWorkerReleased,recoverWorkerSettlements} from '../db/worker-drafts.js';
import {Coordinator,executionSnapshot,executionSnapshots} from './coordinator.js';
import {WorkerReleaseQueue,type WorkerRelease} from './worker-release-queue.js';
import {Engine,defaultEngineConfig} from './engine.js';

const item:WorkerRelease={slot:'fixture',taskID:1,expID:1,intentID:1};

test('release queue retries cleanup only, with backoff and one diagnostic',async()=>{
  let now=0,attempts=0,reports=0;
  const queue=new WorkerReleaseQueue(async()=>{if(++attempts<3)throw new Error('synthetic database failure');},()=>{reports++;},()=>now);
  await queue.finish(item);
  assert.equal(queue.size,1);
  await Promise.all([queue.finish(item),queue.flush()]);
  assert.equal(attempts,1);
  now=1000;await queue.flush();assert.equal(attempts,2);assert.equal(reports,1);
  now=2000;await queue.flush();assert.equal(attempts,3);assert.equal(queue.size,0);
  await queue.flush();assert.equal(attempts,3);
});

test('concurrent cleanup calls share one in-flight release',async()=>{
  let finish!:()=>void,attempts=0;
  const gate=new Promise<void>(resolve=>{finish=resolve;});
  const queue=new WorkerReleaseQueue(async()=>{attempts++;await gate;},()=>assert.fail('unexpected cleanup failure'));
  const first=queue.finish(item),second=queue.finish(item),flush=queue.flush(true);
  await Promise.resolve();assert.equal(attempts,1);assert.equal(queue.size,1);
  finish();await Promise.all([first,second,flush]);assert.equal(queue.size,0);
});

const dsn=process.env.TEST_WORKER_CAPACITY_DSN;
test('per-task worker capacity, downscale, lease recovery and release fault injection',{
  skip:!dsn&&'isolated PostgreSQL required',
},async t=>{
  assert.match(new URL(dsn!).pathname,/^\/test_[a-z0-9_]+$/);
  process.env.SERIES_PG_DSN=dsn;
  const db=await openDatabase(),otherDB=await openDatabase();
  t.after(async()=>{await otherDB.close();await db.close();});
  const coordinator=new Coordinator(db,3),other=new Coordinator(otherDB,3);
  const fixture=async(owner=coordinator)=>{
    const expID=await db.createExploration('本地并发夹具','本地并发夹具');
    const taskID=Number((await db.query("INSERT INTO tasks(description,goal,exploration_id,status) VALUES('fixture','fixture',$1,'running') RETURNING id",[expID])).rows[0]!.id);
    const token=(await owner.acquire(taskID))!;
    return {taskID,expID,token};
  };
  const count=async(taskID:number)=>Number((await db.query("SELECT count(*) n FROM engine_worker_slots WHERE task_id=$1 AND phase='running'",[taskID])).rows[0]!.n);
  await t.test('downscale 8 to 3 does not cancel existing workers or admit replacements until below 3',async()=>{
    const f=await fixture();await db.platform().setWorkers(8);
    const slots:string[]=[];
    for(let i=0;i<8;i++)slots.push((await coordinator.workerSlot(f.taskID,f.token))!);
    assert.equal(await count(f.taskID),8);
    await db.platform().setWorkers(3);
    for(let remaining=8;remaining>=3;remaining--){
      assert.equal(await coordinator.workerSlot(f.taskID,f.token),undefined);
      assert.equal(await db.transaction(tx=>coordinator.reserveWorkerSlot(tx,f.taskID,f.token,true,999)),undefined,'manual resume also respects reduced limit');
      const snapshot=await executionSnapshot(db,f.taskID);
      assert.equal(snapshot.task_active,remaining);assert.equal(snapshot.limit,3);assert.equal(snapshot.available,0);
      assert.deepEqual((await executionSnapshots(db))(f.taskID),snapshot);
      await coordinator.releaseSlot(slots.pop()!);
    }
    assert.equal(await count(f.taskID),2);
    assert.ok(await coordinator.workerSlot(f.taskID,f.token));assert.equal(await count(f.taskID),3);
    await coordinator.release(f.taskID,f.token);
  });
  await t.test('limits 1/2/3 are per task and concurrent reservations never exceed them',async()=>{
    for(const limit of [1,2,3]){
      await db.platform().setWorkers(limit);
      const a=await fixture(),b=await fixture(other);
      for(let round=0;round<limit+2;round++)await Promise.all([
        ...Array.from({length:6},()=>coordinator.workerSlot(a.taskID,a.token)),
        other.workerSlot(b.taskID,b.token),
      ]);
      // Lock losers defer. Fill each task sequentially to establish independent capacity.
      for(let i=0;i<limit;i++){await coordinator.workerSlot(a.taskID,a.token);await other.workerSlot(b.taskID,b.token);}
      assert.equal(await count(a.taskID),limit);assert.equal(await count(b.taskID),limit);
      await assert.rejects(other.workerSlot(a.taskID,a.token),/租约已失效/);
      await coordinator.release(a.taskID,a.token);await other.release(b.taskID,b.token);
    }
  });
  await t.test('expired lease slots are reclaimed, active slots are never inferred stale from graph terminal state',async()=>{
    await db.platform().setWorkers(1);const f=await fixture();
    const intentID=await db.exploration(f.expID).addNode('intent',{summary:'fixture'},0,'done','fixture',[]);
    const slot=(await db.transaction(tx=>coordinator.reserveWorkerSlot(tx,f.taskID,f.token,false,intentID)))!;
    assert.equal(await coordinator.workerSlot(f.taskID,f.token),undefined);
    await db.query("UPDATE engine_task_leases SET expires_at=now()-interval '1 second' WHERE task_id=$1",[f.taskID]);
    const replacement=(await other.acquire(f.taskID))!;
    assert.ok(await other.workerSlot(f.taskID,replacement));
    assert.equal((await db.query('SELECT 1 FROM engine_worker_slots WHERE id=$1',[slot])).rowCount,0);
    await assert.rejects(coordinator.workerSlot(f.taskID,f.token),/租约已失效/);
    await other.release(f.taskID,replacement);
  });
  await t.test('failed DELETE or post-delete settlement is retried without duplicate wakeups or releasing other workers',async()=>{
    await db.platform().setWorkers(2);const f=await fixture();
    const intentID=await db.exploration(f.expID).addNode('intent',{summary:'fixture',execution_stop:{attempt_id:'completed-attempt',reason:'completed'}},0,'done','fixture',[]);
    const slot=(await db.transaction(tx=>coordinator.reserveWorkerSlot(tx,f.taskID,f.token,false,intentID)))!;
    const busy=(await coordinator.workerSlot(f.taskID,f.token))!;
    let now=0,attempts=0;
    const queue=new WorkerReleaseQueue(async r=>{
      attempts++;
      if(attempts===1)throw new Error('DELETE connection unavailable');
      await coordinator.releaseSlot(r.slot);
      if(attempts===2)throw new Error('settlement connection unavailable');
      await markWorkerReleased(db,r.expID,r.intentID);
    },()=>{},()=>now);
    const r={slot,taskID:f.taskID,expID:f.expID,intentID};
    await queue.finish(r);assert.equal(await count(f.taskID),2);assert.equal(queue.size,1);
    now=1000;await queue.flush();assert.equal(await count(f.taskID),1);assert.equal(queue.size,1);
    now=2000;await queue.flush();assert.equal(queue.size,0);
    await markWorkerReleased(db,f.expID,intentID);
    assert.equal(Number((await db.query("SELECT count(*) n FROM blackboard_wakeups WHERE exploration_id=$1 AND event_key=$2",[f.expID,`worker:${intentID}:completed-attempt`])).rows[0]!.n),1);
    assert.equal((await db.query('SELECT 1 FROM engine_worker_slots WHERE id=$1',[busy])).rowCount,1);
    await coordinator.release(f.taskID,f.token);
  });
  await t.test('process loss after executor exit uses lease reclamation and durable settlement recovery',async()=>{
    const f=await fixture();
    const intentID=await db.exploration(f.expID).addNode('intent',{summary:'fixture',execution_stop:{attempt_id:'recovered-cleanup',reason:'completed'}},0,'done','fixture',[]);
    await db.transaction(tx=>coordinator.reserveWorkerSlot(tx,f.taskID,f.token,false,intentID));
    await db.query("UPDATE engine_task_leases SET expires_at=now()-interval '1 second' WHERE task_id=$1",[f.taskID]);
    const token=(await other.acquire(f.taskID))!;
    await other.workerSlot(f.taskID,token);
    await recoverWorkerSettlements(otherDB,f.expID);await recoverWorkerSettlements(otherDB,f.expID);
    assert.equal(Number((await db.query("SELECT count(*) n FROM blackboard_wakeups WHERE exploration_id=$1 AND event_key=$2",[f.expID,`worker:${intentID}:recovered-cleanup`])).rows[0]!.n),1);
    await other.release(f.taskID,token);
  });
  await t.test('Engine automatic and manual execution both retain failed cleanup until watchdog retry',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'fate-worker-capacity-'));
    const engine=new Engine(db,defaultEngineConfig(),async()=>{throw new Error('model must not run');},dir);
    // Control the executor completion boundary, not the actual production task.
    const internals=engine as any;
    let complete!:()=>void;
    const originalRelease=internals.coordinator.releaseSlot.bind(internals.coordinator);
    let releaseAttempts=0;
    internals.coordinator.releaseSlot=async(id:string)=>{
      releaseAttempts++;
      if(releaseAttempts===1)throw new Error('synthetic release outage');
      await originalRelease(id);
    };
    const until=async(predicate:()=>Promise<boolean>)=>{
      for(let n=0;n<100;n++){if(await predicate())return;await delay(25);}
      assert.fail('cleanup watchdog did not settle');
    };
    try{
      for(const manual of [false,true]){
        releaseAttempts=0;
        const f=await fixture(internals.coordinator);
        const node=await db.exploration(f.expID).addNode('intent',{summary:'local executor fixture'},0,manual?'paused':'open','fixture',[]);
        const rt=await internals.loadRuntime(f.taskID);
        Object.assign(rt,{lease:f.token,ready:true,started:true});
        internals.runOneIntent=()=>new Promise<void>(resolve=>{complete=resolve;});
        if(manual){
          const command=Number((await db.query('INSERT INTO runtime_worker_resumes(task_id,intent_id) VALUES($1,$2) RETURNING id',[f.taskID,node])).rows[0]!.id);
          assert.equal(await internals.acceptWorkerResume(rt,node,command),true);
        }else await internals.dispatchWorkers();
        assert.equal(await count(f.taskID),1);
        await db.query("UPDATE exploration_nodes SET state='done',payload=payload||jsonb_build_object('execution_stop',jsonb_build_object('reason','completed','attempt_id',$2::text)) WHERE id=$1",[node,`engine-${node}`]);
        assert.equal(await count(f.taskID),1,'terminal record cannot free a still-unwinding executor');
        complete();
        await until(async()=>engine.runtimeMetrics().pending_worker_releases===1);
        assert.equal(await count(f.taskID),1,'failed DELETE must remain occupied');
        await until(async()=>await count(f.taskID)===0&&engine.runtimeMetrics().pending_worker_releases===0);
        assert.equal(releaseAttempts,2);
        assert.equal(Number((await db.query("SELECT count(*) n FROM blackboard_wakeups WHERE exploration_id=$1 AND event_key=$2",[f.expID,`worker:${node}:engine-${node}`])).rows[0]!.n),1);
        rt.started=false;rt.stopped=true;
        await internals.coordinator.release(f.taskID,f.token);
      }
    }finally{await engine.shutdown();await rm(dir,{recursive:true,force:true});}
  });
});
