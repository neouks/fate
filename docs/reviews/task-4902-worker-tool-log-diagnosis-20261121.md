任务 4902：Worker 中断与工具失败排查

排查日期：2026-11-21；下文时间均为北京时间。任务对应 exploration_id=5588。证据来自本机 PostgreSQL 的 activity、llm_request_attempts、llm_usage_ledger、worker_operations，结合原生响应事件、服务日志与运行代码核对。只读业务数据，未恢复任务、重跑工具或请求测试目标。

**1. 核心结论**

任务目前 status=running、paused=true，实际处于暂停状态。最后一个 Worker（意图 39529）在 02:50:18 因 task_paused 结束，不是进程崩溃。

本次共有 20 个 Worker 因模型网络/响应流故障停止，另有 1 个因同参数工具连续失败被宿主强制收尾。模型故障集中于 DeepSeek-Flash（profile 453，deepseek-flash，api.deepseek.com）；Planner 同期也有 11 次模型请求失败，支持共用模型连接链路异常，而非单个 Worker 的业务逻辑问题。

模型故障分类：连接超时 10 次、对端关闭连接 3 次、响应体超时 2 次、ECONNRESET 2 次、DNS ENOTFOUND 1 次、EADDRNOTAVAIL 1 次、读取 ETIMEDOUT 1 次。日志没有提供足够证据区分运营商链路、本机网络切换、代理/VPN、远端服务异常；不能直接归咎于某一方。未见这些请求的 401/429 或明确额度不足错误。

**2. 模型故障为何变成“token 用量待核对”，重试为何没恢复**

因果链：物理模型请求出错 → 未取得 usage 回执 → ledger quality=unknown → 下一轮上下文/请求准入检查发现 uncertain → 抛出“Worker 累计 token 用量待核对：先前请求尚未结算或缺少完整用量” → Worker blocked。

- `apps/server/src/pi/usage-meter.ts:87`：onPayload 就把 attempted 设为 true。生成请求载荷不等于已经建立连接或已发送请求，因此 DNS/连接超时也会落到 unknown，而非 not_sent。
- `apps/server/src/db/worker-token-budget.ts:33`：任意 pending/uncertain 均拒绝后续请求，包括可重试连接故障。
- `apps/server/src/pi/runner.ts:458` 和 `apps/server/src/pi/modelResolver.ts:140`：有宿主重试流程，但重试仍经过上述预算准入。故网络瞬断可被扩大为意图永久受阻，换模型也不能自然解除同一意图的未知用量。
- `apps/server/src/engine/worker-outcome.ts:25`：分类先匹配 token_usage_unknown，再匹配连接错误。原始网络故障被保留在摘要，但主 reason 仍为预算核对状态。

20 次物理失败的用量全部 quality=unknown，SDK 的 0 token 是占位值，不能据此声称真实用量为零。修复应区分“有传输证据证明未发送”与“已发送、计费未知”，不能把所有失败强行改成零；后者需要明确的核对/保守预留恢复策略。

**3. 错误日志统计漏报**

20 条 token_usage_unknown 结束回执和 1 条 tool_retries_exhausted 结束回执全部 is_error=false。`apps/server/src/engine/engine.ts:842` 写 result 时未传 is_error；数据库默认 false。因此单独筛选 is_error=true 会漏掉这些 Worker 失败，应同时查询 metadata.execution_stop.reason 与 metadata.status。原生流还会先出现 error、随后宿主 abort，不能把两条事件算作两个独立 Worker 崩溃。

最后暂停应结合 tasks.paused 判定，不能仅看到 status=running 就认定仍在执行。

**4. 工具失败：2449 次结果中 111 次标记错误（4.53%）**

| 工具 | 次数 | 已核实原因 |
|---|---:|---|
| context_get | 36 | 30 次 offset>0 却不带 field；4 次请求不存在的字段；1 次 max_chars 超过 24000；1 次 traffic 引用使用不支持的视图 |
| bash | 31 | 模型生成脚本的语法、路径、数据结构或编码问题；部分为命令正常未匹配却 exit 1，以及网络/取消 |
| web_search | 9 | 9 次公共搜索源 HTTP 302 |
| http_request | 8 | 5 次 ECONNRESET、1 次 NETWORK_ERROR（对 :22 发 HTTP 请求）；2 次参数错误（URL 不是合法 URI、most_redirects 未知字段） |
| record_fact | 7 | 缺字段、单条/批量结构混用、未知字段 claim_key/outcome/evidence_version、错误类型或 JSON 语法 |
| asset_search | 6 | 当前会话没有激活工具，直接调用报 Tool not found，需先 tool_search 加载 |
| add_intent | 4 | 1 次资产外键失败；2 次 retry_of 工作身份/范围不匹配；1 次 parent 指向 intent 而不是 fact/finding |
| web_read | 4 | 3 次 HTTP 404、1 次 HTTP 415 |
| asset_get | 3 | ids 一次超过 5 个 |
| context_search | 2 | 参数互斥规则冲突，错误只显示 root: must not match the schema in not |
| report_finding | 1 | 缺 finding_id、evidence_version，调用了不匹配当前契约的参数结构 |

context_get 的拦截在 `apps/server/src/tools/context-read.ts:288`，属于读取坐标保护；返回中已经给出 next_item/read_options。调用方没有按其完整坐标续读。应改善工具提示与错误分类，把“需要选择字段”与执行故障分开统计；不能简单删除坐标保护。

bash 的代表性问题：timeout 未安装（246395、246699、248492）；BSD grep 重复次数上限（246272）；相对目录层级错误（235590）；未给含分号路径加引号（236375）；for 循环列表里错误放重定向（251194）；list 当 dict、None 当字符串、返回值解包数量不符等。它们不证明 bash 执行器本身损坏。grep 没匹配等 exit 1 也被统一统计为工具失败，会增加噪声。

web_search 的公共源跳转策略见 `apps/server/src/search/public-web.ts:81`：仅允许有限的同源同路径跳转（Bing 有特例），最多 2 跳；最终 302 被报告“来源暂不可用”。历史错误没有保留 Location/跳转拒绝原因，所以只能确认重定向未完成，不能断言一定是验证码或封禁。

**5. 一个明确的“工具失败导致 Worker 中断”实例**

意图 39147，work#2：00:37:59 的 activity 234016 与 00:38:05 的 234036，对同 URL、方法、请求体和认证头的 http_request 连续得到 ECONNRESET；234037 随即宣布停止新探测，00:38:23 的 234123 以 tool_retries_exhausted 结束，已保存事实 39153。

`apps/server/src/pi/runner.ts:562` 按工具名及参数指纹记失败；第二次相同调用失败即可触发收尾，未区分暂时性网络错误与永久参数/权限错误。它只针对重复签名，不是“任意两次失败”。对于传输类故障应有独立、有限、带退避的策略；禁止自动重放的有副作用调用仍需保留保护。

add_intent 的外键失败（232736）输入 asset_ids=[19111,19155,19110,25177]；当前库中 19110 不存在。历史错误已确认当时有不存在的资产引用，当前核对指向 19110，但未保存当时的约束 detail，无法排除其他资产随后被补入。应在写锚点前返回带具体资产 ID 的结构化校验错误，避免泄露无助于调用方修正的数据库约束名称。

**6. 处理顺序建议**

1. 首先修正模型传输阶段记录与 usage 未知恢复策略，保留原始 cause_code，独立记录 billing_state；恢复前核对未知工具副作用。
2. 为异常 Worker 结束回执设置一致的错误分类和筛选字段；暂停、取消、规划者主动终止单独展示，不算崩溃。
3. 将工具失败分为参数错误、读取指引、未加载、暂时传输错误、永久失败、正常无匹配和主动取消；仅适合重试的类型进入有限重试。
4. 改善字段续读示例、当前工具契约提示、工具发现流程和 macOS 执行环境提示；外键错误返回具体非法 ID，搜索日志补充脱敏跳转原因。

本次仅完成定位，未更改实现或运行数据；未执行修复测试。

**7. 20 个模型故障 Worker 索引**

| 北京时间 | Worker | 意图 | 结束日志 | 原始模型错误 |
|---|---|---:|---|---|
| 00:33:31 | work#1 | 39114 | [#233260](http://127.0.0.1:8787/function/tasks/detail?id=4902&session=intent:39114&activity=233260) | Connection error.: other side closed (UND_ERR_SOCKET) |
| 00:34:45 | work#3 | 39095 | [#233417](http://127.0.0.1:8787/function/tasks/detail?id=4902&session=intent:39095&activity=233417) | Connection error.: other side closed (UND_ERR_SOCKET) |
| 00:38:59 | work#3 | 39142 | [#234187](http://127.0.0.1:8787/function/tasks/detail?id=4902&session=intent:39142&activity=234187) | Request timed out.: Connect Timeout Error (attempted addresses: 183.204.64.100:443, 111.32.200.78:443, timeout: 10000ms) (UND_ERR_CONNECT_TIMEOUT) |
| 00:39:00 | work#1 | 39146 | [#234193](http://127.0.0.1:8787/function/tasks/detail?id=4902&session=intent:39146&activity=234193) | Request timed out.: Connect Timeout Error (attempted addresses: 183.204.64.100:443, 111.32.200.78:443, timeout: 10000ms) (UND_ERR_CONNECT_TIMEOUT) |
| 00:39:13 | work#3 | 39129 | [#234221](http://127.0.0.1:8787/function/tasks/detail?id=4902&session=intent:39129&activity=234221) | Request timed out.: Connect Timeout Error (attempted addresses: 183.204.64.100:443, 111.32.200.78:443, timeout: 10000ms) (UND_ERR_CONNECT_TIMEOUT) |
| 00:39:31 | work#2 | 39115 | [#234247](http://127.0.0.1:8787/function/tasks/detail?id=4902&session=intent:39115&activity=234247) | Request timed out.: Connect Timeout Error (attempted addresses: 183.204.64.100:443, 111.32.200.78:443, timeout: 10000ms) (UND_ERR_CONNECT_TIMEOUT) |
| 00:39:52 | work#2 | 39154 | [#234291](http://127.0.0.1:8787/function/tasks/detail?id=4902&session=intent:39154&activity=234291) | Request timed out.: Connect Timeout Error (attempted addresses: 183.204.64.100:443, 111.32.200.78:443, timeout: 10000ms) (UND_ERR_CONNECT_TIMEOUT) |
| 00:40:06 | work#2 | 39155 | [#234314](http://127.0.0.1:8787/function/tasks/detail?id=4902&session=intent:39155&activity=234314) | Request timed out.: Connect Timeout Error (attempted addresses: 183.204.64.100:443, 111.32.200.78:443, timeout: 10000ms) (UND_ERR_CONNECT_TIMEOUT) |
| 00:40:28 | work#3 | 39130 | [#234338](http://127.0.0.1:8787/function/tasks/detail?id=4902&session=intent:39130&activity=234338) | Connection error.: getaddrinfo ENOTFOUND api.deepseek.com |
| 00:41:29 | work#1 | 39117 | [#234387](http://127.0.0.1:8787/function/tasks/detail?id=4902&session=intent:39117&activity=234387) | Connection error.: read EADDRNOTAVAIL |
| 00:50:56 | work#3 | 39182 | [#235440](http://127.0.0.1:8787/function/tasks/detail?id=4902&session=intent:39182&activity=235440) | Request timed out.: Connect Timeout Error (attempted address: api.deepseek.com:443, timeout: 10000ms) (UND_ERR_CONNECT_TIMEOUT) |
| 00:51:22 | work#2 | 39180 | [#235511](http://127.0.0.1:8787/function/tasks/detail?id=4902&session=intent:39180&activity=235511) | Request timed out.: Connect Timeout Error (attempted addresses: 116.196.150.245:443, 60.28.220.199:443, timeout: 10000ms) (UND_ERR_CONNECT_TIMEOUT) |
| 01:08:09 | work#2 | 39219 | [#238242](http://127.0.0.1:8787/function/tasks/detail?id=4902&session=intent:39219&activity=238242) | Request timed out.: Connect Timeout Error (attempted addresses: 116.196.150.245:443, timeout: 10000ms) (UND_ERR_CONNECT_TIMEOUT) |
| 01:08:14 | work#1 | 39224 | [#238246](http://127.0.0.1:8787/function/tasks/detail?id=4902&session=intent:39224&activity=238246) | Connection error.: other side closed (UND_ERR_SOCKET) |
| 01:12:48 | work#1 | 39248 | [#238666](http://127.0.0.1:8787/function/tasks/detail?id=4902&session=intent:39248&activity=238666) | Request timed out.: read ETIMEDOUT |
| 01:14:38 | work#3 | 39240 | [#238945](http://127.0.0.1:8787/function/tasks/detail?id=4902&session=intent:39240&activity=238945) | terminated: Body Timeout Error (UND_ERR_BODY_TIMEOUT) |
| 01:24:17 | work#3 | 39265 | [#240017](http://127.0.0.1:8787/function/tasks/detail?id=4902&session=intent:39265&activity=240017) | terminated: Body Timeout Error (UND_ERR_BODY_TIMEOUT) |
| 01:51:52 | work#2 | 39399 | [#244845](http://127.0.0.1:8787/function/tasks/detail?id=4902&session=intent:39399&activity=244845) | Connection error.: read ECONNRESET |
| 02:34:59 | work#2 | 39521 | [#250105](http://127.0.0.1:8787/function/tasks/detail?id=4902&session=intent:39521&activity=250105) | Connection error.: read ECONNRESET |
| 02:35:55 | work#2 | 39523 | [#250135](http://127.0.0.1:8787/function/tasks/detail?id=4902&session=intent:39523&activity=250135) | Request timed out.: Connect Timeout Error (attempted addresses: 116.196.150.245:443, timeout: 10000ms) (UND_ERR_CONNECT_TIMEOUT) |

主动控制的记录：用户取消涉及 39143、39168、39169（请求与终态不能重复计数）；Planner 终止涉及 39123、39152、39284、39327；39529 因任务暂停退出。这些与网络异常分开解释。
