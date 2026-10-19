import test from 'node:test';
import assert from 'node:assert/strict';
import {turnParts,durationLabel,newerSummary} from './turn-summary.ts';
const a=(seq,kind,extra={})=>({seq,kind,worker:'main',ts:'2026-10-19T00:00:00Z',summary:'',...extra});
test('final reference is outside process and lifecycle never becomes a completion bubble',()=>{
 const final=a(4,'text',{summary:'答复'});const steps=[a(1,'status',{metadata:{event_type:'turn_start'}}),a(2,'text',{summary:'中途说明'}),a(3,'tool_use'),final,a(5,'result',{metadata:{event_type:'lifecycle'},summary:'回复完成'})];
 const out=turnParts(steps,{final_activity:final});assert.deepEqual(out.process.map(s=>s.seq),[2,3]);assert.equal(out.final.seq,4);
});
test('native empty tool response metadata is not rendered as prose',()=>{
 assert.equal(turnParts([a(1,'status',{metadata:{response:{}}})]).process.length,0);
});
test('a summary delivered before its final activity also replaces the live snapshot atomically',()=>{
 const final=a(4,'text',{summary:'完整正文',metadata:{stream_id:'s',channel:'text'}});
 const out=turnParts([a(-1,'text',{summary:'完整',streaming:true,stream_id:'s'})],{final_activity:final});
 assert.equal(out.process.length,0);assert.equal(out.final.summary,'完整正文');
});
test('legacy prose stays in order; no guessed final answer',()=>{
 const steps=[a(1,'text',{summary:'之前'}),a(2,'tool_use'),a(3,'text',{summary:'之后'})];assert.deepEqual(turnParts(steps),{final:undefined,process:steps});
});
test('final outside current page is available, a repeated receipt prints only once',()=>{
 const final=a(4,'result',{summary:'结论',metadata:{event_type:'outcome'}});const out=turnParts([a(1,'text',{summary:'结论'})],{final_activity:final});assert.equal(out.final,final);assert.equal(out.process.length,0);
});
test('status duration and summary ordering never invent timing or regress after a late fetch',()=>{
 assert.equal(durationLabel(null,null,0),'耗时未记录');assert.equal(durationLabel('2026-10-19T00:00:00Z','2026-10-19T00:02:59Z',0),'2 分 59 秒');
 assert.equal(newerSummary({revision:5,updated_at:'2026-10-19'},{revision:4,updated_at:'2026-10-20'}),false);
});
