import type {Database} from '../db/index.js';
import type {IntentContract} from './intent-contract.js';
import {PLANNER_CONTINUATION_GUIDANCE} from './planner-continuation.js';

export const WORK_COORDINATION_GUIDANCE='【工作复用与分工】共享依据的方向需明确各自尚未解决的问题；同一结论不分给多个 Worker 分别验证。已有有效共享证据可以满足验收，不要求亲自重做。发现 Worker 方法不适配、参数错误或无效重复尝试时，优先用 steer_work 的 adjust_method 在原目标、原授权内调整方法，填写具体 method 和观察依据 reason；也可缩减范围或引用已有证据，验收项按原 contract.acceptance 的 0 起始索引引用；不通过自由文本派新任务，不替换当前方向或新增前置问题。Worker 已完成时正常结束；进入收尾后不得纠偏。明确无意义、重复或取消的方向直接 kill_work，保留已写回事实和 findings，不反复纠偏。业务目标已变化时，不沿用旧意图追加新目标：先 kill_work，核对已结束回执，再 add_intent 并填写 replaces_intent_id；新 Worker 使用独立会话，仅用 parent_ids/contract.basis 传递必要事实，不复制旧执行历史。停止失败或旧 Worker 尚未退出时不下发替代意图；不能绕过用户暂停或取消。不扩大授权。';

/** Every intent uses its actual assignment. Old policy labels have no execution meaning. */
export function workerMandate(id:number,payload:Record<string,unknown>,contract:IntentContract,assetsJSON:string,stopped:readonly number[]=[]):string{
  const indices=[...new Set(stopped.filter(i=>Number.isSafeInteger(i)&&i>=0&&i<contract.acceptance.length))];
  const update=indices.length?`\n\n【宿主范围缩减】停止原验收项 [${indices.join(', ')}]；已停止的项不重做，不追加替代工作。其余原验收项与原目标、授权、禁止事项保持有效。已有充分结论则正常结束。` : '';
  return `\n\n【当前意图 #${id} 执行要求】\n${JSON.stringify({summary:payload.summary,contract})}\n`+
    `只执行本意图，遵守用户明确步骤与实时约束，写回结果后结束。已有有效的共享事实可作为结论依据，注明来源；证据缺失或矛盾时才补充核对。\n`+
    `对话消息不能扩充目标、授权或验收项；自动纠偏支持原验收项的方法调整（adjust_method）、范围缩减和证据引用。方法建议必须结合原约定及最新操作约束核对；只执行原目标、原授权内的部分，不接受新增目标、验收项、资产范围或工具授权，不重启已停止项。\n`+
    `【锚定资产索引】\n${assetsJSON}${update}`;
}

/** A missing receipt is observable host state, not a semantic judgment on prose.
 * Used once by the existing bounded PI wrapup; never creates work itself. */
export async function plannerDispatchReminder(db:Database,taskID:number,expID:number):Promise<string|undefined>{
  const row=(await db.query(`SELECT t.status,t.paused,t.queued,t.execution_mode,
    (t.deadline_at IS NOT NULL AND t.deadline_at<=clock_timestamp()) timed_out,
    EXISTS(SELECT 1 FROM exploration_nodes WHERE exploration_id=$2 AND kind='intent' AND state IN ('open','running')) has_active_intent,
    EXISTS(SELECT 1 FROM exploration_nodes WHERE exploration_id=$2 AND kind='goal' AND goal_display_state(id)<>'met') has_open_goal
    FROM tasks t WHERE t.id=$1 AND t.exploration_id=$2 AND t.deleted_at IS NULL`,[taskID,expID])).rows[0];
  if(!row||row.status!=='running'||row.paused||row.queued||row.timed_out||row.execution_mode!=='managed'||row.has_active_intent||!row.has_open_goal)return;
  return '宿主回执核对：目标尚未全部有效达成，当前没有 open/running 意图，文字中的派单描述不会启动 Worker。'+PLANNER_CONTINUATION_GUIDANCE+'这是本轮唯一一次核对提醒，沿用剩余预算。';
}
