# Worker 最终发布与 Planner 唤醒边界复审

## 对照 ARTEX 得到的结论

本地 B 项目提交为 `c6b6121af329dc7b214a8dc0aabef01efb448194`。本次直接阅读 Planner、Worker、调度器、工具和探索图源码，没有将线上 B 的版本视为同一个版本。

- [README 双图说明](/Users/pphua/Documents/GitHub/ARTEX/README.md:336)：资产图保存全局资产；探索图保存每任务的目标、意图、事实、漏洞和血缘；两图通过锚点关联。
- [Worker 角色](/Users/pphua/Documents/GitHub/ARTEX/agent/worker.go:279)：一个 Worker 执行一条意图，通常将同方向观察汇总为一条事实，summary 简述、detail 承载细节，然后结束。
- [Worker 结束调度](/Users/pphua/Documents/GitHub/ARTEX/server/engine.go:1325)：完成状态保存后 `NotifyDone(intent.ID)` 唤醒 Planner。
- [Planner 增量读取](/Users/pphua/Documents/GitHub/ARTEX/agent/planner.go:165)：读取完成意图、结果和事实 ID，再按引用查询完整信息；待办跨轮保存。

同时，本地 B 仍包含两条与本次要求不同的旧路径：[Worker 提示词](/Users/pphua/Documents/GitHub/ARTEX/agent/worker.go:287)要求边发现边写回，[NotifyFinding](/Users/pphua/Documents/GitHub/ARTEX/server/manager.go:1998)会在 Worker 结束前唤醒 Planner。本次按用户最新要求关闭这种阶段协同，保留双图、锚点、单意图执行与结果血缘设计。

## 本次修复

1. **关闭资产登记造成的间接唤醒。** 原先 Worker 发现新资产时，资产关联和审批模板落库会触发 `control_changed`，有空位时可能提前启动 Planner。现在识别宿主事务中的 Worker 发现来源，保存资产及实时授权，但不将发现动作当成人工控制事件。真正的人工批准、封禁、撤销及约束修改仍正常生效。
2. **Worker 报洞不发送中途规划通知。** 即便走兼容工具路径或重复返回已存在的记录，也不调用 `notifyFinding`。普通自动规划仍由 Worker 最终结束事件驱动。
3. **只发布最终选择的结论。** `complete_intent.publish_ids` 指定最终事实和漏洞，必须包含全部验收引用；省略时仅发布 `criteria.fact_ids`。其他阶段草稿保持私有，不能被 Planner、Reporter 或其他 Worker 当作共享结论读取。
4. **最终稿可以修订。** `record_fact` 和 `report_finding` 增加 `replace_node_id`，只能修订本意图尚未发布的同类草稿。保持节点引用不变，保存私有历史版本，`context_get` 检查草稿版本；已经发布或属于其他意图的记录不能覆盖。
5. **修复同批工具并行竞争。** 用原生 pi 复现了“延迟修订事实，同时完成意图，结果发布旧稿”的问题。领域写工具现在声明 SDK 原生 `executionMode: sequential`，包含这些工具的批次按顺序执行；完成后的工具调用被宿主拦截。只读工具仍可并行，不重写 pi 的循环。
6. **结束记录仅引用本次最终清单。** 已验收结果的停止记录不再把同一意图历史上所有已发布观察混为本次最终产出。

Worker 宿主约定升级为 `blackboard-v1.1`：运行中保存私有恢复记录；结束前复核最新证据，合并同方向观察，选择最终事实／漏洞发布后停止。自定义正文不覆盖，候选保存在 [worker-prompt-candidate.json](evidence/worker-final-publication-20261019/worker-prompt-candidate.json)。

正常流程为：

**读取已发布图 → 按空位派单 → 执行当前意图并保存私有记录 → 复核最新结论 → 原子最终发布 → 退出释放名额 → Planner 读取新图继续规划。**

检查点、草稿修订和 Worker 新资产登记均不启动普通规划。资产登记仍及时支持审批和出口校验，不需要等待 Worker 结束才建立授权记录。

异常退出保留既有事实、私有历史及真实原因，未完成的观察明确标为未验收；模型连接失败或强杀时不能声称模型已复核出最终结论，更不能凭空制造发现。恢复和预算收尾继续使用原有持久化与验收机制。

## 回归证据

- 空位测试：上限 3、只有 1 个 Worker 运行；保存检查点、事实草稿、漏洞草稿、新资产后，跨过正常调度轮询周期，Planner 请求数仍为 1。最终提交并退出后才进入第 2 轮，任务自然结束。
- 最新稿测试：修订后引用不变、旧版本读取报冲突、重复修订不增加历史；最终图只包含选中的最新结论，未选中的阶段稿保持私有。
- 漏洞测试：专业漏洞记录、探索节点及证据均使用最终修订内容；提交前漏洞表无对应记录。
- 顺序竞争测试：修复前稳定发布旧内容，修复后发布最新内容；同批提交之后的模拟目标操作次数为 0，额外模型请求为 0。见 [修复前复现](evidence/worker-final-publication-20261019/race-before.txt)及[专项回归](evidence/worker-final-publication-20261019/focus-after.txt)。
- 人工授权测试：静默资产登记后，人工封禁仍生成控制事件，不因抑制阶段规划而忽略授权变更。

专项回归 56 项通过；恢复与工具兼容专项 11 项通过。完整回归和发布状态见 [validation.json](evidence/worker-final-publication-20261019/validation.json)。本轮没有新增真实 DeepSeek 请求，外部目标请求为 0；不将确定性模型测试标记为真实供应商复验。

最终完整回归：**376 通过、1 跳过、0 失败（34 个文件）**；服务端类型检查与构建通过。唯一跳过项为隔离环境无真实凭据的 DeepSeek 模型列表测试。

已在确认无活动任务、会话、复测及有效执行租约后正常重启服务，版本为 `blackboard-final-20261019`。健康、任务详情、总览统计、Worker 队列接口均返回 200；并发仍为 **2**，8 份既有提示词的 ID 和哈希均未改变。详见 [发布核对](evidence/worker-final-publication-20261019/deploy-after.json)。本轮没有修改前端源码。
