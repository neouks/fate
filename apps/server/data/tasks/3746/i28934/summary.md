# i28934 /auth/register 注册开放性最小判定 —— 终局

## 执行
- (1) 零请求前置：i28884/chunks/register-CPqzC2W-.js 与 api_inventory.tsv 确认注册表单字段
  tenantId/username/password/confirmPassword/code/uuid/userType，提交路径 /auth/register；
  index 主包路由含 register（lazy import ./register-CPqzC2W-.js）→ 前端页面公开可达，且**无任何“注册已关闭”的静态判断**。
- (2)(3) 本轮之前本意图已完成的实打请求（见本目录 probe.log / register_base.json / code_base.json / cap_base.png）：
  GET /auth/code（带 X-Forwarded-For 绕过 IP 限流）→ 200，ddddocr beta/std 一致识别 '9+4' → ans=13；
  POST /auth/register 完整体 → HTTP 200 {"code":500,"msg":"当前系统没有开启注册功能！","data":null}
  ⇒ 命中判定分支 c，按意图要求立即收手：不做第 2 次注册、不做登录取 token、不做参数越权（步骤 4/5/6 全部不执行）。

## 结论
后台注册功能关闭（sys.account.registerUser 配置门），"自建账号→登录取 token→读后台数据"链不成立。
写回：fact 28940（增补前端页面可见性）+ 既有 fact 28939（负结论本体）。未报 finding。
