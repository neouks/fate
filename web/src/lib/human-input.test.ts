import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mergeHumanInputs,humanInputSession,type HumanInputRequest} from './human-input';
test('reconnect cannot restore a pending state after its answer or mix task scopes',()=>{
 const r:HumanInputRequest={id:'a',task_id:'1',role:'worker',intent_id:'2',main_seg:0,turn_id:'t',kind:'input',question:'q',sensitive:true,status:'answered',created_at:'2026-01-01',updated_at:'2026-01-02'};
 assert.deepEqual(mergeHumanInputs([r],[{...r,status:'pending',updated_at:'2026-01-02'},{...r,id:'other',task_id:'3'}],'1','snapshot'),[r]);
 assert.equal(humanInputSession(r),'intent:2');assert.equal(humanInputSession({...r,role:'planner'}),'plan');assert.equal(humanInputSession({...r,role:'mainagent',main_seg:3}),'main:3');
});

test('a reconnect snapshot replaces pending membership while individual history reads preserve it',()=>{
 const old:HumanInputRequest={id:'old',task_id:'1',role:'planner',turn_id:'t',main_seg:0,kind:'input',question:'旧问题',sensitive:false,status:'pending',created_at:'2026-01-01',updated_at:'2026-01-01'};
 const cached={...old,id:'cached',status:'cancelled' as const};
 const current={...old,id:'current'};
 const recent=Array.from({length:100},(_,i)=>({...old,id:String(i),status:'answered' as const}));
 const synced=mergeHumanInputs([old,current,cached],[...recent,current],'1','snapshot');
 assert.deepEqual(synced.filter(r=>r.status==='pending'),[current]);
 assert.ok(synced.includes(cached));
 assert.ok(!synced.some(r=>r.id===old.id));
 assert.deepEqual(mergeHumanInputs(synced,[old],'1','detail'),synced);
 const past={...old,status:'expired' as const};
 const history=mergeHumanInputs(synced,[past],'1','detail');
 assert.ok(history.includes(past));
 assert.ok(history.includes(current));
 assert.deepEqual(mergeHumanInputs(history,[],'1','snapshot'),history.filter(r=>r!==current));
});
