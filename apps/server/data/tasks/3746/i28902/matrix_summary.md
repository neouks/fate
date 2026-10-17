# intent 28902 — actuator 变体矩阵（无 Authorization，仅 GET，间隔≥1.6s）

| # | path | status | len | WWW-Authenticate | body(前120) |
|---|---|---|---|---|---|
|01|/prod-api/actuator;.js|401|51|Basic Realm=Sa-Token|{"code":401,"msg":"no basic auth","data":null}|
|02|/prod-api/actuator;.js/env|401|51|Basic Realm=Sa-Token|同上|
|03|/prod-api/actuator;.js/health|401|51|Basic Realm=Sa-Token|同上|
|04|/prod-api/actuator;.js/heapdump|401|51|Basic Realm=Sa-Token|同上|
|05|/prod-api/actuator;.js/configprops|401|51|Basic Realm=Sa-Token|同上|
|06|/prod-api/actuator;.js/mappings|401|51|Basic Realm=Sa-Token|同上|
|07|/prod-api/actuator/env;.js|403|555(nnginx html)|-|403 Forbidden (nginx/1.29.4)|
|08|/prod-api/actuator/env.js|403|555|-|403 Forbidden|
|09|/prod-api/actuator;.html/env|401|51|Basic Realm=Sa-Token|no basic auth|
|10|/prod-api/actuator;.css/env|401|51|Basic Realm=Sa-Token|no basic auth|
|11|/prod-api/%61ctuator;.js/env|401|51|Basic Realm=Sa-Token|no basic auth|
|12|/prod-api/actuator%3B.js/env|401|51|Basic Realm=Sa-Token|no basic auth|
|13|/prod-api/actuator/..;/actuator;.js/env|403|555|-|403 Forbidden|
|14|/prod-api/actuator|403|555|-|403 Forbidden (基线)|
|15|/prod-api/actuator;.js/zzz-not-exist-9x8z|401|51|Basic Realm=Sa-Token|no basic auth|
|16|/prod-api/actuator;.js/actuator;.js/env|401|51|Basic Realm=Sa-Token|no basic auth|
|C1|/prod-api/zzz-no-such-9x8z;.js/env|200|—|-|{"code":404,"msg":"No endpoint GET /zzz-no-such-9x8z;.js/env."}（鉴权已越过）|
|C2|/prod-api/actuatorx;.js/env|200|—|-|{"code":404,"msg":"No endpoint GET /actuatorx;.js/env."}|
|C3|/prod-api/system/user/list;.js|200|—|-|{"code":401,"msg":"当前账号尚未登录，请登录后继续操作"}|

Basic 认证 3 组（各 1 次，均 401 同一文案，未再扩大）：
admin:admin / admin:123456 / actuator:actuator → {"code": 401, "msg": "no basic auth", "data": null}

## 结论
- 无任何变体返回 JSON 配置数据（无 propertySources/names/status）。
- `/actuator/**` 前缀被 Sa-Token 的 HTTP Basic 规则单独保护（对照组证明 Basic 401 是该前缀专属、与"是否存在该端点"无关：不存在的 /actuator;.js/zzz-not-exist 也 401 no basic auth；而同样 ;.js 的非 actuator 路径已越过鉴权返回 404 No endpoint）。
- nginx 对 `/prod-api/actuator`（不带 ;xxx 后缀）单独 403（555 字节 nginx 页），与 app 401 差异仅来自 nginx location 规则；两者 server 头均为 nginx/1.29.4，均无 x-content-type-options。
