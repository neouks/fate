/** Shared wording for actual model declarations, previews and host role contracts. */
export const FINDING_WRITE_GUIDANCE='新漏洞先 context_search(types=["finding"]) 查重。补资产或证据不是新漏洞：先 context_get 读取 finding_detail.id 和 evidence_version，再用 report_finding(finding_id,evidence_version,asset_ids/evidence/traffic_refs/reproduction/scope) 补正原记录。finding_id 是漏洞记录编号，不是图节点编号；资产和证据追加，原记录与历史不覆盖。重复返回已有编号时不重报；疑似重复先核对，确为独立问题才填 distinct_from 和 distinct_reason。';
export const FINDING_PLANNER_GUIDANCE='已有漏洞缺资产或证据时，先读正式 finding_id 和 evidence_version，优先让原 Worker 在当前意图内补正同一记录；原 Worker 已结束时查重后单独安排一次补正工作。纠偏写明原编号与缺项，不要求重新报洞，不同时指派多个 Worker 补同一缺项。补正和去重回执不是新增漏洞；以 updated/created/duplicate 区分。Planner 不直接执行或写漏洞。';
export function findingRoleProtocol(role:string):string {
  if(role==='planner')return FINDING_PLANNER_GUIDANCE;
  if(role==='pentest')return FINDING_WRITE_GUIDANCE.replaceAll('report_finding','report_conversation_finding');
  if(['worker','mainagent'].includes(role))return FINDING_WRITE_GUIDANCE;
  return '';
}
export const PREVIOUS_FINDING_DESCRIPTION='提交亲自验证且可复现的漏洞和真实证据，成功立即入图。asset_ids 只列实际受影响资产，缺省不继承意图范围；scope 说明已验证范围和限制。先 context_search 按 finding 查重；疑似结论用 record_fact。';
export function isPreviousFindingDescription(value:unknown):boolean {
  return [PREVIOUS_FINDING_DESCRIPTION,PREVIOUS_FINDING_DESCRIPTION+' 通过 reproduction 保存入口、前置条件、有序利用链及真实请求/响应；缺失留空。'].includes(value as string);
}
