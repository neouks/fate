# SERIES TS 后端（pi SDK 重构版）

Go/norma → TypeScript/pi 深度重构的后端。核心保留：双图黑板（资产图+探索图）、资产审批、
拦截审批、SKILL/MCP 配置、planner/worker/mainagent/goals 四角色、事件驱动引擎、出口网关。
已删除（轻量化决策）：MITM 流量录制、llmpool/llmrec 录制、sidequestion、selfupdate、
ScopeSentry 同步、retester、任务模板/归档、enrich、noa、memory、交互 shell、冷图压缩（延后）。

## 开发

```bash
# 依赖（仓库根目录）
pnpm install

# 本地开发库（一次性；端口与 apps/server/config.json 对应）
docker run -d --name series-ts-pg -e POSTGRES_USER=series -e POSTGRES_PASSWORD=series \
  -e POSTGRES_DB=series -p 127.0.0.1:5433:5432 postgres:16-alpine

# 启动（:18787 API + :8788 出口网关）
cd apps/server && npx tsx src/index.ts -addr 127.0.0.1:18787

# 测试（串行执行，共享开发库）+ 类型检查
npx vitest run && npx tsc --noEmit
```

配置：`apps/server/config.json`（database + skill_dir）或环境变量 `SERIES_PG_DSN` /
`SERIES_CONFIG` / `SERIES_SKILL_DIR`。首次进入 `POST /api/auth/init` 设置口令。

## 架构（分层，低耦合）

```
src/
├── config/    配置加载（文件 + 环境变量优先）
├── db/        PostgreSQL 层：schema.sql 复用（幂等迁移）+ 六个 store
│              （exploration 双图队列 / assets 资产图 / tasks 任务 /
│               task_scope 授权与覆盖度 / platform 配置种子 / intercept 审批）
├── pi/        pi SDK 适配层：AgentRunner（会话/事件→activity/guard 扩展/
│              wrapup 收尾/resume 断点续跑）——唯一依赖 pi 的层
├── tools/     ~20 个领域工具（三通道写回纪律；ToolRunContext 隔离引擎回调）
├── agent/     四角色提示词 + 装配（planner 无状态轮+TodoStore / worker
│              system mandate+续跑 / mainagent 会话 / goals 分解）
├── engine/    事件驱动调度：debounce/心跳/worker 池 CAS 领取/终态映射/
│              超时收尾/steer&kill
├── egress/    出口授权网关：CONNECT allowlist + 任务签名凭据 +
│              bash spawnHook 环境注入（网络层资产授权）
├── http/      Fastify：REST + JWT + SSE 活动流（契约对齐 web/ 前端）
└── index.ts   入口：迁移 → 网关 → Engine → API
```

依赖方向单向：http → engine → agent → tools → db；pi 适配只被 agent/engine 使用。

## 与 Go 版的关键语义对照

- 意图去重：sha256(归一化 summary + 排序锚点) 指纹，仅活跃态去重（db/exploration.ts）
- 领取：advisory xact lock 事务内 CAS `open→running`（claimNextWorker）
- 守卫：runner guard 顺序 = steer 排干 → extraGuard（审批）→ 资产 host 校验
- 收尾：pi `agent_before_settle` 注入 wrapup 提示续跑 ≤2 轮（预算边界）
- 断点续跑：会话文件 `data/sessions/exp<N>-worker-i<M>.jsonl`，按路径 resume

## 已知延后项

- 冷图/digest 压缩（长任务上下文控制，graph_overview 有界投影先兜底）
- activity token 计量、llm_profiles 变更热更新、并发准入 FIFO 队列
- MCP stdio/http 客户端接线（mcp_servers 表已就绪，pi-mcp 待接）
