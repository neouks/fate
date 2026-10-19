# fate pi SDK 重构修复与验收记录

日期：2026-10-18（时间线统一为 Asia/Shanghai；JSON 保留服务器原始时区）。

本轮已修复原审查 R1–R20，完成 G1–G6 的实现与下述验证，并对真实对照中新暴露的缺陷继续修复。最终复审没有发现本清单内仍未关闭的已知 P1/P2。此结论限于本报告记录的源码、测试与运行范围，不将未执行的生产负载或破坏性实验计为通过。

## 版本与保留范围

- A 工作树基准：`dc2d7d9b7b99a176dd550c3a5eccb071ce89a4ce`，在原有未提交修改上增量修复；未清理用户数据、未提交 Git、未覆盖用户自定义角色/工具配置。
- A 最终运行版本：`pi-acceptance-20261018-final3`；使用独立数据库 `fate_acceptance_20261018`、数据目录 `/tmp/fate-acceptance-20261018/data`，后端 `127.0.0.1:18787`，录制代理 `127.0.0.1:18788`。本地生产前端 `127.0.0.1:13000`。
- B 线上实测版本：`124d263-dirty`。本地 B 在会话早期记录为 `1f68205bf3ab034056daa3c04c5a6543b8d63e68`；交付前读取为 `0aca38abd652281da81af6fd4e05ad8ccb05b263`（提交时间 2026-10-18 07:47:48）。三者不能视为同一源码快照，本轮没有修改 B 源码或全局模型默认项。
- 保留全局资产图与任务探索图分离、锚点、目标证明、资产审批、冷图压缩、一层来源任务继承。pi 1.3.0 负责模型/工具循环、会话文件和压缩；宿主负责领域事务、权限、事件、租约与资源配额。
- 数据库采用增量、幂等迁移；边分页新增稳定序号但保留原复合主键。新角色/工具只补缺；仅扩展仍保持旧内置默认值的绑定，不覆盖自定义绑定。

## R1–R20 闭环

“通过”表示对应稳定回归已通过；实际模型和线上行为另见对照时间线，不把模拟测试混称实测。

| 编号 | 级别 | 修复结果 | 实现入口 | 回归 |
|---|---|---|---|---|
| R1 | P1 | 下发统一经过准入、恢复与唤醒，返回可领取或阻塞状态。 | [engine.ts](/Users/pphua/Documents/GitHub/fate/apps/server/src/engine/engine.ts) | 通过：[R1](/Users/pphua/Documents/GitHub/fate/apps/server/migration-regression.test.ts:88) |
| R2 | P2 | 恢复重新开放意图；旧执行器仍占槽时拒绝假恢复。 | [engine.ts](/Users/pphua/Documents/GitHub/fate/apps/server/src/engine/engine.ts) | 通过：[R2](/Users/pphua/Documents/GitHub/fate/apps/server/migration-regression.test.ts:95) |
| R3 | P1 | active 仅切换当前任务；读页面、聊天不隐式启动 Worker。 | [tasks.ts](/Users/pphua/Documents/GitHub/fate/apps/server/src/http/routes/tasks.ts) | 通过：[R3](/Users/pphua/Documents/GitHub/fate/apps/server/migration-regression.test.ts:113) |
| R4 | P2 | manual 模式退出自动规划，不进入 Planner 模型循环。 | [engine.ts](/Users/pphua/Documents/GitHub/fate/apps/server/src/engine/engine.ts) | 通过：[R4](/Users/pphua/Documents/GitHub/fate/apps/server/migration-regression.test.ts:120) |
| R5 | P1 | URL/host/port 正确解析；HTTP 每跳及结构化外部工具参数校验当前意图授权。 | [custom.ts](/Users/pphua/Documents/GitHub/fate/apps/server/src/tools/custom.ts) | 通过：[R5](/Users/pphua/Documents/GitHub/fate/apps/server/migration-regression.test.ts:126) |
| R6 | P1 | 拦截规则从当前配置读取，正在运行的会话在下一次工具调用前执行新规则。 | [gate.ts](/Users/pphua/Documents/GitHub/fate/apps/server/src/intercept/gate.ts) | 通过：[R6](/Users/pphua/Documents/GitHub/fate/apps/server/migration-regression.test.ts:145) |
| R7 | P2 | 暂停、取消、删除、恢复校验 task→exploration→intent 归属。 | [engine.ts](/Users/pphua/Documents/GitHub/fate/apps/server/src/engine/engine.ts) | 通过：[R7](/Users/pphua/Documents/GitHub/fate/apps/server/migration-regression.test.ts:153) |
| R8 | P2 | 全部冷图摘要可发现、可分页展开；保留原节点、边、锚点和版本失效机制。 | [overview.ts](/Users/pphua/Documents/GitHub/fate/apps/server/src/tools/overview.ts) | 通过：[R8](/Users/pphua/Documents/GitHub/fate/apps/server/migration-regression.test.ts:158) |
| R9 | P2 | 恢复一层来源只读黑板；Agent、图页面、节点钻取共同使用来源任务授权。 | [graph_view.ts](/Users/pphua/Documents/GitHub/fate/apps/server/src/db/graph_view.ts) | 通过：[R9](/Users/pphua/Documents/GitHub/fate/apps/server/migration-regression.test.ts:169) |
| R10 | P2 | Worker 结果、终态和反馈事务提交；持久 outbox 回到原 Main 分段。 | [schema.sql](/Users/pphua/Documents/GitHub/fate/apps/server/src/db/sql/schema.sql) | 通过：[R10](/Users/pphua/Documents/GitHub/fate/apps/server/migration-regression.test.ts:207) |
| R11 | P1 | 压缩、领取、结果与反馈遵循统一探索锁及节点顺序，消除反向加锁。 | [coldgraph.ts](/Users/pphua/Documents/GitHub/fate/apps/server/src/agent/coldgraph.ts) | 通过：[R11](/Users/pphua/Documents/GitHub/fate/apps/server/migration-regression.test.ts:214) |
| R12 | P1 | 意图暂停中断真实 pi 会话，并等待执行槽释放或返回等待确认。 | [engine.ts](/Users/pphua/Documents/GitHub/fate/apps/server/src/engine/engine.ts) | 通过：[R12](/Users/pphua/Documents/GitHub/fate/apps/server/migration-regression.test.ts:226) |
| R13 | P2 | Main 下发后由宿主签发单意图 pending 授权；仍拒绝 blocked。 | [intents.ts](/Users/pphua/Documents/GitHub/fate/apps/server/src/tools/intents.ts) | 通过：[R13](/Users/pphua/Documents/GitHub/fate/apps/server/migration-regression.test.ts:285) |
| R14 | P1 | 目标证明、图、活动、证据和 finding 统一过滤已撤销授权的数据。 | [schema.sql](/Users/pphua/Documents/GitHub/fate/apps/server/src/db/sql/schema.sql) | 通过：[R14](/Users/pphua/Documents/GitHub/fate/apps/server/migration-regression.test.ts:303) |
| R15 | P2 | finding、节点、边、锚点和证据在同一事务提交；工具调用幂等键防重复。 | [findings.ts](/Users/pphua/Documents/GitHub/fate/apps/server/src/tools/findings.ts) | 通过：[R15](/Users/pphua/Documents/GitHub/fate/apps/server/migration-regression.test.ts:364) |
| R16 | P1 | 新发现资产遵循审批模板，不能把 Worker 发现直接等同用户批准。 | [assets.ts](/Users/pphua/Documents/GitHub/fate/apps/server/src/tools/assets.ts) | 通过：[R16](/Users/pphua/Documents/GitHub/fate/apps/server/migration-regression.test.ts:372) |
| R17 | P1 | 使用公共/私有后缀解析，隔离托管平台不同租户的授权。 | [assets.ts](/Users/pphua/Documents/GitHub/fate/apps/server/src/db/assets.ts) | 通过：[R17](/Users/pphua/Documents/GitHub/fate/apps/server/migration-regression.test.ts:381) |
| R18 | P2 | 删除先完成合法状态迁移，再保留取消标志，不被自身保护条件阻断。 | [engine.ts](/Users/pphua/Documents/GitHub/fate/apps/server/src/engine/engine.ts) | 通过：[R18](/Users/pphua/Documents/GitHub/fate/apps/server/migration-regression.test.ts:387) |
| R19 | P1 | Goals 同时接收 description 与独立 goal，保留用户来源和约束。 | [roles.ts](/Users/pphua/Documents/GitHub/fate/apps/server/src/agent/roles.ts) | 通过：[R19](/Users/pphua/Documents/GitHub/fate/apps/server/migration-regression.test.ts:392) |
| R20 | P2 | timeout 重启重置 deadline；暂停与准入排队冻结有效执行计时。 | [coordinator.ts](/Users/pphua/Documents/GitHub/fate/apps/server/src/engine/coordinator.ts) | 通过：[R20](/Users/pphua/Documents/GitHub/fate/apps/server/migration-regression.test.ts:398) |

## G1–G6 功能补齐

| 缺口 | 已实现 | 验证与边界 |
|---|---|---|
| G1 MCP / Skill | 管理与运行共享传输工厂；stdio、Streamable HTTP、legacy SSE；认证、局部 TLS、取消/关闭；按角色装配资源，禁用配置不被默认工具补回。 | 本地 MCP 服务验证握手、调用、认证、取消与关闭；原生 pi stdio 工具调用；TLS 宽松配置仅影响指定服务。角色资源和禁用回归通过。未逐一连接用户所有生产 MCP 服务。 |
| G2 LLM 管理 | 查询/执行共享解析链；任务链、会话覆盖、角色绑定、全局默认；候补、限流、重试、熔断和请求审计；代理、会话头、token 字段和非流式传输生效。 | 401/429/流中断以隔离夹具验证，失败切换不重放已提交工具；三种协议的非流式文本、工具参数、thinking、usage 均经原生 pi 解析。真实 DeepSeek 自动任务、工具调用与非流式 pong 通过。非流式仅在 HTTP 层将完整响应适配为 pi 原生事件，未重写 Agent 循环。 |
| G3 配置生效 | 每个 runner 保存实际配置快照；禁用/授权在下一工具边界校验，Worker 配额在下一次领取、心跳在下一 Planner 轮、模型/提示词/工具集合在下一会话边界生效。 | `/api/tasks/:id/runtime-config`、`/api/conversations/:id/runtime-config` 返回 effective/pending 和生效规则；回归验证运行快照及调用前禁用。MCP RPC 边界再次校验服务与工具可见性。 |
| G4 完整过程 | 原始参数/结果与摘要分离；活动、节点、冷图、证据有续读；超大工具 JSON 落文件并返回 `read_tool_output` 续读引用及 raw 下载。 | Unicode/转义、大数组、活动多页、跨任务隔离和授权撤销测试通过；完整序列化后响应 ≤20 KiB，不靠截断 JSON 尾部限长。pi 原生文件/MCP 长结果继续采用其原生结果引用。 |
| G5 调度可靠性 | DB FIFO 准入、全局 Worker/Retester 配额、任务/会话租约、隔离令牌、过期回收；持久暂停命令和执行器确认；触发事件去重、串行/并行、all/by_task/none 合并与并发上限。 | 两个 Engine/会话执行器竞争同一数据库，验证限额、租约过期、远程暂停、旧执行器拒写；原生会话文件恢复；首次启用不重放历史，501 条事件续页、低 ID 延迟提交和删除会话后去重通过。多实例测试为同进程内独立执行器，未做生产多主机长时间压力测试。 |
| G6 流量 / 附件 / 复测 | 固定 `http-mitm-proxy@1.1.0`；HTTP/HTTPS 录制、任务/意图归属；正文文件存储与索引、旧数据兼容、证据绑定和附件消息；独立 Retester、范围快照、结论落库与版本 CAS。 | 本地真实 HTTP/HTTPS 代理验证正文与 CA 私钥权限；真实目标 A 两个自动任务各录得一条 GET；附件失败清理及跨任务拒绝、证据 inbox 删除后续读通过。Reporter/Retester 用明确标记的本地合成 finding + 真实 DeepSeek 验证；无真实漏洞被虚构。代理只覆盖实际经过代理的流量。 |

实现集中在 `src/pi/{runner,modelResolver,providerFromProfile,nonStreaming,mcpTransport}.ts`、`src/engine/{engine,coordinator,conversations,triggers,retests,runtime-config,session-lease}.ts`、`src/evidence/`、`src/egress/recording.ts` 和相应 HTTP 路由。

## 八类 Agent 验证矩阵

| 角色 | 职责与约束 | 证据 |
|---|---|---|
| Goals | 接收用户描述、目标和约束，提取目标；不执行目标操作。 | A1/A5 真实分解；R19 输入回归；bootstrap 中暂停、恢复重新分解和启动调度回归。 |
| Planner | 读取授权黑板、产生意图并证明目标；manual 不自动规划。 | A5 完成闭环；A7 模型审计中 Planner 调用为 0。B 把 Goals 也记为 planner，比较时排除“第 0 轮目标拆解”。 |
| Main | 对话、审批、下发和控制、接收原分段反馈；没有外部执行工具。 | A7/B130 显式下发、本地等待、暂停恢复；Main 未执行 bash/HTTP；原生工具装配与分段会话隔离测试。 |
| Worker | 原子领取；按当前意图授权执行；结果及图写回。 | A5 intent18→fact20→goal16，A7 intent24→fact25；全局配额和防重复执行回归。 |
| Auto | 独立 pi 会话，通过平台工具查询、创建、控制任务。 | A conversation1 真实只读查询完成；创建/控制工具接入同一领域服务，平台会话模型审计和并发调度回归。未用真实 Auto 自动创建额外远程任务。 |
| Pentest | 独立会话；只有显式绑定任务才能写探索图。 | A conversation2 真实未绑定会话无写入；绑定后的原生 pi 写回回归，使用 consumed hint 保存会话来源，不创建可领取意图。 |
| Reporter | 仅成功提交 finding 触发；读取授权证据，按证据版本写报告。 | 本地 fixture task4/finding1，trigger finding:14→conversation3，真实 DeepSeek 3 次调用，报告 1564 字符；重复/延迟提交事件回归。 |
| Retester | 独立定向复测，保存明确结论；fixed 使用原 triage 版本条件更新。 | retest1/conversation4，真实结论 inconclusive，原 finding 保持 pending；fixed、重复完成、人为修改保护、重定向范围、远程停止回归。 |

## 双端对照时间线

目标仅为 `http://144.123.22.234:9080/`，未登录、未扫描、未访问其他端口。自动任务只要求一次根路径 GET；手动/关联任务禁止目标网络请求。专用 DeepSeek profile：A=1、B=16；未修改 B 全局默认配置。管理平台凭据未用于目标登录。

第一轮保留：自动 A1/B125、手动 A2/B126、关联 A3/B127。自动两端完成；手动中断恢复并回传；关联无新意图。第一轮自动创建时间差记录为 173 ms。

| 最终对照 | A | B | 观察结果 |
|---|---|---|---|
| 自动 `PI-20261018-AUTO-FINAL` | task5，08:34:56.655 创建；intent18 08:35:24.050；取得资源 08:35:24.166；fact20 08:35:38.330；08:35:51.375 done | task128，08:34:57 创建；intent14350 08:35:21；最迟 08:35:27 已进入 Worker 工具；fact14352 08:35:36；done | A 领取延迟约 116 ms；B 由首个 Worker 事件推得领取上界约 6 s，均在 15 s 内。A 16 次成功模型请求，B 14 条 usage 记录。两端各 4 节点/4 边，目标均由事实证明。 |
| 手动 `PI-20261018-MANUAL-FINAL-RETRY` | task7，08:38:47.824 创建；intent24 08:38:52.274；取得资源 08:38:53.100；08:38:55.161 sleep；暂停确认 236 ms；恢复后 fact25，08:39:35.618 原 Main seg0 收到结果 | task130，08:38:49 创建；intent14358 08:38:54；08:38:58 sleep；暂停确认 118 ms；恢复后 fact14359，08:39:31 原 Main 收到结果 | A 领取约 826 ms；B 领取上界约 4 s。暂停确实中断执行；9 次成功模型请求及 1 次主动暂停导致的 aborted（A），B 8 条 usage。两端只有一条意图，最后保留暂停状态。 |
| 关联 `PI-20261018-LINKED-FINAL` | task8 引用 task5；只读 fact20、intent18 过程及锚点 | task131 引用 task128；只读 fact14352、intent14350 过程及锚点 | 两端新任务意图数量为 0，没有重复执行来源。A 最终图接口与页面显示 4 个只读来源节点，当前任务队列仍为空。两端最后暂停。 |

自动创建服务器时间差约 345 ms；手动约 1176 ms；B 时间戳只有秒精度，不能用这些数值作毫秒级性能比较。关联最终补测的创建时间差约 37.934 s：B 要求 `source_task_ids` 为字符串数组，首次数字数组收到 400 后按契约补建；保留该偏差，不冒称同时创建。

`PI-20261018-MANUAL-FINAL` A6/B129 不计为有效配对：B 切换手动模式时连接中断，在 managed 状态产生过 Planner 工作。核对现有任务后暂停，重新创建 A7/B130；未重复提交不确定的创建请求，未操作其他 B 任务。

A5 与关联测试初期曾出现 `node_detail: column "id" does not exist`；已补迁移与稳定游标。`final2` 真模型重测成功：fact20 返回 `inherited=true`、source_task_id=5、2 条边、3 个锚点。`final3` 又验证前端图投影、节点分页与只读来源徽标。原错误留在历史记录中，未删除证据，也未用模型换工具后的成功掩盖缺陷。

A 已记录的目标请求：task1 与 task5 各一条 GET，HTTP200，响应正文各 5795 字节，无重定向。证据 ID 分别为 `e6c23baf-c883-4daa-81a3-6a3e97de14e6`、`67ee459c-8bfc-41a1-80a7-965d0ed6f752`。本轮没有目标漏洞结论。

B 两次自动测试均出现 `traffic_search: disk I/O error (522)`，随后通过一次 curl GET 得到 HTTP200/页面标题。B 的流量录制完整性因此未通过验证；只把其命令结果、事实节点和证明边作为可用证据，不能把该环境故障归因于 A，也不能据此声称 B 流量全部留存。

## 最终复审新增问题及修复

| 问题 | 修复 / 验证 |
|---|---|
| 上传文件名 `.`/`..` 可使失败清理落到上层目录，存在误删风险 | 文件名净化、目录由服务器 UUID 决定；blob 用临时文件原子发布和同 hash 锁；事务失败只清理未引用文件。注入失败后原目录哨兵文件保留、无孤儿 blob。 |
| Goals 启动中暂停后恢复缺少新调度循环 | 等待旧 bootstrap 退出；保留 bootstrap 状态并释放租约；恢复重新创建带令牌的分解与调度器。 |
| 触发器 interval 判断、SQL 参数类型及分页边界错误 | 修正过滤与显式类型；超过 500 条事件可续读；保留已投递 tombstone，按来源去重防止较低 ID 延迟提交丢失；by_task 覆盖所有分组。 |
| 远程暂停/复测停止过早返回成功 | 持久命令、stop_requested 和租约确认；超出等待窗口返回 waiting_for_executor/stopping，旧执行器被隔离。 |
| 原始结果截断/活动游标跳页 | 保存完整工具结果和可读引用；活动按正向游标最早页返回；SSE 序列化增量读取。 |
| 非流式、token 参数及连接测试未完全反映运行配置 | 请求实际发送 stream:false；只保留选定 token 字段；连接测试包含 proxy/streaming/session header。真实非流式 DeepSeek 返回 pong（1106 ms）。 |
| 暂停详情仍显示 running；coverage=false 被读成 true | DTO 区分等待执行器确认和已暂停；修复 SQL 列别名；列表/详情一致性回归，最终运行实测 paused/false。 |
| node_detail 边游标列缺失，前端来源图投影缺失 | 增量边序号、跨页测试；统一一层来源图投影，拒绝跨任务修改，来源撤权后立即隐藏。真模型及浏览器重测通过。 |

## 自动化、构建与界面验证

服务端完整测试：**219 通过、1 跳过，22 个测试文件通过**；其中迁移专项 **51 通过**。最终完整运行耗时 75.22 秒。后端 TypeScript 构建通过，`git diff --check` 通过。

- 模拟测试使用原生 pi faux provider、本地 HTTP/MCP 服务和独立 PostgreSQL 测试库；真实 DeepSeek 集成与线上 B 对照在本报告单列，不与模拟次数合并。
- Frontend `tsc --noEmit`、Next 生产构建通过；后续改动仅在后端。生产构建实际启动后检查任务列表/详情、聊天、资产、LLM、MCP、Skill、finding/复测过程、探索链路、审批、覆盖图和关联图。
- 浏览器检查未发现 pageerror 或失败 API；截图与响应摘要保存在证据目录。使用本机 Playwright 子进程从本机文件读取会话，未把 JWT 传入远程浏览器连接器。
- 不将单次定向测试中被筛掉的用例计为通过，也不把唯一 skipped 的真实模型列表测试计为通过。

## 验收边界与复核入口

1. 本轮修复和验收都在 A 隔离实例完成；没有替换用户生产服务或迁移生产数据库。现有任务、审批、会话和证据的增量兼容在隔离数据库重复启动迁移中验证；未复制整库生产数据做迁移演练。
2. B 流量库 `522` 是明确未验证项；B 线上 dirty 版本与本地两个已观察提交不同，不把文本、意图数量及计数差异直接视为 A 回归。
3. 多实例并发、租约失效、重复消费、故障注入与冷图大样本以本地夹具验证；未做真实多主机网络分区、长时间生产压测或目标破坏性复测。
4. 代理录制与授权校验不等同 OS 网络沙箱。绕开代理的任意本地程序流量不在录制覆盖承诺内。本次可见工具轨迹与 A 证据中未发现越界目标请求，不能由此证明机器上所有网络流量均受代理约束。
5. task4/finding1 是“LOCAL FIXTURE — 非真实漏洞”。Reporter/Retester 的真实模型调用只证明领域流程；inconclusive 被原样保存，没有声称目标漏洞存在或已修复。
6. 正常验收任务和失败对照记录均保留。A1/A5 和 B125/B128 为 done，其余本次测试任务已暂停；独立会话已结束。凭据不写入源码、测试夹具或报告。

证据入口：[A 数据库/模型/双图/反馈证据](/Users/pphua/Documents/GitHub/fate/docs/reviews/evidence/acceptance-20261018/a-runtime-evidence.json)；[最终配对事件与 API 快照](/Users/pphua/Documents/GitHub/fate/docs/reviews/evidence/acceptance-20261018/final-paired-observations.json)；[首轮配对记录](/Users/pphua/Documents/GitHub/fate/docs/reviews/evidence/acceptance-20261018/initial-paired-observations.json)；[Reporter/Retester 本地夹具](/Users/pphua/Documents/GitHub/fate/docs/reviews/evidence/acceptance-20261018/local-role-observations.json)；[关联图 UI 验证](/Users/pphua/Documents/GitHub/fate/docs/reviews/evidence/acceptance-20261018/ui-linked-observations.json)；[测试与构建摘要](/Users/pphua/Documents/GitHub/fate/docs/reviews/evidence/acceptance-20261018/validation-summary.json)；[交付源码哈希](/Users/pphua/Documents/GitHub/fate/docs/reviews/evidence/acceptance-20261018/source-manifest.json)。
