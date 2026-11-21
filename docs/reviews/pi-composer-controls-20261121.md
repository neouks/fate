# pi-web 会话输入区与控制项适配回归（2026-11-21）

本次按 pi-web 参考页面的输入区、推理强度菜单、工具预设、压缩、提示音和移动端控件布局完成适配。参考实现为 `be11335fcd8d155c690ef2a72826d145e5f77896`，许可证说明见 [pi-web-reference-license.txt](pi-web-reference-license.txt)。

## 交付内容

- 独立对话与任务的 Main Agent、Planner、Worker 共用同一套会话控制组件和 composer 布局。
- 推理强度和工具预设使用项目统一的 shadcn Select/Popover/Button；菜单支持键盘操作、选中态、深浅色和移动端“更多控件”。
- 控制项通过后端 API 持久化，按会话隔离；配置对下一次执行生效。工具预设只会收窄当前角色已获准的工具，不会绕过角色权限。
- 接入 Pi 原生压缩流程、停止压缩、压缩并发闸门和上下文占用刷新；压缩期间输入区锁定，停止后保留草稿。
- 完成提示音使用浏览器 Web Audio，并保留本地开关；删除舒适排版、紧凑排版相关功能代码。

## 实际模型验证

使用真实 `deepseek-flash` 配置完成：

- `off` 推理：reasoning tokens 为 `0`。
- `xhigh` 推理：真实响应产生 `49` reasoning tokens。
- 工具预设在 chat-only 配置下实际工具列表为空，未超出角色权限。
- Pi 原生手动压缩：1 次压缩调用，输入 `15,340`、输出 `278`、总计 `15,618` tokens；压缩后继续请求成功，记录上下文 `23,488 / 1,000,000`。
- 压缩测试使用显式合成历史 JSONL 触发容量场景，未伪造可计费账本；压缩和继续请求均使用实际模型。

完整原始证据：[fate-session-controls-live.json](evidence/pi-composer-controls-20261121/fate-session-controls-live.json)。

## 回归结果

| 检查 | 结果 |
| --- | --- |
| 后端生产构建 | 通过 |
| 前端生产构建与 TypeScript | 通过，部署目录 `.next-pi-controls-v3` |
| 6 个共享组件与辅助模块 Biome 检查 | 通过 |
| 会话配置、用量路由、模型策略等定向测试 | 22 项通过 |
| 独立对话桌面/手机/深色菜单 | 通过 |
| 任务 Main/Planner/Worker 会话隔离 | 通过，原配置已恢复 |
| 保存失败、压缩中锁定、停止压缩、草稿保留 | 通过 |
| 真实模型推理、工具和压缩 | 通过 |
| `git diff --check` | 通过 |

扩大到现有页面文件的 Biome 检查仍报告格式、导入顺序和 nursery 规则问题，因此不将本次结果表述为全仓 lint 通过；本次未批量改写包含其他未提交工作的页面。

自动化脚本：`web/tests/pi-composer-controls.mjs`、`web/tests/pi-composer-states.mjs`、`web/tests/session-live.mjs`；实际模型脚本：`apps/server/scripts/verify-session-controls-live.mts`。

截图证据位于 [evidence/pi-composer-controls-20261121](evidence/pi-composer-controls-20261121/)。当前访问入口为 `http://127.0.0.1:8787`，调度器保持关闭。

## 适配边界

本实现对齐参考页面的核心输入区与控制交互。会话设置采用本项目的角色权限和“下次执行生效”模型；没有宣称覆盖 pi-web 的全部外围功能，也没有用一次测试代表所有模型供应商均已验证。
