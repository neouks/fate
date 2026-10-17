# /dev-api vs /prod-api 配置差异面 对比表（全部无 Authorization、只读 GET、间隔 ≥1.6s）

| # | path (dev) | status | bytes | app code/msg | WWW-Authenticate | path (prod) | status | bytes | app code/msg | WWW-Authenticate |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline | /dev-api/auth/code | 200 | 2791 | {"code":200,data.captchaEnabled=true,uuid+img} | - | /prod-api/auth/code | 200 | 3467 | 同结构(长度随机) | - |
| alias proof | /dev-api/zzz-no-such-9x8z | 200 | 67 | {"code":404,"msg":"No endpoint GET /zzz-no-such-9x8z."} | - | - | - | - | 非 SPA 兜底(5795) → 确已反代到同一后端 |
| nginx 403 | /dev-api/actuator | 403 | 153 | nginx/1.29.4 403 页 | - | /prod-api/actuator | 403 | 153 | 同 | - |
| nginx 403 | /dev-api/actuator/env | 403 | 153 | 同上 | - | - | - | - | - |
| nginx 403 | /dev-api/actuator/health | 403 | 153 | 同上 | - | - | - | - | - |
| 绕过 nginx 后 | /dev-api/actuator;.js/env | 401 | 51 | {"code":401,"msg":"no basic auth"} | Basic Realm=Sa-Token | /prod-api/actuator;.js/env | 401 | 51 | 同 | Basic Realm=Sa-Token |
| springdoc | /dev-api/v3/api-docs | 200 | 62 | {"code":404,"msg":"No endpoint GET /v3/api-docs."} | - | /prod-api/v3/api-docs | 200 | 62 | 同 | - |
| springdoc | /dev-api/v3/api-docs/swagger-config | 200 | 77 | No endpoint | - | - | - | - | - |
| swagger-ui | /dev-api/swagger-ui/index.html | 200 | 72 | No endpoint | - | - | - | - | - |
| swagger | /dev-api/swagger-resources | 200 | 68 | No endpoint | - | - | - | - | - |
| knife4j | /dev-api/doc.html | 200 | 59 | No endpoint | - | - | - | - | - |
| webjars | /dev-api/webjars/js/app.js | 200 | 62 | {"code":500,"msg":"No static resource js/app.js."} | - | /prod-api/webjars/js/app.js | 200 | 62 | 同 | - |
| druid | /dev-api/druid/index.html | 200 | 67 | No endpoint GET /druid/index.html. | - | /prod-api/druid/index.html | 200 | 67 | 同 | - |
| druid | /dev-api/druid/login.html | 200 | 67 | No endpoint | - | - | - | - | - |
| 业务受保护 | /dev-api/system/user/list | 200 | 84 | {"code":401,"msg":"当前账号尚未登录..."} | - | /prod-api/system/user/list | 200 | 84 | 同 | - |
| 业务受保护 | /dev-api/monitor/online/list | 200 | 84 | 同 401 | - | - | - | - | - |
| 白名单 | /dev-api/auth/tenant/list | 200 | 78 | {"code":200,data:{tenantEnabled:false,voList:null}} | - | /prod-api/auth/tenant/list | 200 | 78 | 逐字相同 | - |
