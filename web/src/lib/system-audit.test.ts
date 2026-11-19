import assert from 'node:assert/strict';
import {test} from 'node:test';
import {auditSessionKeys,auditHistoryQuery,auditSourceHref,auditStatus} from './system-audit';
import {mergeConversationActivities} from './conversation-turns';
import type {Activity} from './types';
const event:Activity={seq:42,kind:'status',worker:'w1',intent_id:'12',ts:'2026-11-19T00:00:00Z',summary:'纠偏',audit_event:{type:'correction',source:'user',status:'submitted',title:'Worker 纠偏',intent_id:'12',source_session:'intent:12'}};
test('multicast preserves original lane and sequence identity across history/SSE replay',()=>{
 assert.deepEqual(auditSessionKeys(event,'intent:12'),['intent:12','system','system:correction']);
 assert.deepEqual(mergeConversationActivities([event],[event,{...event,seq:43}]).map(r=>r.seq),[42,43]);
 assert.deepEqual(auditSessionKeys({...event,audit_event:undefined},'intent:12'),['intent:12']);assert.deepEqual(auditSessionKeys({...event,audit_event:undefined},'system'),[]);
 assert.deepEqual(auditHistoryQuery('system:correction'),{session:'system',auditType:'correction'});assert.equal(auditStatus('submitted'),'已提交');assert.equal(auditStatus('made_up'),'状态未记录');
});
test('links locate original activity and the actual fact node',()=>{
 const source=new URL(auditSourceHref('7',event)!,'http://localhost');assert.equal(source.searchParams.get('session'),'intent:12');assert.equal(source.searchParams.get('activity'),'42');
 const fact=new URL(auditSourceHref('7',{...event,audit_event:{type:'important_fact',source:'worker',status:'saved',title:'重要事实',fact_id:'15'}})!,'http://localhost');assert.equal(fact.searchParams.get('node'),'15');assert.equal(fact.searchParams.get('tab'),'graph');
});
