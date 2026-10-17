# fate / ARTEX 重构代码审查

审查日期：2026-10-17。结论：**当前实现尚不能按“B 项目核心能力完整迁移到 TypeScript + pi”验收。** 双图、角色装配、pi 会话等基础结构存在，但调度入口、审批规则、图读取和结果回传之间存在断点。用户描述的“下发后无人领取”有多个独立原因，不能靠调整提示词解决。

本轮是代码审查，没有修复或修改业务代码。基准为 A 当前工作区（包含已有未提交修改，HEAD a8df1e58）、B 的 a0cc44e，以及用户提供的 [ARTEX 技术介绍](</Users/pphua/Downloads/ARTEX：AI 自主渗透测试系统项目介绍.html>)。可追溯版本见 [源码快照](/Users/pphua/Documents/GitHub/fate/docs/reviews/evidence/source-snapshot.txt)。下文 R 编号对应复现测试编号，不代表严重程度；按风险分组排列。P1 表示应优先修复，P2 表示明确存在但可以随后修复。

本次覆盖任务创建与控制、Planner/Worker/Main/Goals 角色、pi 装配、资产授权、双图/锚点/冷图、关联任务、活动流、MCP/Skill/LLM/工具管理及相关前端 API 契约。用独立 PostgreSQL 数据库、pi faux provider、Fastify 注入请求和模拟 fetch 复现了 **20 个缺陷**。20 个断言均表达应有行为，当前全部失败；不是已有默认测试套件突然出现 20 个失败。没有调用真实模型或扫描真实目标，也没有完成所有浏览器页面及远程 MCP 的端到端验收。

[复现源代码](/Users/pphua/Documents/GitHub/fate/docs/reviews/evidence/pi-migration-regressions.test.ts.txt) · [精简运行记录](/Users/pphua/Documents/GitHub/fate/docs/reviews/evidence/pi-migration-regressions-results.txt)

**一、资产审批与任务边界**

**[P1] R16：Worker 新发现资产被直接标成已批准，绕过 explicit_targets 模板。**

[tools/assets.ts:61](/Users/pphua/Documents/GitHub/fate/apps/server/src/tools/assets.ts:61) 直接使用普通 AssetStore upsert，没有设置事务内的 agent_discovery、origin_task、asset_origin，也没有登记所属意图。数据库 [schema.sql:899](/Users/pphua/Documents/GitHub/fate/apps/server/src/db/sql/schema.sql:899) 依靠这些标记区分 Agent 发现与系统关联；缺少标记时写入 source=system、approval_state=approved。

复现：显式目标审批模板下，让真实 insert_assets 工具登记一个新根域，得到 approved/system，而不是 pending/agent。新目标因此可能进入自动执行范围，同时丢失发现来源。B 的 [RegisterAgentAssetWithOrigin](/Users/pphua/Documents/GitHub/ARTEX/db/asset_templates.go:80) 将发现、来源和模板授权放在同一事务。应恢复这一领域操作，普通 upsert 不应承担发现授权语义。

**[P1] R5：HTTP 自定义工具的域名检查实际检查了协议名，已封禁目标仍会访问。**

[tools/custom.ts:40](/Users/pphua/Documents/GitHub/fate/apps/server/src/tools/custom.ts:40) 把完整 URL 传给 validateWorkerHosts；[normalizeAgentHost](/Users/pphua/Documents/GitHub/fate/apps/server/src/db/task_scope.ts:142) 又拼接 http://，使 https://blocked.review.test/ 被解析成主机 https。该未知主机走 pending 规则后被 Worker 放行，随后 fetch 仍访问原地址。

复现：裸域名检查明确拒绝，执行同一域名的 HTTPS 自定义工具却调用了模拟 fetch。逐跳重定向也复用相同错误。应采用 URL 专用解析，将真实 hostname 交给统一授权服务，并覆盖首跳及每次跳转。

**[P1] R17：根域近似算法把不同托管租户当成同一授权范围。**

[task_scope.ts:97](/Users/pphua/Documents/GitHub/fate/apps/server/src/db/task_scope.ts:97) 用有限后缀表和最后两段近似 eTLD+1。related_assets 模板据此生成根域授权，而资产入库采用另一套 tldts 逻辑，两者不一致。

复现：只批准 alice.github.io，validateTaskHostsApproved 却允许 unrelated.github.io。B 的 [RootDomain](/Users/pphua/Documents/GitHub/ARTEX/db/nkey.go:27) 使用 Public Suffix List。应统一资产自然键与授权使用的域名解析，包含私有后缀，不能从一个托管租户扩展到整个托管平台。

**[P1] R6：管理页更新拦截规则后，Worker 继续使用旧规则缓存。**

[intercept/gate.ts:12](/Users/pphua/Documents/GitHub/fate/apps/server/src/intercept/gate.ts:12) 为 Worker 私建 Interceptor；[http/app.ts:64](/Users/pphua/Documents/GitHub/fate/apps/server/src/http/app.ts:64) 又为路由创建另一个。规则 CRUD 只调用 [app.interceptor.invalidate](/Users/pphua/Documents/GitHub/fate/apps/server/src/http/routes/intercept.ts:158)，没有失效 Worker 实例，缓存也没有自动版本刷新。

复现：预热无规则的 Worker gate，调用真实 API 新增 deny 规则，再次调用 gate 仍返回放行。新增拒绝规则和启用拦截可能无法生效。应共享实例或基于规则版本统一失效，多进程情况下也必须同步。

**[P1] R14：已封禁资产的证据仍可证明目标，导致错误收官。**

[findings.ts:155](/Users/pphua/Documents/GitHub/fate/apps/server/src/tools/findings.ts:155) 只检查证据属于本探索且种类是 fact/finding，随后直接连 proves 并置 met，没有检查锚点及其沿袭链的授权。B 在 [prove_goal](/Users/pphua/Documents/GitHub/ARTEX/agent/tools.go:1719) 调用 nodeAuthorized。

复现：把 fact 锚定的资产封禁后，prove_goal 仍将目标从 open 改成 met。最后一个目标被这样证明时，Engine 可以完成任务并取消其他执行。应使用与图读取相同的授权投影，并在事务内复核。

**[P2] R7：任务 A 的取消接口能够修改任务 B 的意图。**

[compat.ts:719](/Users/pphua/Documents/GitHub/fate/apps/server/src/http/routes/compat.ts:719) 写 cancelled_by_user 时只限制节点 ID，没有限制 exploration_id。前一步 scoped setIntentState 不命中也没有报错。相同问题还存在于 [约束修改/删除](/Users/pphua/Documents/GitHub/fate/apps/server/src/http/routes/compat.ts:636)：SQL 只限制约束 ID。

复现：将 B 的意图 ID 放入 A 的取消请求，B 意图被标记取消。这里是任务隔离和数据完整性问题，不能解释为未登录访问漏洞。所有操作都应先校验归属，用同一带任务范围的事务更新，未命中返回明确错误。

**二、任务下发、暂停、恢复与目标**

**[P1] R1：前端下发接口返回 dispatched，却不启动或恢复调度器。**

[compat.ts:745](/Users/pphua/Documents/GitHub/fate/apps/server/src/http/routes/compat.ts:745) 只写 dispatch_requested，再调用 notify；暂停任务不会恢复，服务重启后尚未载入的任务也不会创建运行循环。它没有复用 main 工具的引擎准入逻辑；不存在或不可下发的 ID 也会统一返回 dispatched。

复现：paused 任务调用该接口成功后，数据库仍 paused=true。这正是“下发了但无人领取”的直接来源之一。前端 [api.ts:330](/Users/pphua/Documents/GitHub/fate/web/src/lib/api.ts:330) 使用此入口。应统一 HTTP 和领域工具的 dispatch 操作，把任务准入、意图更新、唤醒及真实结果放在一条链路中。

**[P2] R2：意图暂停后的 UI 恢复接口是假成功。**

[compat.ts:711](/Users/pphua/Documents/GitHub/fate/apps/server/src/http/routes/compat.ts:711) 调用 reopenIntent，但 [exploration.ts:453](/Users/pphua/Documents/GitHub/fate/apps/server/src/db/exploration.ts:453) 只接受 blocked/exhausted/stopped，不接受 paused。路由忽略返回值，仍声明 status=open。

复现：paused 意图调用 control/resume 后仍是 paused。另一个直接 resume API 使用不同实现，说明控制面已经分叉。应明确 paused→open 的受控转换，并以实际提交结果生成响应。

**[P1] R12：直接暂停意图 API 不会中断正在执行的 pi 会话。**

[tasks.ts:216](/Users/pphua/Documents/GitHub/fate/apps/server/src/http/routes/tasks.ts:216) 只把数据库 running 改成 paused，代码还保留“仅 DB 状态机”的 TODO，没有 abort 当前 Worker。复现时模型已进入运行，接口返回 200，但 AbortSignal.aborted 仍是 false。

这会使 UI/调用方认为任务暂停，实际工具循环继续。当前前端使用的 control/pause 路由有 killWork，不应把本条描述成所有暂停按钮均失效；缺陷是两个正式 API 行为不一致。应统一意图暂停实现并等待执行器确认中止。

**[P1] R3：重启后调用 active 选择接口会启动已暂停任务。**

[tasks.ts:202](/Users/pphua/Documents/GitHub/fate/apps/server/src/http/routes/tasks.ts:202) 只排除终态和 queued，没有检查 paused；[engine.ts:160](/Users/pphua/Documents/GitHub/fate/apps/server/src/engine/engine.ts:160) 又无条件把运行时 paused 设为 false。

复现：新 Engine 加载 paused 任务，调用 POST /api/active 后产生一次模型执行。数据库暂停标志与实际运行状态分离。当前前端代码里只找到 setActive 定义，未发现调用点，因此本条限定为该 API 或旧客户端触发。选择任务应只改变展示状态，执行必须经过显式准入。

**[P2] R4：manual 模式仍会进入 Planner 模型循环。**

[engine.ts:268](/Users/pphua/Documents/GitHub/fate/apps/server/src/engine/engine.ts:268) 没有读取 execution_mode。仅禁止 Planner 的 add_intent 写入不足以实现手动模式，Planner 仍会消耗模型调用，并拥有证明目标、终止意图等能力。B 的 [planner.go:365](/Users/pphua/Documents/GitHub/ARTEX/agent/planner.go:365) 在手动模式下提前返回。

复现：manual 任务只有未下发意图，仍发生 Planner 模型调用。应在每轮进入模型前读取模式并检查切换版本，保留必要的宿主状态维护；不能只在一个写工具里拦截。

**[P2] R13：Main 显式下发待审批资产意图时，缺少领取条件要求的授权。**

[engine.ts:657](/Users/pphua/Documents/GitHub/fate/apps/server/src/engine/engine.ts:657) 只写 dispatch_requested；但 Worker 领取 SQL 要求 pending_asset_execution.issuer=mainagent 才允许对应待审批资产。A 中没有生成该字段的运行链路。B 的 [GrantMainIntentDispatch](/Users/pphua/Documents/GitHub/ARTEX/db/main_execution.go:37) 在准入后原子写入授权，且仍拒绝封禁资产。

复现：pending 资产意图通过真正的 main dispatch_intents 工具下发，最后 hasOpenIntent 仍为 false。若保留 B 的“显式下发可授予本次执行权”语义，应恢复可信宿主签发；若产品决定所有 pending 必须先人工批准，应显式返回等待审批。现在的“已下发但不可领取”不满足任一契约。该授权不意味着允许 Main 亲自执行目标操作。

**[P2] R18：删除意图先置取消标记，随后状态转换被自己的保护条件挡住。**

[compat.ts:797](/Users/pphua/Documents/GitHub/fate/apps/server/src/http/routes/compat.ts:797) 先写 cancelled_by_user=true，再调用 setIntentState(stopped)；后者 [exploration.ts:480](/Users/pphua/Documents/GitHub/fate/apps/server/src/db/exploration.ts:480) 排除已取消节点，因而永远无法命中。删除入口也没有 abort 当前运行实例。

复现：删除 open 意图返回 deleted=true，状态仍是 open。运行中的意图同样不会由此入口停止，之后正常终态 CAS 又被取消标记拒绝，可能留下 running 假象。应把取消标记和终态转换合并为一个受控操作，再中止运行实例。

**[P1] R19：目标分解完全没有收到用户单独填写的 goal。**

[tasks.ts:88](/Users/pphua/Documents/GitHub/fate/apps/server/src/http/routes/tasks.ts:88) 只传 description，GoalsRunInput 也没有 goal；[roles.ts:534](/Users/pphua/Documents/GitHub/fate/apps/server/src/agent/roles.ts:534) 的用户消息只有任务描述。即使 description 是背景、goal 是明确验收条件，模型也看不到后者。B 的 [goals.go:115](/Users/pphua/Documents/GitHub/ARTEX/agent/goals.go:115) 同时传目标与描述。

复现：数据库 goal 放入专用标记，捕获 Goals 模型的完整输入，标记不存在。只有模型完全未产出目标时 fallback 才读取原 goal，不能纠正已经产出的错误目标。应将原始目标显式传入，保存分解来源，确保最终 met 对应用户验收条件。

**[P2] R20：超时任务重新开始仍沿用过期 deadline；暂停也没有冻结时钟。**

[tasks.ts:127](/Users/pphua/Documents/GitHub/fate/apps/server/src/http/routes/tasks.ts:127) 先改 running 再调用 stampFirstRun；[stampFirstRun](/Users/pphua/Documents/GitHub/fate/apps/server/src/db/tasks.ts:377) 遇到已有 first_run_at 不更新截止时间。已有 applyTaskAdmission 包含 timeout 重置分支，但这些入口没有使用它。

复现：将任务设置成 timeout 且截止时间已过去，调用 start 后 deadline 仍在过去，下一次 deadline 检查会再次收尾。另经静态检查，[暂停](/Users/pphua/Documents/GitHub/fate/apps/server/src/db/tasks.ts:501) 和 [恢复](/Users/pphua/Documents/GitHub/fate/apps/server/src/http/routes/tasks.ts:146) 都没有记录或补偿暂停时长；创建时还在 LLM 就绪前盖首跑时间。B 的 [超时协调器](/Users/pphua/Documents/GitHub/ARTEX/server/engine_timeout.go:149) 明确冻结暂停预算。应统一首跑盖章、暂停冻结、恢复补偿和超时复活语义。

**三、双图、冷图、关联黑板与结果回传**

**[P1] R11：冷图压缩和 Worker 状态写入存在确定的反向加锁死锁。**

[coldgraph.ts:56](/Users/pphua/Documents/GitHub/fate/apps/server/src/agent/coldgraph.ts:56) 持有正 expID advisory lock，先更新 explorations 行，再锁所有探索节点。常规队列写入使用负 expID advisory lock，先锁节点，再由 [队列版本触发器](/Users/pphua/Documents/GitHub/fate/apps/server/src/db/sql/schema.sql:1576) 更新 explorations。两种 advisory lock 不互斥，形成 root→node 与 node→root 的循环等待。

复现：按上述顺序交错两个真实 PostgreSQL 事务，返回 SQLSTATE 40P01。Engine 外层 supervisor 可以重试，但不能消除死锁或避免当前业务事务回滚，表现为规划/状态写入间歇失败。应统一锁命名及顺序，缩小压缩事务锁范围，并测试压缩与领取、终态写入并发。

**[P2] R8：冷图隐藏了全部成员，却只暴露最多 15 个摘要，剩余证据失去发现入口。**

[overview.ts:19](/Users/pphua/Documents/GitHub/fate/apps/server/src/tools/overview.ts:19) 先取最近 15 个 digest，再过滤 active；[recent_facts/recent_done](/Users/pphua/Documents/GitHub/fate/apps/server/src/tools/overview.ts:39) 却排除所有 active digest 覆盖的节点。没有展开索引、分页或遗漏提示；过期摘要还会挤占 15 个名额。

复现：16 个互不相连的完成意图/事实块，压缩后 recent_facts=0，但 cold_digests=15。数据仍在库中，知道 ID 可以 node_detail；问题是模型无从发现遗漏块。B 的 [tools_digest.go](/Users/pphua/Documents/GitHub/ARTEX/agent/tools_digest.go) 提供冷图展开契约。应返回完整可分页索引，只隐藏可经摘要入口重新发现的证据，并在查询中先过滤 active。

**[P2] R9：关联任务只保存了关系，核心只读黑板继承没有迁移。**

[buildGraphOverview](/Users/pphua/Documents/GitHub/fate/apps/server/src/tools/overview.ts:17) 只读当前 exploration；[node_detail](/Users/pphua/Documents/GitHub/fate/apps/server/src/tools/graph.ts:87) 同样只按本任务取节点。list_findings 的 include_inherited 仅覆盖漏洞列表，不能替代源任务的事实、目标、线索、冷图和可引用证据。B 的 [relatedTaskOverviews](/Users/pphua/Documents/GitHub/ARTEX/agent/tools.go:916) 明确提供直接来源任务的只读投影。

复现：源任务事实包含标记，创建带 source_task_ids 的新任务，Planner overview 中没有该标记。应恢复一层只读继承、来源标记、授权过滤及详情/摘要展开；源任务意图不应因此被复制执行。

**[P2] R10：Worker 完成结果没有正确进入主会话，原会话自动回传链路缺失。**

[roles.ts:449](/Users/pphua/Documents/GitHub/fate/apps/server/src/agent/roles.ts:449) 使用 worker LIKE 'work#'，缺少百分号，匹配不到实际 work#1 等记录。复现：写入真实 activity result 后运行 Main，模型输入没有结果标记。

即使改成前缀匹配，也只会在用户下一次提问时读取任务最近结果，不能恢复 B 的“下发意图订阅→原 main segment→持久反馈 outbox→SSE 回放”链路。A 中相关数据库结构尚在，但没有注册订阅/消费发布的 TypeScript 调用。B 参考 [db/worker_feedback.go](/Users/pphua/Documents/GitHub/ARTEX/db/worker_feedback.go:10)、[server/worker_feedback.go](/Users/pphua/Documents/GitHub/ARTEX/server/worker_feedback.go:13)。另外 A 先提交意图终态再追加结果 activity，恢复反馈触发器时还要处理该顺序。不能只修一个 LIKE 就宣称自动回传已完成。

**[P2] R15：报洞不是原子操作，失败后留下 confirmed 的图节点。**

[findings.ts:51](/Users/pphua/Documents/GitHub/fate/apps/server/src/tools/findings.ts:51) 依次独立提交图节点、yields 边、findings 表记录；后两步失败时前面的提交不回滚。复现：summary 含 PostgreSQL 不接受的 NUL 字符，工具返回错误，但图内留下 1 个 confirmed finding，报告表没有记录。

结果会造成图、报告、统计不一致，重试还可能重复节点。应采用统一事务覆盖 finding/node/edge/anchor/tested，成功提交后再发通知；需要幂等调用键。B 的 [db/finding_traffic.go](/Users/pphua/Documents/GitHub/ARTEX/db/finding_traffic.go:394) 包含对应事务式记录路径。

**四、静态确认的六组功能缺口（未计入上述 20 个复现）**

| 编号 | 缺口及具体影响 | 定位与修复契约 |
| --- | --- | --- |
| G1 | MCP 管理测试支持 legacy SSE，Worker 运行装配却把所有非 stdio 都转成普通 URL，且丢弃 insecure。管理页连接成功不代表会话能连接。 | [resources.ts:19](/Users/pphua/Documents/GitHub/fate/apps/server/src/agent/resources.ts:19)、[mcp-mgmt.ts:359](/Users/pphua/Documents/GitHub/fate/apps/server/src/http/routes/mcp-mgmt.ts:359)。本地安装的 pi 1.3.0 默认 URL transport 是 StreamableHttpTransport，没有 legacy SSE fallback。使用原生 createTransport 扩展点或明确拒绝不支持的配置；按传输分别验证连接、工具调用、取消、关闭。 |
| G2 | 任务 LLM GET 固定显示全局 active profile，resolution 永远为空；PUT 却保存任务配置链，运行 resolver 也读取任务/角色配置。因此配置页面可能显示与实际执行不同的模型。候补链没有运行时 failover。 | [compat.ts:769](/Users/pphua/Documents/GitHub/fate/apps/server/src/http/routes/compat.ts:769)、[tasks.ts:409](/Users/pphua/Documents/GitHub/fate/apps/server/src/http/routes/tasks.ts:409)、[modelResolver.ts:10](/Users/pphua/Documents/GitHub/fate/apps/server/src/pi/modelResolver.ts:10)。应从同一个解析服务生成运行选择及查询结果，记录每次选择/失败尝试，再设计候补与限流。 |
| G3 | 多个管理配置只落库、不影响运行：任务 plan_heartbeat_seconds 未进入 Planner；wrapup_max_turns 虽读出却被 1/2 常量替代；Worker 数量只在进程启动时读取；内置工具 description 可保存但装配只读 enabled/agents；agent enabled 未在角色运行入口检查。 | [engine.ts:279](/Users/pphua/Documents/GitHub/fate/apps/server/src/engine/engine.ts:279)、[roles.ts:39](/Users/pphua/Documents/GitHub/fate/apps/server/src/agent/roles.ts:39)、[roles.ts:70](/Users/pphua/Documents/GitHub/fate/apps/server/src/agent/roles.ts:70)、[config.ts:186](/Users/pphua/Documents/GitHub/fate/apps/server/src/http/routes/config.ts:186)、[index.ts:71](/Users/pphua/Documents/GitHub/fate/apps/server/src/index.ts:71)。应逐字段明确即时生效、下次会话生效或需重启，运行快照返回实际配置。 |
| G4 | 工具参数和结果在写入 activity 时分别截到 8000/4000 字符，get_worker_trace 再截到 6000。过程检索承诺的“完整内容”无法通过该 API 续读，跨 Worker 复用会遗漏长结果中的证据。 | [engine.ts:708](/Users/pphua/Documents/GitHub/fate/apps/server/src/engine/engine.ts:708)、[graph.ts:228](/Users/pphua/Documents/GitHub/fate/apps/server/src/tools/graph.ts:228)。pi JSONL 可能仍有原文，因此不是声称所有副本均丢失；应存完整证据引用并提供分页/字节区间读取，摘要截断不能替代证据存储。 |
| G5 | 数据库有 admission/FIFO 方法，但实际 Engine 没有全局准入调度；workers 按任务各自创建，任务越多总并发越大。进程启动重置 running 意图没有实例租约保护，不能作为多实例恢复方案。 | [engine.ts:164](/Users/pphua/Documents/GitHub/fate/apps/server/src/engine/engine.ts:164)、[engine.ts:200](/Users/pphua/Documents/GitHub/fate/apps/server/src/engine/engine.ts:200)、[tasks.ts:432](/Users/pphua/Documents/GitHub/fate/apps/server/src/db/tasks.ts:432)。单实例也需恢复全局并发准入；多实例部署还需租约/过期回收/隔离令牌。这里是架构缺口，未实施多实例负载复现。 |
| G6 | 流量证据库、漏洞复测仍为移除端点；附件聊天明确返回未接入。它们没有因为前端页面和数据库表保留就完成迁移。 | [removed.ts:10](/Users/pphua/Documents/GitHub/fate/apps/server/src/http/routes/removed.ts:10)、[removed.ts:34](/Users/pphua/Documents/GitHub/fate/apps/server/src/http/routes/removed.ts:34)、[tasks.ts:326](/Users/pphua/Documents/GitHub/fate/apps/server/src/http/routes/tasks.ts:326)。需要独立 artifact/evidence/retest 领域流程接入 pi 工具及消息输入；在此之前应明确标注不可用，不能用空数据冒充已实现。 |

**五、与 B 核心设计的对照判断**

| 设计约束 | 当前判断 |
| --- | --- |
| 全局资产图与任务探索图分离 | 表和基础写入仍在；R16 的发现来源、R15 的写入原子性破坏了数据语义。 |
| 锚点连接两图、用授权决定可读可执行 | 锚点存在，但 R5/R17/R14 分别在出口、范围归属和目标证明处脱离授权契约。 |
| Planner 基于黑板规划，Worker 原子领取并回写 | 原子领取基础存在；R1/R2/R13 是入口与领取条件不一致，R4 是手动模式边界失效，R11 是并发锁协议不统一。 |
| 冷图是可展开的有界投影，不能删除证据可发现性 | 物理节点未删除，R8 仍破坏了可发现性。确定性抽取摘要本身可以是合理调整，必须保留版本、索引、展开与复活契约。 |
| 直接关联任务提供只读黑板 | 关系表和部分 findings 继承存在，R9 表明事实和冷图等核心继承视图未接上。 |
| 主会话交互与执行解耦 | 当前 main 工具白名单没有 bash/write/edit；外部 MCP/自定义执行工具只装配给 Worker，这个方向符合用户要求。本轮未复现“Main 直接执行扫描”；现存问题是 R10 的反馈和 R13 的下发语义。 |
| pi 原生负责模型/工具循环与会话 | AgentSession、SessionManager、扩展事件、Skill loader 和 MCP extension 的基本用法已接入。问题主要在宿主领域契约；不需要为解决这些问题重新复制 norma 循环。 |
| MCP/Skill/LLM/自定义工具管理与运行一致 | Skill 的角色可见性和原生加载链路存在；MCP 传输、LLM 展示/治理、配置实际生效仍见 G1–G3。自定义 HTTP 的授权缺陷见 R5。 |

建议先统一四个服务边界，再按复现用例修复：任务/意图生命周期服务（所有 API 和工具同入口）；资产授权与发现服务（原子来源登记、域名归一化、可信执行授权）；GraphView/GraphWrite 服务（授权投影、源任务继承、完整冷图索引、原子写回）；WorkerFeedback 服务（原会话订阅、终态与总结一起提交、持久 outbox）。pi 继续拥有会话和工具执行循环，服务通过原生 ToolDefinition、扩展及 AbortSignal 与之交互。

修复顺序建议为：资产越界与暂停失效 → 下发/恢复/超时/目标输入 → 冷图锁和图视图完整性 → 原会话回传与证据事务 → 配置管理和剩余功能缺口。验收应走实际前端接口和真实领域工具，不能仅调用 Engine 内部方法；还要加入并发、重启、封禁后重试和审批变更场景。

此前“149 通过、1 跳过”的结果只代表当时已有测试覆盖的行为。本文的 20 个场景不在那组有效覆盖范围内，且包括上一轮改动中的遗漏。因此此前文档中“主要断点已修复”等表述不能作为完整迁移验收依据。

**复现材料使用说明**

保存的测试文件后缀为 .ts.txt，不进入默认测试收集。需要复核时，在没有其他同名临时文件的前提下，从项目根目录执行：

    cp docs/reviews/evidence/pi-migration-regressions.test.ts.txt apps/server/.review-refactor.test.ts
    cd apps/server
    npx vitest run .review-refactor.test.ts

测试使用本地 127.0.0.1:5433 的开发 PostgreSQL，账户需要创建/删除测试数据库权限；创建独立 series_review_<pid> 数据库，正常 teardown 删除该库及临时会话目录。HTTP 外联被 mock，模型使用 pi faux provider。完成后删除临时 .review-refactor.test.ts。当前实现下预期 20 个行为断言失败；修复后应逐项转绿。R3/R4 对模型调用使用有界观察窗口；后续纳入长期回归时可增加调度器就绪事件，使零调用断言更稳定。
