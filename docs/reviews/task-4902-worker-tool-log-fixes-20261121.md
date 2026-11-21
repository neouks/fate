任务 4902 相关可靠性修复（2026-11-21）

模型网络失败后，Worker 原先会因为未知用量被永久挡在下一次请求之外。本次在请求发送前，将“模型输入窗口上限 + 本次输出上限”写入同一请求的持久计量记录。失败或中止后，已知用量与不足部分的保守预留共同占用预算，允许宿主在原有次数限制内重试。实际 usage 仍标为 unknown/partial，统计不会将预留伪装成实际消耗。

预算保护仍然适用：正在运行的请求阻止并发准入；缺少预留的历史未知用量、存在历史缺口或无效预留记录继续阻止新请求；重启/继续执行/压缩不能重置预算；完整回执可释放预留；计量包装器禁用 SDK 内部重试，确保每次物理请求独立记账。保守预留可能使预算早于真实消耗达到上限，错误与收尾说明会明确显示这部分占用。

Worker 结束回执现在为模型故障、未知用量阻断、工具重试耗尽等异常写入 is_error=true；暂停、取消、规划者终止、正常业务受阻不归为执行错误。模型连接错误识别补充了响应体超时、UND_ERR 系列、EADDRNOTAVAIL/EPIPE 等，避免归成泛化模型错误。

工具重复失败保护按请求类型处理：GET/HEAD/OPTIONS 的明确暂时传输错误允许第三次模型主动尝试，两次失败不再立即收尾；第三次仍失败则停止。POST 等写操作、任意 shell、参数或权限错误保留两次失败阈值；宿主不自动重放任何工具。成功调用会清除对应指纹的失败计数。该调整没有解除日志中意图 39147 的 POST 重放保护。

context_get 已从运行时消除分页契约不一致：原来 schema 允许省略 field，第一页也读取整个视图 JSON，但 offset>0 时额外要求显式 field，导致任务 4902 中 30 次 READ_SELECTION_REQUIRED。现在省略 field 与 field="" 在所有页都表示同一整个视图 JSON，删除仅针对续页的拒绝分支；schema 用 default="" 标明相同语义。日志中的 {ref:"node:39112",offset:3000,version:0,view:"detail"} 这种参数可正常续读，不需要模型先经历一次失败再修正。

该修复不猜测证据字段：显式 /payload/evidence 等字段仍采用自己的字符坐标，切换字段须从 offset=0 开始；next_item、read_receipt、source_hash 继续提供明确坐标。版本冲突、关系页 cursor、读取权限及原生证据的 byte/UTF-16 分页规则继续生效。

同时更新实际工具目录与模型声明共用的强制说明，而非仅修改被目录覆盖的原始工具 description。已存的精确旧版分页说明在解析时替换为新约定，保留自定义业务文本，不重复追加，也不改写数据库配置。

**验证**

- TypeScript 类型检查通过。
- 本次 context_get 根因修复：parameter-contracts.test.ts、catalog-runtime.test.ts、contract-recovery.test.ts 共 19 项通过，0 失败、0 跳过；集成套件各使用新建的独立 PostgreSQL 测试库，结束后删除。
- 独立 PostgreSQL 数据库、全新夹具运行 worker-recovery.test.ts、worker-token-budget.test.ts、contracts.test.ts：18 项通过，0 失败、0 跳过。
- 用真实本地 HTTP/SSE 服务在响应中途断开连接：重试成功，已完成工具只执行一次；预留在发送前可查，usage 未知状态保留。
- 覆盖保守预算上限阻止额外请求、部分用量不重复计费、继续执行/压缩保留预留、运行中请求及无预留旧记录仍阻断、非法预留拒绝、完整回执释放预留。
- 覆盖只读传输错误第三次成功或收尾、写操作/参数错误仍按原阈值停止、同批权限错误仍可保存已有观察。
- 分页回归通过原生 AgentRunner 重放 offset=3000、version=0、view=detail、缺省 field 的调用形状；Worker/Planner/Reporter 均核对模型声明与目录一致，并验证结果等于显式 field=""。
- 覆盖含中文及 emoji 的整个 JSON 分页还原、每页 source_hash/起止坐标、独立证据字段分页、版本冲突重置、关系页 cursor 要求、批量部分失败及总长度限制。
- contract-recovery 的旧断言同步到当前已有规则：add_intent 包含意图粒度说明；traffic_body 已映射到 context_get 权限，改为显式禁用该绑定验证拒绝读取。未改变这两项产品规则。
- 修正 contracts.test.ts 的旧前提：共享候选工具清单可以包含 add_intent，是否可用应验证模型实际工具声明；保留了该工具不在本测试 Worker 声明中的断言。

可复现测试命令（必须指定独立测试库）：

```sh
cd apps/server
TEST_WORKER_RECOVERY_DSN='<test_worker_recovery_* 独立库连接串>' TEST_WORKER_BUDGET_DSN='<test_worker_budget_* 独立库连接串>' node --import tsx --test --test-concurrency=1 src/pi/worker-recovery.test.ts src/pi/worker-token-budget.test.ts src/tools/contracts.test.ts
# 以下两个套件各使用单独的新建 test_* 库；测试结束后删除测试库。
TEST_TOOL_CONTRACTS_DSN='<独立 test_* 库连接串>' node --import tsx --test src/tools/catalog-runtime.test.ts
TEST_TOOL_CONTRACTS_DSN='<另一个独立 test_* 库连接串>' node --import tsx --test src/tools/contract-recovery.test.ts
node --import tsx --test src/tools/parameter-contracts.test.ts
npm run typecheck
```

**生效范围**

修复位于源码，尚未构建到现有服务目录或重启 8787 服务；任务 4902 继续保持原暂停状态。没有批量重写历史 is_error、usage 或执行状态。其历史失败请求没有新预留记录，不能仅凭本次升级自动解除，需依据原始请求上限与副作用记录另行核对。脚本业务错误、第三方搜索源 302、目标断连也不会被本次改动消除。
