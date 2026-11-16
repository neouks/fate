/** Diagnostics describe missing receipts, never authorize replay or assert external outcomes. */
export interface OperationInterruption {
  reason: string;
  phase: 'tool_execution' | 'receipt_persistence' | 'unknown';
  message: string;
  recorded_at?: string;
  source: 'executor' | 'activity' | 'unknown';
  activity_ref?: string;
}
const reasons: Record<string,string> = {
  pause:'任务暂停',task_paused:'任务暂停',cancel:'意图暂停',intent_paused:'意图暂停',
  kill:'宿主终止意图',planner_terminated:'Planner 终止意图',main_terminated:'Main Agent 终止意图',user_cancelled:'用户取消',
  'task-timeout':'任务超时',task_timeout:'任务超时',stop:'执行器停止',executor_stopped:'执行器停止',
  'lease-lost':'执行租约丢失',lease_lost:'执行租约丢失','task-completed':'任务完成',task_completed:'任务完成',
  'task-ended':'任务结束',task_ended:'任务结束',shutdown:'服务关闭',service_shutdown:'服务关闭',
  aborted:'调用被取消（未记录具体宿主原因）',exception:'工具抛出异常',receipt_error:'返回结果保存失败',
  unknown:'历史记录未保存具体中断原因',
};
export function interruption(error:unknown,phase:OperationInterruption['phase'],signal?:AbortSignal):OperationInterruption {
  return {reason:signal?.aborted?(typeof signal.reason==='string'?signal.reason:'aborted'):phase==='receipt_persistence'?'receipt_error':'exception',
    phase,message:error instanceof Error?error.message:String(error),recorded_at:new Date().toISOString(),source:'executor'};
}
export function interruptionText(id:number,value:OperationInterruption,blocked:boolean|undefined,started?:unknown,finished?:unknown):string {
  const date=(v:unknown)=>v instanceof Date?v.toISOString():typeof v==='string'?v:undefined;
  return [
    blocked===undefined?'原操作缺少完整返回，已执行步骤及外部结果仍待核对。':blocked?'本次工具调用在执行前被拦截，未执行。':'本次工具已进入执行阶段，但未保存完整返回；此前请求或写入可能已经发生。',
    `operation:${id} 的实际执行结果未知；不自动重放。`,
    `中断原因：${reasons[value.reason]??value.reason}；阶段：${value.phase==='tool_execution'?'工具执行中':value.phase==='receipt_persistence'?'工具已返回，保存结果时失败':'历史记录不足，无法确定执行步骤'}。`,
    date(started)?`原操作开始：${date(started)}`:null,
    date(finished)||value.recorded_at?`中断记录时间：${date(finished)??value.recorded_at}`:null,
    value.message?`原始错误／宿主记录：${value.message}`:null,
    value.activity_ref?`原因来源：${value.activity_ref}（历史日志，只读关联）`:null,
    '先用 context_get 读取该操作记录、保存已有事实并结束本意图，待核对后恢复；不要把取消当作回滚或未执行。',
  ].filter(Boolean).join('\n');
}
