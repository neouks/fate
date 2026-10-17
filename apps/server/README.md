# SERIES TypeScript 后端

后端以 pi SDK 1.3.0 管理模型、会话、工具执行与扩展生命周期，以 PostgreSQL 保存双图黑板和任务状态。Engine 负责调度，不能把领域状态机交给模型会话隐式决定。完整对照见 [迁移复核](../../docs/pi-core-reconciliation-20261017.md)。

## 开发与验证

```bash
# 仓库根目录
pnpm install

# 本地 PostgreSQL（已有容器时不要重复创建）
docker run -d --name series-ts-pg -e POSTGRES_USER=series -e POSTGRES_PASSWORD=series \
  -e POSTGRES_DB=series -p 127.0.0.1:5433:5432 postgres:16-alpine

cd apps/server
npx tsx src/index.ts -addr 127.0.0.1:18787
npm test
npm run build
```

配置来自 `config.json` 或 `SERIES_PG_DSN`、`SERIES_CONFIG`、`SERIES_SKILL_DIR`。首次进入 `POST /api/auth/init` 设置口令。测试默认连接 `series_test`，可用 `SERIES_TEST_PG_DSN` 指定专用测试库；不要指向业务数据库，集成测试会修改配置和清理夹具。

## 模块与职责

| 模块 | 职责 |
| --- | --- |
| `db/` | 全局资产图、任务探索图、锚点、任务范围、审批、配置与幂等迁移 |
| `engine/` | 任务启动/暂停/恢复/结束、意图领取、worker 池、planner 唤醒、聊天运行状态 |
| `agent/roles.ts` | 四角色装配及工具边界；worker 执行，mainagent 沟通和编排 |
| `agent/coldgraph.ts` | 冷节点判定、digest 投影与原始证据保留 |
| `agent/resources.ts` | 按角色读取技能和 MCP 可见性，每次新会话刷新 |
| `pi/runner.ts` | 原生 SessionManager、扩展绑定/关闭、guard、预算、取消、会话压缩及事件归一化 |
| `pi/modelResolver.ts` | 每轮读取模型配置，按完整 profile 内容缓存 provider |
| `tools/` | 图查询、资产/事实/漏洞写回、意图与目标操作、自定义工具 |
| `intercept/`、`egress/` | 工具审批与任务出口授权；审批等待响应取消信号 |
| `http/` | REST/JWT、历史回放、SSE 增量及管理接口 |

领域工具仍由服务端定义，作为 pi 自定义工具注册。MCP 通过 pi 的 `createMcpExtension` 接入，技能通过原生资源加载器加载；不另建一套模型工具循环。SDK 类型也出现在角色和自定义工具装配层，因此不再声称“只有 pi/ 目录依赖 SDK”。

## 当前保证

- 下发先完成数据库提交再唤醒；worker 领取后立即处理下一条，空队列才等待。
- 同一进程内任务启动幂等；暂停/停止传递 AbortSignal 并等待当前执行结束。
- 普通聊天只初始化会话，不启动任务；显式下发意图或增加目标才恢复调度。
- mainagent、planner、goals 不装配 bash/write/edit、自定义执行工具或外部 MCP；worker 承担执行。角色提示词不能扩大代码层权限。
- worker 会话固定为 `data/sessions/exp<N>-worker-i<M>.jsonl`；主聊天按任务和分段保存。
- 冷图仅折叠投影，保留原节点、因果边及资产锚点；图或锚点变化使旧 digest 失效。
- 最终活动先持久化再广播；临时 delta 单独传输，不推进历史游标。工具调用 ID、主聊天分段和消息流 ID 保留到前端。
- 模型错误可见，连续工具调用有轮数上限；达到预算可有限收尾，墙钟超时直接取消。

这些保证由本地 pi faux provider、真实 PostgreSQL、stdio MCP 夹具和本机命令/脚本回归验证。真实服务商、远程 MCP 和浏览器交互仍需环境验收。

## 尚未完成的迁移

旧版流量证据/MITM、复测、旁路提问、任务模板/归档、ScopeSentry 同步、模型池/录制与完整重试策略仍有缺口；旧路径在 `http/routes/removed.ts` 中显式返回 404。附件对话尚未接入，提交附件返回明确错误。不能把这些接口或页面算作已恢复能力。

LLM 基础协议、角色绑定及配置刷新已接入；高级代理、限流、额度故障切换、全局任务 FIFO 仍需统一调度设计。MCP 的 stdio 和 Streamable HTTP 使用原生实现；旧 SSE、insecure 配置及远程服务需兼容验收。自定义工具运行时已接入，但管理页测试器及目录/延迟加载等元数据尚未完全统一。具体接口契约与验收条件见迁移复核文档。
