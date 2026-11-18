/** Compatibility for exact retired built-in text in stored prompts and tool descriptions. */
const replacements: readonly (readonly [string, string])[] = [
  [
    "prove_goal 返回 awaiting_confirmation / pending_confirmation 表示证据已提交、等待人工确认，不表示证据不足或需要更多探测。不要重复提交催促，不换证据节点来制造新申请，不为了把目标从待确认变成 met 而另派 Worker。多个目标分别处理：已提交者等待，其他确有缺口的目标可以继续。有新的具体反证、证据失效或用户更改要求时再评估；不得替用户批准目标。",
    "prove_goal 通过证据有效性校验后直接将目标标记为 met；以工具返回的 met 和 all_goals_met 为准。目标或证据变化会使旧证明失效，重新核对后再提交。已达成目标无需重复提交或另派复核；其他有具体缺口的目标继续按各自证据处理。"
  ],
  [
    "用仍获授权的 confirmed 事实或漏洞提交目标验收；量化覆盖或数量仅在用户目标明确要求时核对。多个事实可共同支持判断，note 说明引用关系，不为合并报告重新探测。awaiting_confirmation 表示已提交并等待人工确认，本目标无新增反证或具体缺口时结束本轮，不重复提交或另派复核。",
    "用仍获授权的 confirmed 事实或漏洞证明目标；证据校验成功后直接标记 met。量化覆盖或数量仅在用户目标明确要求时核对。多个事实可共同支持判断，note 说明引用关系，不为合并报告重新探测。以返回的 met/all_goals_met 判断是否达成，证据失效后重新核对。"
  ],
  [
    "派前核对已保存结论与 scope；已充分回答目标时不再派同方向复核。只有影响用户目标判定的具体证据缺口、矛盾、条件变化或用户明确复测要求才补派，在 objective/acceptance 说明受影响对象、缺口与停止条件并用 basis 引用依据。未受影响对象沿用已有结论，契约明确无需复测；不附带“如需顺便复核其他对象”的可选验收项。扩大复核须有影响共同前提的新观测依据。等待人工确认、整理成一条事实/正式 finding、假设隐藏入口或重复独立取样均不单独构成派单理由。",
    "派前核对已保存结论与 scope；已充分回答目标时不再派同方向复核。只有影响用户目标判定的具体证据缺口、矛盾、条件变化或用户明确复测要求才补派，在 objective/acceptance 说明受影响对象、缺口与停止条件并用 basis 引用依据。未受影响对象沿用已有结论，契约明确无需复测；不附带“如需顺便复核其他对象”的可选验收项。扩大复核须有影响共同前提的新观测依据。整理成一条事实/正式 finding、假设隐藏入口或重复独立取样均不单独构成派单理由。"
  ],
  [
    " 每次只提交一项目标的证据。仅明确的资产测试覆盖度 100% 由宿主核验，其他目标返回 awaiting_confirmation 等待人工确认；不得把提交申请描述为目标已完成。all_goals_met=false 时仍有目标待验收，不重复提交同一申请。",
    " 每次只证明一项目标；证据校验成功后直接标记 met，明确的资产覆盖度 100% 另由宿主核对实时覆盖记录。以 met/all_goals_met 回执为准。"
  ]
];
export function normalizeGoalProofInstructions(text: string): string {
  for (const [before, after] of replacements) text = text.replaceAll(before, after);
  return text;
}
export const GOAL_PROOF_PROTOCOL = '【目标证明协议】prove_goal 通过证据校验后直接将目标标记为 met。以工具回执为准；历史会话中的人工审批流程已取消。证据不足先补齐，目标或证据变化后重新核对。';
