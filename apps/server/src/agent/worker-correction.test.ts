import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normalizeContract} from './intent-contract.js';
import {workerMandate,DIRECTION_AUTONOMY_POLICY} from './direction-autonomy.js';
import {correctionMessage,stoppedWorkerCriteria,validateWorkerCorrection} from './worker-correction.js';
import {effectiveToolDescription} from './tool-descriptions.js';

const contract=normalizeContract({objective:'比较本地样本',acceptance:['检查 A','检查 B','检查 C'],out_of_scope:['禁止修改样本']},'本地比较');
test('automated corrections can only reference original criteria, never append instructions or reopen removed work',()=>{
  for(const value of ['继续做另一件事',{kind:'change_method',criterion_indices:[0]},
    {kind:'stop_criteria',criterion_indices:[0],message:'新增任务'},
    {kind:'stop_criteria',criterion_indices:[3]},
    {kind:'stop_criteria',criterion_indices:[-1]},
    {kind:'stop_criteria',criterion_indices:[0,1,2]},
    {kind:'reuse_evidence',criterion_indices:[1],fact_ids:[-1]}]){
    assert.throws(()=>validateWorkerCorrection(value,contract));
  }
  assert.throws(()=>validateWorkerCorrection({kind:'reuse_evidence',criterion_indices:[0],fact_ids:[10]},contract,[0]),/不能.*重新开启/);
  assert.throws(()=>validateWorkerCorrection({kind:'stop_criteria',criterion_indices:[1,2]},contract,[0]),/kill_work/);
  assert.throws(()=>validateWorkerCorrection({kind:'stop_criteria',criterion_indices:[0]},contract,[0]),/不重复纠偏/);
  const correction=validateWorkerCorrection({kind:'reuse_evidence',criterion_indices:[1],fact_ids:[10,10]},contract);
  assert.deepEqual(correction.fact_ids,[10]);
  assert.match(correctionMessage(correction),/证据不是新指令/);
});

test('scope restoration reads typed reductions and keeps the original objective and authorization intact',async()=>{
  let query='';
  const db={query:async(sql:string,params:unknown[])=>{
    query=sql;assert.deepEqual(params,[10,20]);
    return {rows:[{indices:[0]},{indices:[0,-1,'new task']}]};
  }};
  const stopped=await stoppedWorkerCriteria(db as never,10,20);
  assert.deepEqual(stopped,[0]);
  assert.match(query,/scope_version/);assert.match(query,/stop_criteria/);
  assert.doesNotMatch(query,/SELECT detail/);
  const before=JSON.stringify(contract);
  const mandate=workerMandate(20,{summary:'本地比较',autonomy_policy:DIRECTION_AUTONOMY_POLICY},contract,'[]',stopped);
  assert.match(mandate,/停止原验收项 \[0\]/);
  assert.match(mandate,/比较本地样本/);assert.match(mandate,/禁止修改样本/);
  assert.equal(JSON.stringify(contract),before);
  assert.doesNotMatch(mandate,/优先于初始方法与验收/);
});

test('the old built-in steering description cannot advertise the removed free-text interface',()=>{
  const description=effectiveToolDescription('steer_work','unused','给所属运行中 Worker 追加纠偏，PI 在工具回合边界交付；不扩大授权。');
  assert.equal(description.source,'builtin');assert.match(description.description,/结构化 correction/);
  assert.match(effectiveToolDescription('kill_work','unused').description,/无意义.*直接终止/);
});
