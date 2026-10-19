# 服务重启与运行链路复验（2026-10-18）

最新后端已加载，真实 HTTP 入口、本地确定性模型、原生 pi 会话、调度器及 PostgreSQL 组成的运行链路通过复验。最终验收任务为 **16（自动）和 17（手动）**，目标网络请求为零。本结论验证宿主运行协议，不替代真实 DeepSeek 的规划质量或外部目标探测验证。

## 服务与版本

- 后端：`127.0.0.1:18787`；代理：`127.0.0.1:18788`。
- 旧进程 `95018` 已通过 SIGTERM 退出；新进程 `48549` 于北京时间 **14:03:58** 启动。
- 健康检查：`ok`，版本标记 `pi-domain-v1-recheck-20261018`，Node `25.1.0`，pi 保持 `1.3.0`。
- 数据库沿用隔离验收库 `fate_acceptance_20261018`，数据目录 `/tmp/fate-acceptance-20261018/data`。
- 重启前 5 个历史 running 任务均为 paused，没有活动执行租约；没有恢复它们、修改全局模型或操作线上 B。
- 先完成后端构建再重启；重启后的生产源码没有新增变更。本轮新增验收脚本，修复了一处测试配置隔离问题。

## 最终 HTTP 验收

执行时间：北京时间 **14:13:37–14:13:43**。所有领域写入都由真实任务接口与 Agent 内部工具完成；仅初始合成资产通过数据库资产接口准备。

| 检查 | 自动任务 16 | 手动任务 17 |
| --- | --- | --- |
| 下发来源 | Goals 保存目标，Planner 下发两轮意图 | Main 对话下发一个意图 |
| Worker 首次领取 | 意图 66：78 ms；意图 68：82 ms | 意图 72：82 ms |
| 进度与事实 | 两个检查点、事实 67 和 69 | 检查点、事实 73 |
| 完成验收 | 两个意图 complete/done，目标 65 met，任务 done | 意图 complete/done，任务保留暂停状态 |
| Planner 调度 | dispatched → dispatched → exhausted | Planner 模型调用为 0 |
| 双图 | 5 个锚点、6 条探索边，关联资产已测 | 3 个锚点、3 条探索边，关联资产已测 |
| pi 领域压缩 | 每个 Worker 两次，共 4 次 | 连续 2 次，暂停后恢复原会话 |

自动任务的因果链是 `意图 66 → 事实 67 → 意图 68 → 事实 69 → 目标 65`。第二轮意图的 parent 和 basis 均指向第一轮事实，两个意图使用不同阶段身份；没有重复派单。每个意图仅产生一个 yields 事实，资产图与探索图通过锚点关联。

手动任务在事实已写入且第二次压缩完成后，模型响应尚未返回时发起暂停，**213 ms** 内确认停止。恢复后重新领取同一意图，模型请求中仍有事实引用；`context_get` 成功取回详情，再提交 `complete_intent`。已提交事实没有重复产生。此处的再次领取是明确暂停恢复产生的合法续跑，不是同时重复领取。

暂停及完成各产生一条持久反馈，均发布到原 Main 会话段。随后连续两次 Main 对话都读取了反馈；会话内每个 `worker-feedback:<activity_id>` 仅存在一次，没有重复注入。手动目标保持 open 是预期行为：此次只验收指定意图，未要求 Main 证明整个任务目标。

## 压缩与运行边界

- 通过本地合成长消息触发 pi 的真实自动压缩；没有新增宿主摘要循环或手工截断消息。
- 3 个 Worker 会话文件各持久化 2 条 `domain-v1` 压缩记录。检查点保留当前意图、归属、进度、事实引用及版本；第二次摘要包含本意图已提交事实。
- 最终共 **42 次本地模型请求**，包含 **6 次压缩请求**；审计为 41 completed、1 aborted。aborted 是主动暂停时取消的请求，未提交工具结果。
- 本地夹具的 usage 是合成计数，仅用于压缩和审计协议验证，不是供应商 token 或成本数据。
- 最终任务工具错误 **0**；未发现重复事实、孤立写入、漏发反馈或遗留执行槽位。
- 实际工具声明验证：Main、Planner、Goals 没有 bash/write/edit 或 MCP 执行工具；Worker 没有 add_intent。

## 回归与本轮修正

服务端完整回归：**28 个文件通过，312 项通过、1 项跳过**，耗时 97.97 秒。后端类型检查与构建通过。跳过项仍为通用测试库未配置真实模型的 DeepSeek models 测试，不计入通过。

完整回归覆盖原生压缩、连续压缩和恢复、失败取消、模型计量，以及调度、双图、锚点、冷图和来源任务等已有回归。冷图压缩采用测试库验证；最终 HTTP 任务规模较小，未声称触发大规模冷图压缩。

初次专项回归出现单 Worker FIFO 用例超时。原因是测试库持久化 `workers=2` 覆盖了 EngineConfig 的 `workers=1`，两个执行器争用单队列模拟响应。现在用例显式设置单 Worker，并在 finally 停止自身引擎、恢复原设置，同时断言领取者只有一个。保留 15 秒验收上限，没有通过增加超时掩盖问题。修正后定向 6 项和上述完整回归通过。

验收脚本准备阶段还修正了两点：只伪造 usage 不足以覆盖 pi 的真实会话大小估算，因此改用实际合成长消息；`context_get` 参数改为真实 Schema 的 `ref`。早期任务 9–15 作为调试记录保留，其中有工具调用不符合 Schema 的记录，不计入最终通过结果。最终任务 16–17 额外断言工具错误为零。

## 验证范围与留存

上述 HTTP 验收阶段没有追加真实 DeepSeek 请求。随后用户授权最多追加 8 次，已在另一个隔离数据库完成下述真实模型补验；管理服务的配置 1 没有新增调用。真实模型的复杂规划质量、真实外部目标及线上 B 对照仍不计为本轮已通过项目。

验收模型仅监听回环地址，任务使用独立模型绑定且排除全局候补池。夹具服务已关闭；这些 LOCAL 配置仅供复核，继续运行其任务需要重新启动夹具。自动任务已完成，手动任务已暂停，历史任务状态保持不变。会话原文仍保存在原数据目录的 `sessions/` 下。

- 可复用验收脚本：[`runtime-chain-probe.mts`](../../apps/server/scripts/runtime-chain-probe.mts)
- HTTP 测试、时间线、图、审计与压缩记录：[`http-chain.json`](evidence/runtime-chain-recheck-20261018/http-chain.json)
- 独立复核、反馈、运行配置和历史任务状态：[`postcheck.json`](evidence/runtime-chain-recheck-20261018/postcheck.json)
- 源码和构建哈希：[`manifest.json`](evidence/runtime-chain-recheck-20261018/manifest.json)
- 完整测试日志：[`server-tests.txt`](evidence/runtime-chain-recheck-20261018/server-tests.txt)
- 类型检查与构建：[`server-typecheck.txt`](evidence/runtime-chain-recheck-20261018/server-typecheck.txt)、[`server-build.txt`](evidence/runtime-chain-recheck-20261018/server-build.txt)

## 追加 8 次 DeepSeek 实测

用户随后明确追加最多 8 次请求。实际使用 **8/8**，累计 **72 次**；8 个物理 HTTP 请求均返回 200、使用真实 SSE 流式响应。出口对 HTTPS 主机与请求次数做硬限制，没有通过重试增加额度，目标请求为 **0**。

使用数据库 `fate_live_chain_52071` 的任务 **1**，与管理服务的任务编号分开。复制当前 Main、Worker、Planner 的实际提示词（本次均为 `lightweight-v1`），仅在该隔离库关闭外部执行工具。通过实际 Engine 和 pi 运行 Main 与 Worker；没有修改已运行服务的模型、提示词或绑定。

| 环节 | 真实请求数 | 已验证结果 |
| --- | --- | --- |
| Main | 2 | 调用 add_intent，创建意图 3 并交由宿主下发；不执行目标操作 |
| Worker | 4 | 226 ms 内领取；提交检查点、合成事实 4 和 complete_intent；意图 done |
| 压缩 | 1 | 显式调用原生 compact，持久化领域摘要；关闭并重建会话后，done 状态、完成结果与 node:4 引用保留 |
| Planner | 1 | 同一响应提交 record_plan_decision 和 prove_goal；目标 2 met，决策 exhausted，意图数量保持 1 |

Worker 没有扩大意图范围；事实明确标注 `SYNTHETIC sample=ALPHA, check=PASS`，不代表真实目标漏洞。原始资产、意图与事实形成 3 个资产锚点，意图通过 yields 边连接事实。手动阶段 Planner 模型调用为 0。

8 条调用审计均 completed，工具错误为 0。供应商实际 usage：未缓存输入 **9,094**、缓存读取 **12,544**、输出 **2,308**，合计 **23,946 tokens**；这些数据与前述本地夹具的合成 usage 分开记录。

**预算边界：**Worker 比预估多用一轮进度更新，前七次请求完成了 Main、Worker 与压缩恢复。初始脚本因此未满足“为 Planner 保留两次请求”的测试编排断言，保留了原始失败标记；这不是模型连接或领域工具失败。剩余第八次改为 Planner 原生单轮验收，两个工具均提交成功，随后按预算停止（stopReason=budget）。没有验证 Planner 随后的自然语言收尾，或真实模型驱动 Engine 自动将整个任务置 done；不将这些计入通过。此前自动任务 16 的确定性端到端收官结果保持有效。

该实测没有覆盖 Goals、其他角色、自动压缩阈值、复杂多轮规划或真实目标。真实压缩验证为显式 compact，自动阈值与连续压缩仍由前述运行任务和回归覆盖。隔离任务最后已暂停，活动任务租约为 0；数据库内临时模型凭据已清空。现场管理服务仍健康运行。

- 汇总与范围：[`deepseek-result.json`](evidence/runtime-chain-recheck-20261018/deepseek-result.json)
- 前 7 次原始记录：[`deepseek-supplement.json`](evidence/runtime-chain-recheck-20261018/deepseek-supplement.json)
- 第 8 次 Planner 记录：[`deepseek-planner-tail.json`](evidence/runtime-chain-recheck-20261018/deepseek-planner-tail.json)
- 脚本：[`deepseek-chain-probe.mts`](../../apps/server/scripts/deepseek-chain-probe.mts)、[`deepseek-planner-tail.mts`](../../apps/server/scripts/deepseek-planner-tail.mts)
