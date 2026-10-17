<div align="center">

# SERIES（pi 重构版）

AI 自主渗透测试系统 —— TypeScript / Node 22 + [pi SDK](https://github.com/earendil-works/pi)（@earendil-works/pi-coding-agent）+ Next.js 前端 + PostgreSQL

</div>

---

> 本仓库已完成 Go/norma → TypeScript/pi 的深度重构（原 Go 后端已移除，历史见 git）。
> 核心设计全部保留：**双图黑板架构**（全局资产图 + 每任务探索图）、**资产审批**、
> **拦截审批**、**SKILL/MCP 配置**、**planner/worker/mainagent/goals 四角色**、事件驱动引擎、
> 出口授权网关。按轻量化原则删除了 MITM 流量录制、LLM 池/录制、旁路提问、在线更新、
> ScopeSentry 同步、复测、任务模板/归档等模块（详见 `apps/server/README.md`）。

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
系统配置页填 profile（兼容任意 OpenAI 协议网关的 baseUrl）。

## 仓库布局

| 目录 | 说明 |
| --- | --- |
| `apps/server/` | TS 后端：db 六 store / pi 适配层 / 领域工具 / 引擎四角色 / REST+SSE / 出口网关（91 项测试，`pnpm test`） |
| `web/` | Next.js 前端（独立 npm 工作流，`npm run build`） |
| `skills/` | 技能目录（SKILL.md，热加载） |
| `docs/` | 历史设计文档（部分对应已删模块） |

## 架构速览

```
web (Next.js) ── REST/JWT/SSE ── Fastify ── Engine（事件驱动：debounce+心跳+worker池CAS领取）
                                              │
                 planner(无状态轮+TodoStore) worker(system承载mandate+断点续跑) mainagent(steer)
                                              │
                              ~20 领域工具（三通道写回：资产图/事实/漏洞）
                                              │
              PostgreSQL 双图黑板 ── 出口网关（CONNECT allowlist + 任务签名凭据 + bash 代理注入）
```

仅供授权测试与研究使用。
