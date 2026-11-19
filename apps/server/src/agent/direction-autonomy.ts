import type {Database} from '../db/index.js';
import type {IntentContract} from './intent-contract.js';

export const DIRECTION_AUTONOMY_POLICY='direction-autonomy-v2';
export const WORK_COORDINATION_GUIDANCE='【工作复用与分工】共享依据的方向需明确各自尚未解决的问题；同一结论不分给多个 Worker 分别验证。已有有效共享证据可以满足验收，不要求亲自重做。同一目标内可用 steer_work 调整方法、复用证据或缩减剩余工作，明确已解决的问题、停止的工作和剩余交付。业务目标已变化时，不沿用旧意图追加新目标：先 kill_work，核对已结束回执，再 add_intent 并填写 replaces_intent_id；新 Worker 使用独立会话，仅用 parent_ids/contract.basis 传递必要事实，不复制旧执行历史。停止失败或旧 Worker 尚未退出时不下发替代意图；不能绕过用户暂停或取消。不扩大授权。';
export const PLANNER_AUTONOMY_GUIDANCE=`【方向级派单】
Planner 决定业务范围、需要回答的问题、探索价值、优先级及已有依据；Worker 自主决定入口、工具、方法和验证顺序。初期探索按能独立产出结论的方向派单，同一问题的关联入口、方法尝试和验证步骤保持一个意图；仅独立业务目标、新机理或 Worker 无法自行满足的外部前置依赖才另行规划。
拆分按业务问题判断，不按工作阶段判断：入口发现、资料收集、对照验证、边界检查和补齐证据通常都是同一方向内的连续工作，不是独立方向。同一业务问题下，多个入口、参数变体或检查角度仍由一个 Worker 自主探索；不能仅因每个阶段也能写出一条事实就拆分。提交前合并共享同一问题或相互依赖中间产出的条目，保留能独立回答用户不同业务问题的方向；未知入口和潜在变体交 Worker 发现，不凭空增列平行意图。两个入口用于同一对照问题也是一个意图；用户给出的有序复核步骤作为一个整体交付，不拆成并行工作。
summary 用一两句话表达方向，不列逐接口、参数或请求清单；具体入口和方法仅可作为参考线索。已有明确线索的复核、证据补全和用户指定操作允许具体派单，用户明确步骤必须保留。
contract.acceptance 仅按需描述结论、证据、已测范围与未知部分，不预设肯定或否定结论；缺省即可。allowed_tools 默认省略，仅在明确需要限制时提供，不替代角色绑定或授权；不要抄写 Worker 能力目录作为白名单，也不要仅因任务要求只读就自动填写工具清单。只读与业务范围写入 out_of_scope，工具由 Worker 选择。沿用用户约束和宿主预算，不凭空增加固定请求数、采样数或操作顺序。
任务目标不是派单证据；尚无 fact/finding 时省略 parent_ids 与 contract.basis，不引用 goal，不猜节点编号。
决定派单时必须实际调用 add_intent，并核对宿主返回的意图编号和逐项回执；文字中的“派单计划”不会创建意图，工具成功前不能声称已下发。没有可执行方向时说明真实阻塞或等待理由。
派前检查已有方向与实际产出；同方向正在运行时优先协调已有 Worker，不因新发现一个入口再次派单，不为避重叠拆碎。Worker 的跨方向线索由 Planner 结合全局目标决定是否另派。`;

export const WORKER_AUTONOMY_GUIDANCE=`【自主探索策略】
仅当宿主当前意图标记为 direction-autonomy-v2 时应用以下策略；历史意图继续遵守原执行约定，不据此扩大范围。
只执行当前意图是指遵守探索方向。同一问题内可以发现关联入口和资产、调整方法和验证顺序，不必等待 Planner 为每一步重新派单；每次操作仍须符合用户授权、最新约束和已绑定工具权限。登记资产不等于获得访问授权。
独立业务目标、新机理或跨方向线索保存为事实并说明关联依据和未验证部分，交 Planner 决定，不自行执行该方向，不创建或领取其他意图。结束前核对过程中已出现的跨方向线索：把实际看到的入口、它与当前问题的关联依据及未验证原因写入 record_fact，不能只留在最终口头总结或因越出当前方向直接丢弃；不为完善这条线索额外访问该方向。跨方向入口的首次 GET、HEAD、打开页面或 MCP 读取都属于执行，不能先请求一次来确认归属；仅引用发现它的当前方向响应作为证据。Planner 给出的入口和方法示例是参考；用户明确步骤、禁止事项和明确工具限制必须遵守。
单次失败允许在同方向调整方法；已有充分结论、出现实质阻塞或预算耗尽时写回并结束，不要求穷尽所有手段，不在同样失败上空转。按独立结论写回，同一结论的观察合并，不限制每个意图只能写一条事实。区分已验证、未测试、推断和阻塞；正常结束不等于整个业务范围已测完。`;

/** Only recognized templates reach this transformer through the versioned migration. */
export function upgradeDirectionPrompt(role:'planner'|'worker',text:string):string{
  const guidance=role==='planner'?PLANNER_AUTONOMY_GUIDANCE:WORKER_AUTONOMY_GUIDANCE;
  if(text.includes(guidance))return text;
  if(role==='worker'){
    // Preserve the reviewed custom prompt's asset/authentication and evidence rules.
    text=text.replace(/1\. \*\*只做你领到的这一条意图\*\*。[\s\S]*?(?=3\. 待审批 pending)/,
      '1. 遵守宿主当前意图及自主探索策略；同方向继续、跨方向写回。历史意图按原约定执行，不扩大范围。\n2. 根据证据、实质阻塞和现有预算决定结束；新意图不要求穷尽所有手段。\n');
    text=text.replace(/\*\*多个观察汇总成【一条】事实\*\*[\s\S]*?(?=\*\*只写增量\*\*)/,
      '同一结论的相关观察合并保存；独立结论分别写回，不规定一意图通常只能写一条事实。');
    text=text.replace('不限制你执行当前意图时访问新发现的合法资产','不限制在当前意图同一探索方向内访问新发现且获任务授权的关联资产；跨方向入口只写回原始线索，不允许先请求一次确认')
      .replace('发现的新资产可直接继续探索','发现的同方向关联新资产仅在符合任务授权和实时约束时继续探索；跨方向入口只写回，不先访问确认');
    text=text.replace('这里只登记资产；探索结论/判断不写这里，用 record_fact。','这里只登记资产；探索结论、跨方向线索及关联依据还须用 record_fact 写入探索图。仅登记入口不等于已将线索交回 Planner。');
    text=text.replace('record_fact（探索图，传 intent_id）','record_fact（探索图，宿主自动关联当前意图，不传 intent_id）')
      .replace('report_finding（探索图，含 PoC，传 intent_id）','report_finding（探索图，含 PoC，宿主自动关联当前意图，不传 intent_id）')
      .replace('标 confidence（observed=直接看到 / inferred=据现象推断）','用 observation_type 区分 observed=直接看到、inferred=推断、negative=有证据的负面结论、unknown=未测试或未知；confidence 仅用 low/medium/high 表示置信度');
    text=text.replace('意图不是逐接口执行脚本；受阻时如实说明原因，不转向无关方向。','意图不是逐接口执行脚本；单次受阻可在同方向调整方法，实质阻塞时说明原因，不转向无关方向。');
  }
  return text+'\n\n'+guidance;
}

/** Original authorization stays fixed. Native steering can narrow remaining work
 * and acceptance criteria within the same objective, including after PI compacts or restores a session. */
export function workerMandate(id:number,payload:Record<string,unknown>,contract:IntentContract,assetsJSON:string,steering?:string):string{
  const update=steering?`\n\n【同一目标内的当前工作调整；优先于初始方法与验收中冲突的部分】\n${steering}\n以上纠偏已取代的工作或验收项不再执行；未修改的部分继续有效。原授权、禁止事项和用户约束仍然有效，纠偏不能扩大授权或替换业务目标。若要求的是另一业务目标，保存已有事实并结束，交 Planner 停止旧意图后创建新意图，不在当前会话执行新目标。` : '';
  const reuse='\n验收要求是需要回答的问题，不是每个 Worker 都要亲自重做的步骤。已有有效的共享事实可作为结论依据，注明来源；只有证据缺失、相互矛盾或条件变化且与剩余问题相关时才补充验证。其他 Worker 正在负责的问题不另起一套验证，交 Planner 协调。';
  if(payload.autonomy_policy!==DIRECTION_AUTONOMY_POLICY)return `\n\n【当前意图 #${id} 原执行约定（历史策略）】\n此意图未启用 direction-autonomy-v2，恢复时继续遵守原目标、范围、步骤及限制，不自动扩展探索范围。\n${JSON.stringify(contract)}\n\n【锚定资产索引】\n${assetsJSON}${reuse}${update}`;
  return `\n\n【当前意图 #${id}：${DIRECTION_AUTONOMY_POLICY}】\n${WORKER_AUTONOMY_GUIDANCE}\n`+
    `【探索目标】${steering?'（初始约定，仅未被下方纠偏取代的部分有效）':''}\n${JSON.stringify({summary:payload.summary,objective:contract.objective})}\n`+
    `【授权与禁止事项】\n资产索引是方向入口，不是完整授权清单。遵守宿主实时授权与操作约束；用户明确步骤优先于方法建议。\n${JSON.stringify({out_of_scope:contract.out_of_scope,allowed_tools:contract.allowed_tools??'使用当前角色已绑定且获授权的工具'})}\n`+
    `【证据依据】\n${JSON.stringify({basis:contract.basis,work:contract.work})}\n`+
    `【结果要求】${steering?'（初始约定，已被纠偏取消的项无需补做）':''}\n${JSON.stringify(contract.acceptance)}\n以证据说明结论、已测范围、未知部分和停止原因，不预设结果；Worker 结束不代表全范围测试完成。\n跨方向线索也是需要保存的观察事实：即使未访问该方向，也用 record_fact 保存“当前响应实际出现了什么入口、与当前方向有什么关联、为什么未验证”，evidence 引用已取得的原始响应。未知业务行为标记为未测试，不能当作已验证漏洞。insert_assets 仅保存资产身份，不代替这条事实；最终文字提及也不代替写回。结束前核对相关 record_fact 已返回成功编号。\n`+
    `【参考线索解释】\nPlanner 在方向说明中提到的入口或方法可用于起步，同方向允许调整。用户明确要求的步骤和限制不是参考，必须遵守。\n`+
    `【锚定资产索引】\n${assetsJSON}${reuse}${update}`;
}

/** Reuse the existing steering audit; no second message bus or tool interceptor. */
export async function latestWorkerSteering(db:Database,expID:number,intentID:number):Promise<string|undefined>{
  const row=(await db.query(`SELECT detail FROM activity WHERE exploration_id=$1 AND node_id=$2
    AND kind='status' AND tool='steer_work' AND metadata->>'event_type'='steering'
    AND metadata->'steering'->>'status' IN ('submitted','delivered') ORDER BY id DESC LIMIT 1`,[expID,intentID])).rows[0];
  return typeof row?.detail==='string'?row.detail:undefined;
}

/** A missing receipt is observable host state, not a semantic judgment on prose.
 * Used once by the existing bounded PI wrapup; never creates work itself. */
export async function plannerDispatchReminder(db:Database,taskID:number,expID:number):Promise<string|undefined>{
  const row=(await db.query(`SELECT t.status,t.paused,t.execution_mode,
    EXISTS(SELECT 1 FROM exploration_nodes WHERE exploration_id=$2 AND kind='intent') has_intent,
    EXISTS(SELECT 1 FROM exploration_nodes WHERE exploration_id=$2 AND kind='goal' AND state='open') has_open_goal
    FROM tasks t WHERE t.id=$1 AND t.exploration_id=$2 AND t.deleted_at IS NULL`,[taskID,expID])).rows[0];
  if(!row||row.status!=='running'||row.paused||row.execution_mode!=='managed'||row.has_intent||!row.has_open_goal)return;
  return '宿主回执核对：当前任务尚未创建任何意图，文字中的派单描述不会启动 Worker。若你已确定符合授权和前置条件的探索方向，请现在实际调用 add_intent 并核对回执；若确实没有可执行方向，请说明具体阻塞或等待理由后结束。不要为了这条提醒凑单、扩大范围或绕过约束。仍按方向派单，入口和方法留给 Worker。这是本轮唯一一次核对提醒，沿用剩余预算。';
}
