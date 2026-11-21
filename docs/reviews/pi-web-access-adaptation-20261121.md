# pi-web-access 平台适配

日期：2026-11-21。扩展固定为 `pi-web-access@0.48.0`，使用本仓库的 PI 1.5.2。

## 实现结果

已完成源码替换。旧平台搜索、正文抽取与分页实现已移除，旧 `web_read` 退出工具目录；`web_search` 名称保留，由扩展执行，并新增 `fetch_content`、`get_search_content`。旧 MCP `web_search` 预设已删除。

系统配置中的「网络搜索」可管理总开关、供应商白名单与回退顺序、默认供应商、各供应商 API Key、SearXNG 地址、独立代理和 Agent 授权。当前支持 DeepSeek、Exa、Brave、Tavily、博查、Jina、SearXNG、DuckDuckGo。测试按钮使用当前表单值和同一扩展执行路径，不保存临时凭证。接口仅返回凭证是否存在。

已有工具启停、Agent 绑定和加载方式仍然生效。配置保存后，下一次工具调用使用新配置；执行中的请求使用开始时的配置。搜索摘要不是已读正文，正文通过扩展工具显式读取。

## 运行与会话适配

上游使用模块级配置和结果缓存，不能通过简单重建扩展实例实现隔离与配置更新。平台为每个 PI 会话建立独立 Node Worker，仅在 Worker 中执行上游注册的工具；模型循环继续由现有 PI Runner 管理。配置指纹变化时替换 Worker，保留该会话的磁盘缓存。

扩展 `web-search-results` 自定义条目写入 PI 原生会话。读取正文前验证 responseId 属于当前分支，恢复会话后可继续读取缓存。平台负责授权、生命周期、取消和结果归属，搜索供应商、正文抽取与分页由上游实现。

本次开放公开 HTTP(S) 抓取与 readable/raw 模式；不开放本地文件、视频/模型回答、curator、后台 includeContent 等流程。旧 web_read 的块偏移不能用于新工具；新调用使用扩展原生 responseId、offset 和 nextOffset。

## 数据迁移

一次性事务迁移先备份旧 MCP 和工具配置，再删除 MCP `web_search`、相关可见性和旧 `web_read`。新正文工具继承旧阅读工具的授权和停用状态，不扩大已有授权。旧非 DeepSeek 默认来源需重新选择并测试，迁移时关闭总开关并显示说明。

当前 `series` 数据库已执行迁移，确认旧 MCP 与旧 web_read 记录均为 0，迁移标记已写入。后续启动不会重新插入旧 MCP 预设。迁移之后用户自行新增的同名 MCP 不会在每次启动时被删除。

## 验证

- 服务端和前端 TypeScript 检查通过。
- 40 项工具运行、加载与设置接口回归通过，覆盖配置更新、正文分页、会话恢复、跨会话拒绝、授权限制、取消和凭证隐藏。
- 隔离 PostgreSQL 中的迁移及重启检查通过（2 项）。
- Node 22.19.0 下扩展运行与设置接口检查通过（4 项）。
- 真实免 Key Exa 搜索成功返回 TypeScript 官方 Handbook 和对应 GitHub 文档；未据此宣称其他供应商账号或网络可用。
- 浏览器检查已确认新设置页正常显示供应商、凭证、代理、Agent 和测试控件；使用独立 mock 预览，未提交真实设置。
- 独立临时构建成功，Worker、schema 和迁移 JSON 均进入产物；编译后的 Worker 成功加载并执行原生内容读取调用。

## 交付状态

2026-11-21 已按用户追加要求更新本机 8787 平台并完成真实模型验收。后端仅部署搜索适配相关模块，Runner 在原运行版本上合入搜索生命周期改动，保留其他后端行为；前端使用当前工作区构建到独立 `.next-web-access-live` 目录。原后端产物与原前端构建保留。后续扩展配置修改本身不需要重启服务。

在任务 4902 主 Agent 会话 #2，真实 deepseek-flash 模型完成 Exa 搜索（3 条结果）、TypeScript 官方 Narrowing 正文抓取（36352 字符）、typeof 检索（回执 matchCount=19）和分页续读（11763–23763）。首次调用被暂停保护拒绝；随后临时切换手动模式并恢复执行，四次网页工具调用均成功。验证后已恢复 paused=true、execution_mode=managed；没有派发 Worker 或修改漏洞/事实。网络搜索已通过平台启用，默认供应商为 Exa，保留 DeepSeek 可选来源和原有 Agent 授权。

证据：`docs/reviews/evidence/web-access-real-20261121/`，含原生模型/工具回执、截图、任务状态前后对比和部署文件清单。页面模型总结把关键词命中写成 6 组；原生工具 details 的 matchCount 和 returnedMatches 均为 19，以工具回执为准。

初始可行性脚本 `apps/server/scripts/spike-pi-web-access.mts` 保留作为历史诊断；正式集成的验证以 `src/search/web-access.test.ts`、`src/http/routes/web-search.test.ts` 和 `scripts/evaluate-web-access-migration.mts` 为准。

来源：[npm 0.48.0](https://www.npmjs.com/package/pi-web-access/v/0.48.0)、[上游仓库](https://github.com/nicobailon/pi-web-access)。

## 自定义搜索范围：最小原生适配

设置页新增「默认搜索站点」，例如 `cnblogs.com, csdn.net`，前缀 `-` 表示排除，留空不限。最多 20 个域名，保存时校验并去重。平台只在 `web_search` 省略 `domainFilter` 时填入默认值；模型显式参数优先，包括用 `[]` 恢复全网搜索。它是搜索偏好，不是访问权限白名单；不约束 fetch_content。测试按钮同样读取当前表单范围，不会保存测试值。

Bing 沿用 pi-web-access 的 SearXNG provider：在自己的 SearXNG 实例中启用 Bing，然后配置实例根地址并允许 JSON 搜索响应。上游不接收平台自定义 engines 参数，根地址里的查询参数也会被上游去除，因此平台不增加一个假 Bing provider，也不拼装 Bing 抓取接口。未配置可用 SearXNG 实例时不能宣称 Bing 已可用。

工具名、模型工具 schema 和上游搜索实现保持兼容；没有新增搜索工具或任意 HTTP 搜索适配器。

此次最小适配已部署到本机 8787。5 项扩展/设置回归全部通过，前后端类型检查及生产构建通过。真实平台测试中，DeepSeek 在 cnblogs.com 范围返回 3 条博客园结果（3307 ms）；Exa 免 Key 路径遇到供应商限流，未将其记为通过。测试表单没有保存，正式默认站点仍为空（全网），默认供应商仍为 Exa。没有可用的自建 SearXNG 实例，因此本次只验证了其原生调用与域名过滤兼容性，不宣称真实 Bing 搜索已验证。证据保存在 `docs/reviews/evidence/web-sites-20261121/`。

## 搜索预设

设置页提供 Bing（通过 SearXNG）、博客园、CSDN 三个快捷预设，只填入既有配置字段，不增加后端接口或工具参数。博客园/CSDN 分别填入 cnblogs.com/csdn.net，保留当前供应商；Bing 启用并选择 SearXNG、清空站点范围，需要用户提供已启用 Bing 的实例。预设不是自动保存，支持先测试再保存；SearXNG 实际使用哪些引擎仍由实例配置决定。
