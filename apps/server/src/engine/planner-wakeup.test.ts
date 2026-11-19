import assert from 'node:assert/strict';
import {test} from 'node:test';
import {plannerHeartbeatDue,plannerWakeupReady} from './planner-wakeup.js';

test('idle unfinished goals wake on the smaller heartbeat even without changes',()=>{
  const base={now:0,lastPlannedAt:0,heartbeatMs:600_000,running:0,revisionChanged:false,unfinished:true,hasActiveIntent:false};
  for(const [heartbeat,interval] of [[600_000,120_000],[30_000,30_000]] as const){
    assert.equal(plannerHeartbeatDue({...base,heartbeatMs:heartbeat,now:interval!-1}),false);
    const due=plannerHeartbeatDue({...base,heartbeatMs:heartbeat,now:interval!});
    assert.equal(due,true);
    assert.equal(plannerWakeupReady([],{now:interval!,running:0,hasControl:false,heartbeatDue:due}),true);
    assert.equal(plannerHeartbeatDue({...base,heartbeatMs:heartbeat,lastPlannedAt:interval!,now:interval!+1}),false);
  }
  assert.equal(plannerHeartbeatDue({...base,now:600_000,unfinished:false}),false);
  assert.equal(plannerHeartbeatDue({...base,now:120_000,hasActiveIntent:true}),false);
  assert.equal(plannerHeartbeatDue({...base,now:600_000,hasActiveIntent:true,running:1}),true);
});

test('event batching still coalesces worker bursts and preserves urgent controls',()=>{
  const event={id:1,node_id:null,kind:'assets_changed',urgent:false,oldest_at:new Date(0)};
  const opts={now:29_999,running:1,hasControl:false,heartbeatDue:false};
  assert.equal(plannerWakeupReady([event],opts),false);
  assert.equal(plannerWakeupReady([event],{...opts,now:30_000}),true);
  assert.equal(plannerWakeupReady([event],{...opts,running:0}),true);
  assert.equal(plannerWakeupReady([{...event,urgent:true}],opts),true);
});
