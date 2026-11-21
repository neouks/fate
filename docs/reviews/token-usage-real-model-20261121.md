# Token 与上下文真实模型核验（2026-11-21）

## 结论

使用现有配置 453（DeepSeek-Flash / `deepseek-flash`）完成真实付费请求。流式、非流式、缓存命中、Pi 原生压缩、压缩后续聊均已核对。供应商原始 usage、请求账本、API 累计值一致；上下文数值与 Pi `getContextUsage()` 一致。

发现并修复：原接口跳过压缩账本行，压缩后仍显示压缩前的 2,909 tokens；此时 Pi 已返回 `tokens: null`。现在显示“压缩后待校准”，下一次正常对话响应后才恢复数值。摘要请求仍计入累计消耗，且只计一次。

同时记录每次实际请求使用的模型窗口容量，避免随后修改配置或切换模型导致旧请求占用百分比的分母变化。历史记录缺少该容量时，界面明确提示分母按模型配置估算。弹窗及会话信息面板提供精确整数；工具栏百分比保留一位小数。

## 实测数据

输入总量已经包含缓存，累计总量 = 输入总量 + 输出，不能再加一次缓存。

| 场景 / 测试会话 | 物理请求 | 输入总量 | 非缓存输入 | 缓存读取 | 输出 | 累计总量 | 末次上下文 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 流式 + 自动压缩 / 1286 | 4 | 7,842 | 4,898 | 2,944 | 200 | 8,042 | 1,728 / 1,000,000 |
| 非流式 + 手动压缩 / 1287 | 4 | 7,844 | 4,900 | 2,944 | 205 | 8,049 | 1,732 / 1,000,000 |
| 实际 HTTP 完整链路 / 1285 | 2 | 4,877 | 2,061 | 2,816 | 15 | 4,892 | 2,461 / 1,000,000 |

前两组各包含一次真实压缩请求。流式组在压缩后累计为 6,314，上下文为未知；续聊后上下文校准为 1,728。非流式组在压缩后累计为 6,317，上下文为未知；续聊后为 1,732。

完整 HTTP 测试沿用真实配置（含思考设置），通过 `POST /api/conversations/:id/messages` 执行。第一条响应输出 13 tokens，Pi 记录其中 reasoning 为 11，未重复加算。第二次输入 2,459 = 非缓存 155 + 缓存 2,304，输出 2，因此上下文为 2,461。数据库同时有 provider 与 native_response 的 4 条原始记录，聚合正确去重为 2 次调用。

## 核验方法

- `apps/server/scripts/verify-session-usage-live.mts`：隔离测试会话，无工具，合成文本。通过 provider 事件捕获原始 `prompt_tokens`、`completion_tokens`、缓存命中数，逐阶段核对账本、真实 Fastify 路由和 Pi 原生上下文；核对请求数、压缩次数、缓存及累计值。
- 自动压缩仅在隔离测试 runner 中将阈值设为 1,800 tokens（窗口仍为 1,000,000），保留近期 128 tokens、摘要目标 256；避免为触发测试发送接近百万 tokens。没有修改正式模型配置或正式压缩阈值。
- 实际服务 8787 上创建并续聊测试会话 1285，核对持久化 JSONL 中的原生 usage、provider 账本与 HTTP 返回值。
- `web/tests/session-usage-live.mjs`：真实接口读取会话 1285，在桌面浅色、390px 手机浅色、桌面深色中断言每项 token 整数、缓存命中率、上下文分母和百分比；压缩状态 UI 使用上述真实压缩证据回放，明确不算额外模型调用。
- `web/tests/session-live.mjs`：真实任务 4902 的 `main:0`、`main:1`、`plan`、`intent:39304`，三种视图核验模型及用量显示，并验证 404、500、重试恢复与保存失败。本轮不向这些正式任务发送模型指令。
- `web/tests/conversation-controls.mjs`：Mock 三种视图验证共享组件、菜单、键盘操作、独立对话与 Main/Planner/Worker 控件。

## 验证结果与部署

- 后端生产构建通过；前端生产构建及 TypeScript 通过（23 路由）。
- 会话用量、会话模型隔离、费用算法共 13 项测试通过；修改前端文件 Biome 检查通过，`git diff --check` 通过。
- 三组真实用量 UI、三组真实任务 UI、三组 Mock UI 均通过，无页面脚本异常或横向溢出；已人工检查手机精确数值弹窗及桌面深色压缩状态截图。
- 8787 后端、3000 前端已更新；当前前端构建为 `.next-token-verified`。保持自动调度关闭。以后构建应使用新目录，避免覆盖正在服务的产物。

## 证据与复现

本地证据目录：`docs/reviews/evidence/token-usage-real-model-20261121/`（按仓库规则忽略，不包含密钥、请求认证头或真实用户消息正文）。

- `baseline.json`：修复前压缩上下文显示问题。
- `stream-auto-compaction.json`、`nonstream-manual-compaction.json`：原始供应商 usage、账本、API、Pi 上下文快照。
- `http-live-reconciled.json`：实际 HTTP、去重账本及原生 usage 核对。
- `fate-token-live/`、`fate-token-task/`、`fate-token-mock/`：界面截图。

从 `apps/server` 执行真实模型复验（会产生真实费用，保留测试会话）：

```sh
FATE_REAL_MODEL_TEST=1 FATE_PROFILE_ID=453 FATE_AUTO_COMPACT=1 \
FATE_USAGE_EVIDENCE=/tmp/fate-stream-usage.json \
./node_modules/.bin/tsx scripts/verify-session-usage-live.mts

FATE_REAL_MODEL_TEST=1 FATE_PROFILE_ID=453 FATE_NON_STREAMING=1 \
FATE_USAGE_EVIDENCE=/tmp/fate-nonstream-usage.json \
./node_modules/.bin/tsx scripts/verify-session-usage-live.mts
```

UI 脚本使用 `FATE_TEST_CONVERSATION`、`FATE_TEST_JWT_KEY_FILE`、`PLAYWRIGHT_MODULE`，可选 `FATE_COMPACTION_EVIDENCE`、`FATE_SCREENSHOTS`；默认访问 8787，仅做读取及浏览器局部回放。

## 准确性边界

已实测的供应商是当前 DeepSeek OpenAI 兼容接口，不能推广为所有模型均已实测。累计消耗以供应商返回 usage 为准；缺失或未核定请求不伪造为零或完整统计。

上下文是最近一次完整模型请求的输入（含缓存）加输出，包含供应商返回的思考输出口径；不是尚未提交的工具结果、附件、草稿的实时精确 token 数。压缩之后等待下一次响应校准。窗口容量来自该次请求实际使用的配置，并非供应商独立确认的物理上限。费用仍按用户填写单价估算，草稿仍是明确标注的字符估算，不等同于供应商账单或精确 tokenizer 结果。
