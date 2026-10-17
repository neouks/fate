# /login 只读抓取与解析报告

## 抓取
GET http://144.123.22.234:9080/login  -> 200, 5795 bytes
server: nginx/1.29.4 ; content-type: text/html ; last-modified: Wed, 21 Jan 2026 00:49:35 GMT ; etag "6970229f-16a3"
无 Set-Cookie，未提交任何凭据/表单。

原始 HTML: ./login.html （含响应头的原始文本: ./login_resp.txt）

## 页面性质
<title>打卡蓬莱后台管理系统</title>
body 内只有一个空容器 <div id="app"> + 加载动画 #loader-wrapper（"正在加载系统资源，请耐心等待"）。
**HTML 中不存在任何 <form>、<input>、<button>、label、placeholder** —— 登录表单完全由前端 JS 在运行时渲染；
因此表单 method/action/字段名均不出现在 HTML 里，判定为"由 JS 接管（前端 axios/fetch 提交，非原生 form submit）"。置信度：observed(无 form/input) + inferred(具体提交端点在 JS bundle 内)。

## 前端资源清单（全部同源 144.123.22.234:9080）
| 资源 | 路径 | 类型/属性 | 实测 |
|---|---|---|---|
| JS 入口 | /assets/index-BbGssDPT.js | <script type="module" crossorigin src> | 200, 1,571,159 B, application/javascript |
| 样式 | /assets/index-DZGrBffi.css | <link rel="stylesheet" crossorigin href> | 200, 643,471 B, text/css |
| 站点图标 | /favicon.ico | <link rel="icon" href> | 200, 28,810 B, image/x-icon |
| IE 兼容跳转页 | /html/ie.html | 条件注释内联脚本 `window.location.href='/html/ie.html'`（仅 IE<11 触发） | 200 但内容与 index.html 完全相同（5795 B、同 etag 6970229f-16a3）→ nginx history 模式 SPA fallback，非独立页面 |

无 img / manifest / preload / apple-touch-icon / 外链 CDN 资源；所有资源均为根相对路径（origin = 同源），无跨域第三方域名。

## 指纹推断
- 哈希化 `index-*.js` + `type="module" crossorigin` + 根相对 /assets → Vite 打包单页应用（inferred）。
- 中文后台系统标题"打卡蓬莱后台管理系统"，典型的若依/Element-Plus 风格后台前端（标题与结构推断，未经 JS 内容核实）。
- nginx 对任意不存在路径回落 index.html（由 /html/ie.html 实测证明），说明 history 路由模式。

## 交给规划者
登录字段与登录 API 路径必须从 /assets/index-BbGssDPT.js 提取（已由意图 #31249 覆盖，本意图不重复执行）。
