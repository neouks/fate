// Offline validation keeps the raw provider transcript immutable. A schema or
// version rejection is acceptable only if it was followed by a successful retry
// and every task/intent/graph/audit invariant still holds.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const [input,output]=process.argv.slice(2);if(!input||!output)throw new Error('usage: verify-terminal-probe INPUT OUTPUT');
const raw=readFileSync(input,'utf8'),r=JSON.parse(raw),recoveries:any[]=[];
assert.equal(r.cases.length,3);assert.equal(r.target_requests,0);assert.equal(r.audit.length,r.calls);
assert.ok(r.audit.every((a:any)=>a.status==='completed'));
for(const c of r.cases){
 const expected=c.kind==='serial'?2:1;
 assert.equal(c.status,'passed');assert.equal(c.task.status,'done');assert.ok(c.task.completed_at);
 assert.equal(c.intents.length,expected);assert.equal(c.facts.length,expected);
 assert.ok(c.intents.every((n:any)=>n.state==='done'&&n.payload.execution_result?.outcome==='complete'));
 assert.ok(c.goals.length>0&&c.goals.every((g:any)=>g.state==='met'));
 for(const n of [...c.intents,...c.facts])assert.ok(c.anchors.some((a:any)=>Number(a.node_id)===n.id&&Number(a.asset_id)===c.asset_id));
 for(const n of c.intents)assert.ok(c.edges.some((e:any)=>Number(e.src_id)===n.id&&e.rel==='yields'));
 for(const g of c.goals)assert.ok(c.edges.some((e:any)=>Number(e.dst_id)===g.id&&e.rel==='proves'));
 const planner=r.runner_results.filter((x:any)=>x.task_id===c.task_id&&x.role==='planner');
 assert.ok(planner.length>0&&planner.every((x:any)=>x.stopReason==='completed'&&!x.aborted&&!x.error));
 assert.equal(c.remaining_leases,0);assert.equal(c.remaining_worker_slots,0);assert.equal(c.quiet_after_done_ms,10_000);
 if(c.kind==='manual'){assert.equal(c.manual_planner_calls,0);assert.equal(c.feedback.length,1);assert.equal(c.feedback[0].published,true);}
}
for(const a of r.activity.filter((a:any)=>a.is_error)){
 assert.equal(a.kind,'tool_result');
 assert.match(a.detail,/^Invalid arguments for tool |节点版本已变化|依据 #\d+ 已变化或不再授权|节点 #\d+ 不存在或不属于本任务及直接来源任务|Worker 尚未提交最终验收结果/);
 const recovered=r.activity.find((b:any)=>Number(b.id)>Number(a.id)&&b.exploration_id===a.exploration_id&&b.worker===a.worker&&b.tool===a.tool&&b.kind==='tool_result'&&!b.is_error);
 assert.ok(recovered,'a rejected call must be followed by a successful call, not silently ignored');
 recoveries.push({rejected_activity_id:a.id,recovered_activity_id:recovered.id,tool:a.tool,kind:a.detail.startsWith('Invalid arguments')?'provider_invalid_tool_json':'host_guard_rejection'});
}
const result={status:'passed_with_recovered_model_error',source:input,source_sha256:createHash('sha256').update(raw).digest('hex'),validated_at:new Date().toISOString(),calls:r.calls,target_requests:0,recoveries,
 cases:r.cases.map((c:any)=>({kind:c.kind,task_id:c.task_id,status:'done',intents:c.intents.length,goals:c.goals.length,elapsed_ms:c.elapsed_ms,natural_planner_completion:true,remaining_leases:0,remaining_worker_slots:0}))};
writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
