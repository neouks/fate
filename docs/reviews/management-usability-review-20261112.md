# 管理功能可用性检查与归档对照

日期：2026-11-12。检查对象为 fate 主工作区 TypeScript 后端与前端实际调用；保留其他未提交修改。此次未重启生产服务、未修改生产业务数据、未调用模型或外部目标。

## 结论与范围

归档当前不可用：不是任务 ID 错误，而是迁移后只剩 UI、类型和表结构，执行后端没有接回。

本轮检查前端 API 的 259 处调用表达式并与实际注册路由对照，动态路径人工复核。路由存在不代表业务已验收，未对所有按钮逐一做浏览器操作。明确发现 6 组问题；分类和 MCP 导入已修复，其余尚未关闭，不能据此宣称全站可用。

## 问题清单

### F1 / P1：归档、恢复、删除归档整条链路缺失（未修复）

- 前端：`web/src/lib/api.ts` 的 taskArchives/archiveTask/archiveTasks/restoreTaskArchive/restoreTaskArchives/deleteTaskArchive/deleteTaskArchives；任务列表与详情均有实际入口。
- 后端：`apps/server/src/http/routes/removed.ts` 将 `/api/task-archives` 及其子路径显式返回 404；`/api/tasks/:id/archive`、`/api/tasks/archive/batch` 未注册。
- 用当前 buildApp、合成 JWT 和无业务数据库的隔离 inject 检查 8 个归档入口：全部 404。没有执行任何真实归档或删除。
- `task_archives` 和 `tasks.archived_at` 已存在，不能把“建了表”视为已实现。
- `db/tasks.ts` 的 listTasks/listTasksPage/getTask 只排除 deleted_at，未排除 archived_at；直接补写 archived_at 仍不足以得到正确的列表、调度和继承行为。
- 生产库只读查询：task_archives 0 条，未删除的 archived_at 非空任务 0 条。本次未发现生产历史归档受影响的证据，不代表未来可以忽略兼容。

### F2 / P1：删除任务忽略清理选项，且停止失败仍成功（未修复）

- 前端 DeleteTaskOptions 提供资产、流量、文件、漏洞、LLM 明细五种清理选项，DeleteTaskResult 要求各项清理统计。
- `http/routes/tasks.ts` DELETE `/api/tasks/:id` 不读取这些选项，只调用本进程 engine.stop，吞掉其异常后写 deleted_at，返回 `{ok:true,id}`。
- 合成执行器抛出停止失败时，隔离 inject 仍返回 200 并执行软删除 UPDATE。源码也未验证 UPDATE 是否命中。
- `Engine.stop` 只处理本进程 rt，不构成跨实例退出确认。不能据当前响应确认执行器已退出或磁盘已释放。
- 应先统一持久停止/删除命令、确认执行器退出和继承检查，再按选项清理并返回真实计数；计量账本、共享证据不能随意清除。此项不能通过补一个成功提示修复。

### F3 / P2：MCP 批量导入按钮调用不存在接口（已修复，未发布）

- `system/mcp/panel.tsx` submitImport 调用 POST `/api/mcp/import`；此前路由缺失。
- 新增 `http/routes/mcp-import.ts`，由 mcp-mgmt 注册。一次校验全批，事务按名称新增/更新，返回现有页面需要的 results。
- 保留已有 ID、Agent 可见性绑定和未显式覆盖的 TLS 设置；更新后清除旧工具缓存，防止改地址后仍显示旧 Schema。可通过已有“刷新工具”重新发现。
- 支持 stdio/http/SSE，批次上限 100；非法批次无部分写入，并发同名导入不重复创建，采用固定锁顺序。
- 导入只保存配置，不启动命令或主动连接服务器；响应不宣称连通性已通过，不回传 env/认证内容。

### F4 / P2：分类改名遗漏查重键，并发重名变成 500（已修复，未发布）

- `http/routes/categories.ts` 原 PATCH 只更新 name，不更新 nkey；After 改名后可能允许另建 After，却拒绝复用 Before。
- 新建/改名原有先查再写存在竞争：数据库唯一约束异常没有转换为 409。
- 已同步更新 name/nkey；新增使用 ON CONFLICT，改名捕获唯一冲突，返回 409。
- 生产只读查询发现分类 nkey 与名称不一致 0 条、名称重复组 0 组，因此未改写历史分类。

### F5 / P2：工具“恢复代码默认”实际只启用（未修复）

- `system/tools/panel.tsx` reset 成功提示“已恢复为代码默认”。
- `http/routes/config.ts` POST `/api/tools/:key/reset` 仅执行 `SET enabled=true`，未恢复已修改的说明、角色绑定等默认配置；不存在的工具还会返回 200 `{ok:false}`，前端仍显示成功。
- 隔离 inject 核实执行 SQL 只有查询 kind 与启用 UPDATE。
- 修复应使用统一工具注册表恢复明确可编辑的默认字段，同时保护退役工具，找不到时返回 404。不能把重新启用解释成完整恢复默认。

### F6 / P2：不存在的 MCP 更新、删除返回假成功（未修复）

- `db/platform.ts` saveMCP 更新分支不检查 rowCount，仍返回传入 ID。
- deleteMCP 不返回实际删除数；`http/routes/config.ts` DELETE `/api/mcp/:id` 固定返回 `{deleted:1}`。
- 多窗口删除/编辑或列表过期时，会提示成功而没有改变记录。应在事务内检查命中情况，返回明确 404/冲突信息。

## SERIES 归档设计与适配要求

核对来源：

- https://github.com/neouks/series/blob/main/server/task_archives.go
- https://github.com/neouks/series/blob/main/server/task_archive_package.go
- https://github.com/neouks/series/blob/main/db/task_archives.go

SERIES 采用持久任务队列与冷归档包，不是隐藏任务列表：

1. 已暂停或终态任务才能入队；排队任务先暂停。检查未归档依赖关系。批量归档按依赖逆序，恢复按来源在前排序。
2. Worker 领取 archive/restore/delete 作业，持久化阶段、进度和失败原因，支持重启恢复。
3. 归档前等待相关执行退出；分阶段暂存工作目录、流式导出数据库、流量和证据，生成 tar.zst 与校验和，成功后清理在线载荷并保留元数据。
4. 恢复验证路径、格式、清单和校验和，分阶段恢复文件与数据库；已提交后发生清理失败时不能重放已恢复数据。
5. 删除归档检查其他归档依赖；归档包删除与元数据修改有补偿处理。

fate 不能直接照搬 Go 表清单。必须额外纳入 pi 原生会话、turn/stream、文件历史差异、读版本记录、意图工作记录、反馈/outbox、计量和 Skill/MCP 原生调用归属；计量不得因恢复重复累计。

建议按以下依赖顺序实施，不把半实现功能标成可用：

| 批次 | 内容 | 验收边界 |
|---|---|---|
| 1 | 归档准入、依赖关系、持久作业、执行器互斥 | 运行/暂停竞争、跨实例、重复请求、不假成功 |
| 2 | 版本化包、流式快照、校验和、文件暂存与补偿 | 图谱/证据/会话完整，失败原数据可读 |
| 3 | 幂等恢复/删除、重启恢复、列表与调度隔离 | 恢复不重放工具，不自动启动暂停任务，计量不翻倍 |
| 4 | 现有 UI 接口接入与失败重试 | 单个/批量、筛选、进度、依赖顺序、错误可见 |

不建议用 deleted_at 模拟归档、仅改 archived_at、仅备份数据库或返回空归档列表作为修复。这些做法不能满足当前页面对可恢复冷存储的承诺。

## 没有计入在线故障的遗留接口

ScopeSentry、在线自更新、旧 workspace 上传、旧命令记录和部分已退役设置仍有客户端声明；当前检索未找到活动页面入口。HTTPAuthCard 文件仍调用不存在的 GET/PUT 设置接口，但未发现组件挂载。它们属于待清理/恢复的遗留契约，不能与正在显示的归档/MCP 按钮混为同一类在线故障。

## 本轮验证

- 分类隔离 HTTP + PostgreSQL 回归：4 通过，0 跳过（含父测试）。
- MCP 导入隔离 HTTP + PostgreSQL 回归：7 通过，0 跳过（含父测试）。覆盖身份校验、3 种传输配置、禁用绑定保留、并发、批次校验和数据库中途失败的整体回滚。
- 主工作区服务端 typecheck/build 通过；仅包含本轮变更的隔离源码快照 build 与上述两组回归再次通过。
- 本轮没有修改前端，没有重跑前端构建、全量服务端测试或浏览器全站验收。
- 已修复项尚未发布；生产服务和现有任务状态保持不变。
