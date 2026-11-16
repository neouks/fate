import type {Database} from '../db/index.js';

export const PLANNER_CONVERGENCE_POLICY='planner-evidence-convergence-v1';
export const PLANNER_CONVERGENCE_GUIDANCE=`【按证据收敛】
Worker 结束后先核对它已保存的 fact、finding、原始流量与 scope，对照用户目标判断，而不是另派一个 Worker 再做一次相同核验。多个节点可以共同支持结论；不要求合并成一条事实、改写为正式 finding 或由另一 Worker 独立取样。原始证据已保存时先用 context_get、traffic_search 等读取；摘要未展示某字段、资产覆盖计数未计入入口，不等于缺少实测证据。
已有证据回答了用户问题，并说明已测范围、未知部分和实际限制时，直接引用已有证据提交目标验收并结束本轮。未知部分是结论边界，不自动成为新的验收条件：用户未要求全站/全量覆盖时，不为假设的隐藏商品、分页参数、其他响应格式、结算行为或入口价格字段追加派单；不能要求证明不存在一切未知入口。数据一致、数据不一致和有范围的负面结果都可以是对问题的有效回答，按实际证据判断。
只有会影响当前用户目标判定的具体缺口才追加工作：必需对象的数据确实缺失、已有证据互相矛盾、来源/版本/条件变化使旧证据不足、用户明确要求复测或验收退回了具体问题。先读取引用的证据，说明“哪一项用户要求尚未回答、现有节点缺什么或冲突在哪里、补完什么即可停止”，通过 contract.objective/acceptance 和 basis 表达。仅写“更稳健、补齐闭环、再确认、可能还有更多”不构成新依据。保留必要补全和矛盾复核，不把所有后续派单一律禁止；运行中优先协调原 Worker，已结束则仅派明确剩余问题，不重做已完成方向。
补派时逐项限定证据失效的实际影响范围：每个验收要求都对应已观察到的缺口或矛盾，未受影响的对象沿用已有结论，并在契约中明确无需复测。不要附加“如需顺便复核其他对象”、为同一时点重采所有结果或重新完成整个方向的可选验收项；一个对象发生变化，并不自动使其他对象的证据失效。只有新观测确实改变共享依赖、来源、权限或数据条件，并影响其他结论时，才说明关联依据后扩展复核。Worker 仍可自主选择解决当前问题的方法；当前缺口解决后结合已保存的其他结论提交验收。
prove_goal 返回 awaiting_confirmation / pending_confirmation 表示证据已提交、等待人工确认，不表示证据不足或需要更多探测。不要重复提交催促，不换证据节点来制造新申请，不为了把目标从待确认变成 met 而另派 Worker。多个目标分别处理：已提交者等待，其他确有缺口的目标可以继续。有新的具体反证、证据失效或用户更改要求时再评估；不得替用户批准目标。`;

export const CONVERGENCE_ADD_INTENT_HINT='派前核对已保存结论与 scope；已充分回答目标时不再派同方向复核。只有影响用户目标判定的具体证据缺口、矛盾、条件变化或用户明确复测要求才补派，在 objective/acceptance 说明受影响对象、缺口与停止条件并用 basis 引用依据。未受影响对象沿用已有结论，契约明确无需复测；不附带“如需顺便复核其他对象”的可选验收项。扩大复核须有影响共同前提的新观测依据。等待人工确认、整理成一条事实/正式 finding、假设隐藏入口或重复独立取样均不单独构成派单理由。';
export const CONVERGENCE_PROVE_GOAL_HINT='用仍获授权的 confirmed 事实或漏洞提交目标验收；量化覆盖或数量仅在用户目标明确要求时核对。多个事实可共同支持判断，note 说明引用关系，不为合并报告重新探测。awaiting_confirmation 表示已提交并等待人工确认，本目标无新增反证或具体缺口时结束本轮，不重复提交或另派复核。';

export function upgradePlannerConvergencePrompt(text:string):string{
  return text.includes(PLANNER_CONVERGENCE_GUIDANCE)?text:text+'\n\n'+PLANNER_CONVERGENCE_GUIDANCE;
}

/** Bounded, authorized evidence index, refreshed on every PI request and after restore.
 * These are observations, not an automatic semantic acceptance or execution gate. */
export async function plannerConvergenceState(db:Database,taskID:number,expID:number){
  const task=(await db.query('SELECT id FROM tasks WHERE id=$1 AND exploration_id=$2 AND deleted_at IS NULL',[taskID,expID])).rows[0];
  if(!task)throw new Error('Planner 收敛上下文的任务归属无效');
  const goals=(await db.query(`SELECT g.id,LEFT(g.payload->>'text',1000) text,goal_display_state(g.id) state,
    CASE WHEN exploration_node_readable($1,p.evidence_id) THEN p.evidence_id END evidence_id
    FROM exploration_nodes g LEFT JOIN LATERAL (SELECT evidence_id FROM goal_acceptance WHERE goal_id=g.id ORDER BY id DESC LIMIT 1) p ON true
    WHERE g.exploration_id=$1 AND g.kind='goal' ORDER BY g.id LIMIT 20`,[expID])).rows;
  const work=(await db.query(`SELECT id,state,LEFT(payload->>'summary',800) summary,payload->'execution_stop'->>'reason' stop_reason
    FROM exploration_nodes WHERE exploration_id=$1 AND kind='intent' AND payload ? 'execution_stop'
    ORDER BY id DESC LIMIT 6`,[expID])).rows;
  const observations=(await db.query(`SELECT n.id,n.kind,n.content_version version,n.state,n.payload->>'from_intent' intent_id,
    LEFT(n.payload->>'summary',1000) summary,n.payload->'scope' scope,n.payload->>'observation_type' observation_type,
    n.payload->'writeback' writeback,COALESCE(NULLIF(f.evidence,''),NULLIF(n.payload->>'evidence','')) IS NOT NULL has_evidence,
    f.status finding_status
    FROM exploration_nodes n LEFT JOIN findings f ON f.node_id=n.id
    WHERE n.exploration_id=$1 AND n.kind IN ('fact','finding')
    AND (n.payload->>'from_intent'=ANY($2::text[]) OR n.payload->>'from_intent' IS NULL)
    AND exploration_node_readable($1,n.id) ORDER BY n.id DESC LIMIT 24`,[expID,work.map(w=>String(w.id))])).rows;
  return {policy:PLANNER_CONVERGENCE_POLICY,goals,recent_work:work,observations,
    guidance:'这是有界的证据与范围索引，不自动判定充分性。结合用户目标及完整证据；scope 的未知边界不自动生成新目标。pending_confirmation 等待人工，不能靠重复探测变成 met。缺失关键数据或新矛盾仍须补全。',
    read_more:'context_search/context_get 读取未展示的事实、漏洞与原文；不要为整理已有证据派新 Worker'};
}
