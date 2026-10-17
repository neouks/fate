<div align="center">

# SERIES（pi 重构版）

AI 自主渗透测试系统 —— TypeScript / Node 22 + [pi SDK](https://github.com/earendil-works/pi)（@earendil-works/pi-coding-agent）+ Next.js 前端 + PostgreSQL

</div>

---

> 本仓库使用 TypeScript/pi 承接 ARTEX 的 Go/norma 后端。迁移基准是保留双图黑板、
> 资产锚点、角色分工、审批和任务生命周期，不能以“配置页存在”代替运行时接线。
> 已修复 worker 下发/领取、角色执行边界、会话恢复和流式活动链路，并接入 pi 原生
> MCP/技能加载、自定义工具及冷图投影。旧模块仍有迁移缺口，当前不宣称与 Go 版完全等价。
> 详见 [迁移复核、修复与缺口设计](docs/pi-core-reconciliation-20261017.md)。

## 快速开始

```bash
# 1) 数据库 + 后端（docker compose）
cp .env.example .env        # 填 POSTGRES_PASSWORD
docker compose up -d --build
# → http://localhost:8787（首次 /api/auth/init 或页面 /setup 设置口令）

# 2) 本地开发
pnpm install
docker run -d --name series-ts-pg -e POSTGRES_USER=series -e POSTGRES_PASSWORD=series \
  -e POSTGRES_DB=series -p 127.0.0.1:5433:5432 postgres:16-alpine
cd apps/server && npx tsx src/index.ts -addr 127.0.0.1:8787   # API + 出口网关(:8788)
cd web && npm run dev                                          # 前端 :5173（/api 反代 8787）
```

配置：`SERIES_PG_DSN` 环境变量或 `config.json`（见 `config.example.json`）；LLM 在
系统配置页填 profile，按服务商选择 OpenAI Chat Completions、OpenAI Responses 或 Anthropic 协议。

## 仓库布局

| 目录 | 说明 |
| --- | --- |
| `apps/server/` | TS 后端：db 六 store / pi 适配层 / 领域工具 / 引擎四角色 / REST+SSE / 出口网关（`pnpm test`；集成测试默认使用独立 `series_test` 数据库） |
| `web/` | Next.js 前端（独立 npm 工作流，`npm run build`） |
| `skills/` | 技能目录（SKILL.md，热加载） |
| `docs/` | 迁移复核及历史设计文档；旧文档需结合当前复核确认实现状态 |

## 架构速览

```
web (Next.js) ── REST/JWT/SSE ── Fastify ── Engine（事件驱动：debounce+心跳+worker池CAS领取）
                                              │
                 planner(无状态轮+持久化待办) worker(意图执行+断点续跑) mainagent(沟通/编排)
                                              │
                              ~20 领域工具（三通道写回：资产图/事实/漏洞）
                                              │
              PostgreSQL 双图黑板 ── 出口网关（CONNECT allowlist + 任务签名凭据 + bash 代理注入）
```

仅供授权测试与研究使用。
