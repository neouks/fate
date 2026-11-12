# MCP 与 Skill 配置、装配及调用复核（2026-11-12）

> 本文保留配置审查阶段的原始证据与当时限制；后续统计修复、中文提交及安全发布结果见 [原生调用统计验收](native-resource-usage-20261112.md)。

本轮在主工作区增量修改，保留其他未提交内容。验证仅使用本机协议服务、原生 pi 的 faux provider 和浏览器合成 API；没有真实模型调用、外部目标请求或生产配置写入。结论针对当前源码，生产 8787／5173 尚未加载本轮修复。

## 已修复

| 问题 | 修复与证据 |
| --- | --- |
| MCP／Skill 角色勾选使用数据库 ID，而接口实际接收角色 key | 编辑与新建统一使用 key，保留数字主键作为 DOM 标识；浏览器验证 Worker 的 ID=77、key=worker 时保存正确 |
| MCP 参数编辑损坏含空格的参数 | 去除数组 join 后按空格拆分的往返转换；改为 JSON 字符串数组编辑。带空格的脚本路径和参数测试、保存均原样保留 |
| MCP 测试与保存对非法配置处理不一致 | 传输工厂、测试和保存共用校验，非法 URL、非字符串 args/env、空命令提前报错；不再在探针中默默转成字符串 |
| 工具刷新失败被显示为“发现 0 个工具” | API 客户端检查兼容响应的 error 并抛出，由现有错误反馈展示；连接失败不能作为没有工具的依据 |
| 仅提供 resource 的 MCP 被强制执行 tools/list | 根据原生 capabilities 决定是否列工具；本地 resource-only 服务成功返回 0 个工具 |
| Legacy SSE 尚未收到 endpoint 时关闭，start 仍等待超时 | 关闭时拒绝待完成的 ready promise，取消流读取；本地测试确认快速退出 |
| Skill 元数据序列化破坏冒号、井号、多行文本及布尔字段 | 使用 pi 导出的 YAML 解析器，采用 YAML 兼容的 JSON 值序列化；编辑关联 MCP 后多行描述及其他元数据保持完整 |
| Skill 目录绑定与 frontmatter name 不一致时静默漏加载 | 按明确绑定目录加载，内存中以目录身份命名并给出诊断；不改写用户文件。同名别名的两个目录不会相互覆盖 |
| Skill 管理展示与原生加载结果不一致 | 列表返回 loadable/model_visible/diagnostics；缺失或非法 SKILL.md 可见且说明原因。取消默认目录自动发现，显式绑定由 override 装配 |
| Skill 路径校验仅做字符串边界判断 | 管理读写、装配和兼容扫描共用路径校验，拒绝子路径符号链接、硬链接及越界；绑定文档读取回归通过 |
| Skill 详情缺少 usage_agents 时崩溃、缺少 calls 时出现 NaN | 前端容忍缺失统计字段，显示“未记录”；不再以不存在的统计证明“从未调用” |
| Skill 关联 MCP 的说明承诺了不存在的自动解锁 | 明确为依赖说明，运行仍需要角色显式 MCP 绑定；新建和详情两处文案同步 |
| Skill 已创建但初始角色绑定失败时，重复创建会撞重名 | 分别处理文件保存与绑定结果，提示已创建及绑定失败角色，可在详情重试绑定 |
| 390px Skill 详情被固定目录树挤压 | 窄屏在列表／详情之间切换，提供返回入口；桌面保留双栏 |

认证头处理移到共享传输工厂：HTTP／SSE 的 env 请求头与 headers 使用相同逻辑。原管理测试入口已经传递认证头，因此这项属于统一与防回归，不记作原有认证遗漏。

主要位置：`agent/skill-files.ts`、`agent/resources.ts`、`agent/tool-loading.ts`、`pi/runner.ts`、`pi/mcpTransport.ts`、`http/routes/config.ts`、`http/routes/mcp-mgmt.ts`、`http/routes/skills-mgmt.ts`，以及 MCP／Skill 管理页和 API 客户端。

## 原有装配机制复核

- 七类角色读取明确绑定的 Skill；MCP 仍遵循既有角色边界，没有扩大 Goals／Reporter 权限。
- 服务总开关、单工具 hidden、角色绑定及 tool_search 禁用后的 direct 回退按现有策略生效。
- stdio、Streamable HTTP、legacy SSE 本地测试均覆盖发现及实际工具调用。
- 原生 pi 延迟发现、调用、旧会话恢复后撤销权限已验证；撤销后本地 MCP 调用次数没有增加。
- MCP 不可用时，内部 deferred 工具仍能通过原生搜索加载并调用；响应明确标注 MCP 发现未完成。中文空匹配提示英文名称检索。
- Skill 内容由原生 read 按需读取，没有增加新的 Skill 工具或复制模型循环。

## 验证记录

- MCP／Skill 专项 15 项通过，0 失败、0 跳过。包含目录别名、YAML 保真、路径隔离、七角色装配、保存校验、三种传输、恢复撤销、断线搜索与读取边界。
- `src` 下现有 18 个 `.test.ts`：38 通过、11 跳过、0 失败。跳过项需要专用隔离 PostgreSQL，涉及其他业务的目标核验、文件、报告及模板；不能计为本轮通过，也不等于执行了全部历史测试脚本。
- 后端类型检查与正式构建通过；前端类型检查与独立目录正式构建通过。
- 浏览器使用 `/tmp/fate-mcp-skill-web` 隔离正式产物，1440px 浅色及 390px 深色；全部 API 被合成拦截。验证编辑／新增 Skill 绑定、缺失元数据、MCP 参数保真、测试、保存及刷新错误反馈。
- 浏览器回归：`web/tests/mcp-skills-config.mjs`；后端专项：`src/pi/mcp-resources.test.ts`、`src/agent/skill-config.test.ts`、`src/agent/skill-read.test.ts`。
- 日志：`/tmp/fate-mcp-skill-{tests,special,server-build,build,browser}.log`；截图：`/tmp/fate-mcp-skill-screens/`。开发浮层曾遮挡窄屏按钮，改为正式产物复验；失败运行不计通过。

## 未验证及后续限制

- 未逐个连接用户已配置的真实 MCP 服务；实际可用性仍取决于本机可执行文件、依赖、凭据、网络及服务器协议。未覆盖 OAuth 交互登录和第三方服务的非标准行为。
- `mcp_usage/skill_usage` 是迁移前账本，当前原生 pi 调用未完整写入。已纠正界面的假零值与文案，但未将其改造为完整的原生调用计量系统；确认调用应查看执行活动和工具结果。
- 文件校验不是主机沙箱，不能宣称阻止所有由本机其他进程发起的文件替换竞争；本轮未实现 ZIP 安装的跨进程事务发布。
- 本轮未做数据库迁移、未改写已有 Skill、未改变工具权限和任务调度、未重启生产服务。全部改动仍在工作区，尚未提交或发布。
