import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normalizeContract} from './intent-contract.js';
import {workerMandate} from './worker-assignment.js';
import {correctionMessage,stoppedWorkerCriteria,validateWorkerCorrection} from './worker-correction.js';
import {effectiveToolDescription} from './tool-descriptions.js';

const contract=normalizeContract({objective:'比较本地样本',acceptance:['检查 A','检查 B','检查 C'],out_of_scope:['禁止修改样本']},'本地比较');
test('automated corrections reference original criteria and cannot reopen removed work',()=>{
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
  const mandate=workerMandate(20,{summary:'本地比较',autonomy_policy:'direction-autonomy-v2'},contract,'[]',stopped);
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

test('method correction requires bounded advice and grounds it in original criteria without granting permissions',()=>{
 const input={kind:'adjust_method',criterion_indices:[2,1,2],method:'  按分号分列\r\n保持只读  ',reason:'  按逗号无法分列  '};
 const original=JSON.stringify(contract),c=validateWorkerCorrection(input,contract);
 assert.deepEqual(c,{kind:'adjust_method',criterion_indices:[1,2],method:'按分号分列\n保持只读',reason:'按逗号无法分列'});
 assert.equal(JSON.stringify(contract),original);
 assert.match(correctionMessage(c),/工具授权及用户操作约束均不变/);
 assert.match(workerMandate(1,{},contract,'[]'),/adjust_method/);
 for(const bad of [{...input,method:''},{...input,reason:' '},{...input,method:'字'.repeat(2001)},
  {...input,reason:'字'.repeat(1001)},{...input,fact_ids:[1]},{...input,criterion_indices:[3]},
  {...input,objective:'新目标'},{...input,allowed_tools:['bash']},{...input,acceptance:['新验收项']},
  {kind:'reuse_evidence',criterion_indices:[0],fact_ids:[1],method:'其他方法'}])assert.throws(()=>validateWorkerCorrection(bad,contract));
 assert.throws(()=>validateWorkerCorrection(input,contract,[1]),/不能.*重新开启/);
});

test('exact previous built-in help upgrades but intentional custom instructions remain custom',()=>{
 const old='仅用结构化 correction 缩减原验收项（stop_criteria），或向原验收项引用已有事实（reuse_evidence）；criterion_indices 是原 acceptance 的 0 起始索引。禁止自由文本新任务、改变目标或新增前置问题。收尾或完成后禁止纠偏；无意义或重复的直接 kill_work。';
 const suffix=' stop_criteria 不传 fact_ids；reuse_evidence 必须传 fact_ids。仅支持这两种结构化纠偏，不能追加自由文本方法或替换业务目标。目标变化先 kill_work 确认结束，再 add_intent(replaces_intent_id)，使用新会话。原授权和禁止事项仍有效。';
 for(const stored of [old,old+suffix]){
  const next=effectiveToolDescription('steer_work','unused',stored);
  assert.equal(next.source,'builtin');assert.match(next.description,/adjust_method/);
  assert.doesNotMatch(next.description,/仅支持这两种|不能追加自由文本方法/);
 }
 const custom=effectiveToolDescription('steer_work','unused','调整前先核对用户规定的请求预算。');
 assert.equal(custom.source,'custom');assert.match(custom.description,/先核对用户规定的请求预算/);
});
