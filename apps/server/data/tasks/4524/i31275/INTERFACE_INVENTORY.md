# 144.123.22.234:9080 前端静态资源接口面清单 (intent #31275)

## 静态资源
- 首页 200, nginx/1.29.4, Last-Modified 2026-01-21, title=打卡蓬莱后台管理系统
- 构建: Vite SPA (#app, type=module), loader CSS 内联
- 入口 bundle: /assets/index-BbGssDPT.js (1,571,159 B)
- 样式: /assets/index-DZGrBffi.css (643,471 B)
- 分包: 无 .map (任一 /assets/*.js.map 均回落 index.html 5795B), /assets/ 目录列举 403
- 共引用 265 个 assets 文件(chunk/css/字体)，全部可下载，无软404
- 框架判定(推断, 非字符串证实): baseURL=/prod-api + Admin-Token + 多租户 tenantId + /system|/monitor|/tool/gen 模块布局 + 统一 {code,msg,data} 响应 = RuoYi-Vue-Plus 系定制版(前端 Vite+ElementPlus)
- bundle 内未见 RuoYi 版权字样(页脚已被定制)

## 硬编码配置/凭据类线索
- baseURL = /prod-api
- clientid = 7882175c171521a945ee6bdd5580377f (请求头 clientid 与 OAuth clientId 同值)
- token 存储键 Admin-Token, 头 Authorization: Bearer <token>
- 登录体: {tenantId, username, password, code, uuid, clientId, grantType:'password'}
- 注册体: {tenantId, username, password, confirmPassword, code, uuid, userType:'sys_user', clientId, grantType:'password'}
- 社交登录: maxkey/topiam/gitee/github/wechat → /auth/social/callback (grantType:'social')
- /auth/binding/{source}?tenantId=&domain=window.location.host (回调域可控)
- 未发现硬编码的第三方 appId/ak/sk 或内网 IP

## 匿名可访问接口(实测)
- GET /prod-api/auth/code → 200 captchaEnabled
- GET /prod-api/auth/tenant/list → 200 {"tenantEnabled":false,"voList":null}
- GET /prod-api/system/user/getInfo → {"code":401,"msg":"当前账号尚未登录..."}

## 接口清单 (统一前缀 /prod-api)
|方法|路径|来源chunk|
|---|---|---|
|?|%s is not a valid %s|el-form-item-CooA-DKb.js|
|GET|/auth/binding/|auth-pxiRZUVY.js|
|?|/auth/code|index-BbGssDPT.js|
|?|/auth/login|index-BbGssDPT.js|
|POST|/auth/logout|index-BbGssDPT.js|
|?|/auth/register|index-BbGssDPT.js|
|POST|/auth/social/callback|index-BbGssDPT.js|
|?|/auth/tenant/list|index-BbGssDPT.js|
|DELETE|/auth/unlock/|auth-pxiRZUVY.js|
|POST/PUT|/csq/expTask|index-DXlz8qNt.js|
|DELETE/GET|/csq/expTask/|index-DXlz8qNt.js|
|GET|/csq/expTask/list|index-DXlz8qNt.js|
|POST/PUT|/csq/expTaskLog|index-BCP0Awhb.js|
|DELETE|/csq/expTaskLog/|index-BCP0Awhb.js|
|GET|/csq/expTaskLog/list|index-BCP0Awhb.js|
|POST/PUT|/csq/expTaskModule|index-CTuh5PZ3.js|
|DELETE/GET|/csq/expTaskModule/|index-CTuh5PZ3.js|
|GET|/csq/expTaskModule/dropDown|index-CTuh5PZ3.js|
|GET|/csq/expTaskModule/list|index-CTuh5PZ3.js|
|POST/PUT|/csq/expUser|index-1PMPm7gS.js|
|GET|/csq/expUser/|index-1PMPm7gS.js|
|GET|/csq/expUser/list|index-1PMPm7gS.js|
|POST/PUT|/csq/expVipModel|index-DSfmCHGq.js|
|DELETE/GET|/csq/expVipModel/|index-DSfmCHGq.js|
|POST|/csq/expVipModel/all-sider|index-DSfmCHGq.js|
|GET|/csq/expVipModel/list|index-DSfmCHGq.js|
|POST/PUT|/csq/expVipModelTicket|index-BN2Dm0OT.js|
|DELETE/GET|/csq/expVipModelTicket/|index-BN2Dm0OT.js|
|GET|/csq/expVipModelTicket/list|index-BN2Dm0OT.js|
|POST/PUT|/csq/expVipTicketPush|index-Bqd2ue_3.js|
|DELETE/GET|/csq/expVipTicketPush/|index-Bqd2ue_3.js|
|GET|/csq/expVipTicketPush/list|index-Bqd2ue_3.js|
|POST/PUT|/csq/expertExamine|index-DH9PhJFB.js|
|DELETE|/csq/expertExamine/|index-DH9PhJFB.js|
|GET|/csq/expertExamine/examine|index-DH9PhJFB.js|
|GET|/csq/expertExamine/list|index-DH9PhJFB.js|
|POST/PUT|/csq/expertSetting|index-BRUHGUeK.js|
|DELETE/GET|/csq/expertSetting/|index-BRUHGUeK.js|
|GET|/csq/expertSetting/list|index-BRUHGUeK.js|
|POST/PUT|/csq/zjyInfo|index-SYETqZdr.js|
|DELETE/GET|/csq/zjyInfo/|index-SYETqZdr.js|
|GET|/csq/zjyInfo/dropDown|index-SYETqZdr.js|
|GET|/csq/zjyInfo/list|index-SYETqZdr.js|
|POST/PUT|/demo/demo|index-DGGEntOu.js|
|DELETE/GET|/demo/demo/|index-DGGEntOu.js|
|GET|/demo/demo/list|index-DGGEntOu.js|
|POST/PUT|/demo/tree|index-Dk8en2qG.js|
|DELETE/GET|/demo/tree/|index-Dk8en2qG.js|
|GET|/demo/tree/list|index-Dk8en2qG.js|
|GET|/monitor/cache|index-DcjyVz_K.js|
|DELETE|/monitor/logininfor/|index-xycV9eS8.js|
|DELETE|/monitor/logininfor/clean|index-xycV9eS8.js|
|GET|/monitor/logininfor/list|index-xycV9eS8.js|
|GET|/monitor/logininfor/unlock/|index-xycV9eS8.js|
|GET|/monitor/online|index-CQPA2R3I.js|
|DELETE/POST|/monitor/online/|index-CQPA2R3I.js|
|GET|/monitor/online/list|index-CQPA2R3I.js|
|DELETE|/monitor/operlog/|index-CvBe3tHi.js|
|DELETE|/monitor/operlog/clean|index-CvBe3tHi.js|
|GET|/monitor/operlog/list|index-CvBe3tHi.js|
|?|/prod-api/resource/oss/upload|index.vue_vue_type_style_index_0_lang-9jMJPQSh.js|
|?|/prod-api/system/user/importData|index-TDesKUzJ.js|
|POST/PUT|/qmd/black|index-B9BaoKtt.js|
|DELETE/GET|/qmd/black/|index-B9BaoKtt.js|
|GET|/qmd/black/list|index-B9BaoKtt.js|
|GET|/qmd/black/single/black/num|index-B9BaoKtt.js|
|POST|/qmd/black/single/black/num?num=|index-B9BaoKtt.js|
|POST/PUT|/qmd/good|index-NgYXAhYb.js|
|DELETE/GET|/qmd/good/|index-NgYXAhYb.js|
|GET|/qmd/good/list|index-NgYXAhYb.js|
|POST/PUT|/qmd/join|index-CWPJf-XA.js|
|GET|/qmd/join/list|index-CWPJf-XA.js|
|DELETE|/resource/oss/|index-CHT4sSQC.js|
|POST/PUT|/resource/oss/config|config-DDfiZB2z.js|
|DELETE/GET|/resource/oss/config/|config-DDfiZB2z.js|
|PUT|/resource/oss/config/changeStatus|config-DDfiZB2z.js|
|GET|/resource/oss/config/list|config-DDfiZB2z.js|
|GET|/resource/oss/list|index-CHT4sSQC.js|
|GET|/resource/oss/listByIds/|index-CHT4sSQC.js|
|POST/PUT|/system/client|index-Bb9TUMq3.js|
|DELETE/GET|/system/client/|index-Bb9TUMq3.js|
|PUT|/system/client/changeStatus|index-Bb9TUMq3.js|
|GET|/system/client/list|index-Bb9TUMq3.js|
|POST/PUT|/system/config|index-BbGssDPT.js|
|DELETE/GET|/system/config/|index-BbGssDPT.js|
|GET|/system/config/configKey/|index-BbGssDPT.js|
|GET|/system/config/list|index-BbGssDPT.js|
|DELETE|/system/config/refreshCache|index-BbGssDPT.js|
|PUT|/system/config/updateByKey|index-BbGssDPT.js|
|POST/PUT|/system/dept|index-COqiO9RA.js|
|DELETE/GET|/system/dept/|index-COqiO9RA.js|
|GET|/system/dept/list|index-COqiO9RA.js|
|GET|/system/dept/list/exclude/|index-COqiO9RA.js|
|GET|/system/dept/treeselect|index-COqiO9RA.js|
|POST/PUT|/system/dict/data|index-BbGssDPT.js|
|DELETE/GET|/system/dict/data/|index-BbGssDPT.js|
|GET|/system/dict/data/list|index-BbGssDPT.js|
|GET|/system/dict/data/type/|index-BbGssDPT.js|
|POST/PUT|/system/dict/type|index-DrA9-nyp.js|
|DELETE/GET|/system/dict/type/|index-DrA9-nyp.js|
|GET|/system/dict/type/list|index-DrA9-nyp.js|
|GET|/system/dict/type/optionselect|index-DrA9-nyp.js|
|DELETE|/system/dict/type/refreshCache|index-DrA9-nyp.js|
|POST/PUT|/system/expLog|index-BdHSGdnN.js|
|DELETE/GET|/system/expLog/|index-BdHSGdnN.js|
|GET|/system/expLog/list|index-BdHSGdnN.js|
|POST/PUT|/system/expTotal|index-6s3HeRL2.js|
|DELETE/GET|/system/expTotal/|index-6s3HeRL2.js|
|GET|/system/expTotal/list|index-6s3HeRL2.js|
|POST/PUT|/system/menu|index-D8wNi1sM.js|
|DELETE/GET|/system/menu/|index-D8wNi1sM.js|
|GET|/system/menu/getRouters|index-BbGssDPT.js|
|GET|/system/menu/list|index-D8wNi1sM.js|
|GET|/system/menu/roleMenuTreeselect/|index-D8wNi1sM.js|
|GET|/system/menu/tenantPackageMenuTreeselect/|index-D8wNi1sM.js|
|GET|/system/menu/treeselect|index-D8wNi1sM.js|
|POST/PUT|/system/notice|index-BkHWUVql.js|
|DELETE/GET|/system/notice/|index-BkHWUVql.js|
|GET|/system/notice/list|index-BkHWUVql.js|
|POST/PUT|/system/post|index-BilwSwgZ.js|
|DELETE/GET|/system/post/|index-BilwSwgZ.js|
|GET|/system/post/list|index-BilwSwgZ.js|
|GET|/system/post/optionselect|index-BilwSwgZ.js|
|POST/PUT|/system/role|index-C0rN6YVO.js|
|DELETE/GET|/system/role/|index-C0rN6YVO.js|
|GET|/system/role/authUser/allocatedList|index-C0rN6YVO.js|
|PUT|/system/role/authUser/cancel|index-C0rN6YVO.js|
|PUT|/system/role/authUser/cancelAll|index-C0rN6YVO.js|
|PUT|/system/role/authUser/selectAll|index-C0rN6YVO.js|
|GET|/system/role/authUser/unallocatedList|index-C0rN6YVO.js|
|PUT|/system/role/changeStatus|index-C0rN6YVO.js|
|PUT|/system/role/dataScope|index-C0rN6YVO.js|
|GET|/system/role/deptTree/|index-C0rN6YVO.js|
|GET|/system/role/list|index-C0rN6YVO.js|
|GET|/system/role/optionselect?roleIds=|index-C0rN6YVO.js|
|GET|/system/social/list|auth-pxiRZUVY.js|
|POST/PUT|/system/tenant|index-BbGssDPT.js|
|DELETE/GET|/system/tenant/|index-BbGssDPT.js|
|PUT|/system/tenant/changeStatus|index-BbGssDPT.js|
|GET|/system/tenant/dynamic/|index-BbGssDPT.js|
|GET|/system/tenant/dynamic/clear|index-BbGssDPT.js|
|GET|/system/tenant/list|index-BbGssDPT.js|
|POST/PUT|/system/tenant/package|index-D2TX-oVd.js|
|DELETE/GET|/system/tenant/package/|index-D2TX-oVd.js|
|PUT|/system/tenant/package/changeStatus|index-D2TX-oVd.js|
|GET|/system/tenant/package/list|index-D2TX-oVd.js|
|GET|/system/tenant/package/selectList|index-D2TX-oVd.js|
|GET|/system/tenant/syncTenantDict|index-BbGssDPT.js|
|GET|/system/tenant/syncTenantPackage|index-BbGssDPT.js|
|POST/PUT|/system/user|index-9vGwsWwT.js|
|DELETE/GET|/system/user/|index-9vGwsWwT.js|
|PUT|/system/user/authRole|index-9vGwsWwT.js|
|GET|/system/user/authRole/|index-9vGwsWwT.js|
|PUT|/system/user/changeStatus|index-9vGwsWwT.js|
|GET|/system/user/deptTree|index-9vGwsWwT.js|
|GET|/system/user/getInfo|index-BbGssDPT.js|
|GET|/system/user/list|index-9vGwsWwT.js|
|GET|/system/user/list/dept/|index-9vGwsWwT.js|
|GET|/system/user/optionselect?userIds=|index-9vGwsWwT.js|
|GET/PUT|/system/user/profile|index-9vGwsWwT.js|
|POST|/system/user/profile/avatar|index-9vGwsWwT.js|
|PUT|/system/user/profile/updatePwd|index-9vGwsWwT.js|
|PUT|/system/user/resetPwd|index-9vGwsWwT.js|
|POST|/tComment/agree/|index-Me5sKArJ.js|
|POST|/tComment/audit|index-Me5sKArJ.js|
|POST|/tComment/del/|index-Me5sKArJ.js|
|POST|/tComment/disagree/|index-Me5sKArJ.js|
|GET|/tComment/getone/|index-Me5sKArJ.js|
|POST|/tComment/notop/|index-Me5sKArJ.js|
|GET|/tComment/page|index-Me5sKArJ.js|
|POST|/tComment/top|index-Me5sKArJ.js|
|POST|/tGoods/add|index-BGZAQJDj.js|
|POST|/tGoods/del/|index-BGZAQJDj.js|
|GET|/tGoods/getone/|index-BGZAQJDj.js|
|GET|/tGoods/page|index-BGZAQJDj.js|
|POST|/tGoods/update|index-BGZAQJDj.js|
|POST|/tPost/add|index-C-m5kS2G.js|
|POST|/tPost/agree/|index-C-m5kS2G.js|
|POST|/tPost/audit|index-C-m5kS2G.js|
|POST|/tPost/del/|index-C-m5kS2G.js|
|POST|/tPost/disagree/|index-C-m5kS2G.js|
|POST|/tPost/excellent|index-C-m5kS2G.js|
|GET|/tPost/getone/|index-C-m5kS2G.js|
|POST|/tPost/noexcellent/|index-C-m5kS2G.js|
|POST|/tPost/notop/|index-C-m5kS2G.js|
|GET|/tPost/page|index-C-m5kS2G.js|
|POST|/tPost/setgoods|index-C-m5kS2G.js|
|POST|/tPost/top/|index-C-m5kS2G.js|
|POST|/tPost/update|index-C-m5kS2G.js|
|GET|/tPostStatistics/lastTenDays|index-C8WAdW7Z.js|
|GET|/tPostStatistics/page|index-C8WAdW7Z.js|
|POST|/tTopic/add|index-DK9fYAhh.js|
|POST|/tTopic/del/|index-DK9fYAhh.js|
|GET|/tTopic/getone/|index-DK9fYAhh.js|
|GET|/tTopic/list|index-DK9fYAhh.js|
|GET|/tTopic/page|index-DK9fYAhh.js|
|POST|/tTopic/update|index-DK9fYAhh.js|
|PUT|/tool/gen|index-0NJhR3nr.js|
|DELETE/GET|/tool/gen/|index-0NJhR3nr.js|
|GET|/tool/gen/db/list|index-0NJhR3nr.js|
|GET|/tool/gen/genCode/|index-0NJhR3nr.js|
|GET|/tool/gen/getDataNames|index-0NJhR3nr.js|
|POST|/tool/gen/importTable|index-0NJhR3nr.js|
|GET|/tool/gen/list|index-0NJhR3nr.js|
|GET|/tool/gen/preview/|index-0NJhR3nr.js|
|GET|/tool/gen/synchDb/|index-0NJhR3nr.js|
|POST/PUT|/watermark|index-CAewmEyI.js|
|DELETE/GET|/watermark/|index-CAewmEyI.js|
|GET|/watermark/list|index-CAewmEyI.js|
|POST/PUT|/workflow/category|index-Cj_qZCp3.js|
|DELETE/GET|/workflow/category/|index-Cj_qZCp3.js|
|GET|/workflow/category/list|index-Cj_qZCp3.js|
|GET|/workflow/definitionConfig/getByDefId/|index-9VhOFbP4.js|
|POST|/workflow/definitionConfig/saveOrUpdate|index-9VhOFbP4.js|
|POST/PUT|/workflow/formManage|index-D6nEJZFT.js|
|DELETE/GET|/workflow/formManage/|index-D6nEJZFT.js|
|GET|/workflow/formManage/list|index-D6nEJZFT.js|
|GET|/workflow/formManage/list/selectList|index-D6nEJZFT.js|
|POST/PUT|/workflow/leave|index-B4u_QGQ4.js|
|DELETE/GET|/workflow/leave/|index-B4u_QGQ4.js|
|GET|/workflow/leave/list|index-B4u_QGQ4.js|
|DELETE|/workflow/model/|index-aVTt7lXu.js|
|POST|/workflow/model/copyModel|index-aVTt7lXu.js|
|PUT|/workflow/model/editModelXml|index-aVTt7lXu.js|
|GET|/workflow/model/getInfo/|index-aVTt7lXu.js|
|GET|/workflow/model/list|index-aVTt7lXu.js|
|POST|/workflow/model/save|index-aVTt7lXu.js|
|PUT|/workflow/model/update|index-aVTt7lXu.js|
|POST|/workflow/processDefinition/deployByFile|index-q9_gBSWh.js|
|GET|/workflow/processDefinition/list|index-q9_gBSWh.js|
|POST|/workflow/processInstance/deleteRunInstance|index-BUdQnq-9.js|
|GET|/workflow/processInstance/getPageByCurrent|index-BUdQnq-9.js|
|GET|/workflow/processInstance/getPageByFinish|index-BUdQnq-9.js|
|GET|/workflow/processInstance/getPageByRunning|index-BUdQnq-9.js|
|POST|/workflow/task/addMultiInstanceExecution|index-Cn42W7HZ.js|
|POST|/workflow/task/backProcess|index-Cn42W7HZ.js|
|POST|/workflow/task/completeTask|index-Cn42W7HZ.js|
|POST|/workflow/task/delegateTask|index-Cn42W7HZ.js|
|POST|/workflow/task/deleteMultiInstanceExecution|index-Cn42W7HZ.js|
|GET|/workflow/task/getListByDeleteMultiInstance/|index-Cn42W7HZ.js|
|GET|/workflow/task/getPageByAllTaskFinish|index-Cn42W7HZ.js|
|GET|/workflow/task/getPageByAllTaskWait|index-Cn42W7HZ.js|
|GET|/workflow/task/getPageByTaskCopy|index-Cn42W7HZ.js|
|GET|/workflow/task/getPageByTaskFinish|index-Cn42W7HZ.js|
|GET|/workflow/task/getPageByTaskWait|index-Cn42W7HZ.js|
|GET|/workflow/task/getTaskById/|index-Cn42W7HZ.js|
|GET|/workflow/task/getTaskUserIdsByAddMultiInstance/|index-Cn42W7HZ.js|
|POST|/workflow/task/startWorkFlow|index-Cn42W7HZ.js|
|POST|/workflow/task/terminationTask|index-Cn42W7HZ.js|
|POST|/workflow/task/transferTask|index-Cn42W7HZ.js|

## 导出/下载端点 (resource.download → /prod-api/<path>)

- GET /prod-api/csq/expTaskLog/export.xlsx? (Excel 导出)
- GET /prod-api/csq/expUser/export.xlsx? (Excel 导出)
- GET /prod-api/csq/expVipModel/export.xlsx? (Excel 导出)
- GET /prod-api/csq/expVipModelTicket/export.xlsx? (Excel 导出)
- GET /prod-api/csq/expertExamine/export.xlsx? (Excel 导出)
- GET /prod-api/csq/zjyInfo/export.xlsx? (Excel 导出)
- GET /prod-api/demo/demo/export.xlsx? (Excel 导出)
- GET /prod-api/monitor/logininfor/export.xlsx? (Excel 导出)
- GET /prod-api/monitor/operlog/export.xlsx? (Excel 导出)
- GET /prod-api/qmd/black/export.xlsx? (Excel 导出)
- GET /prod-api/qmd/good/export.xlsx? (Excel 导出)
- GET /prod-api/system/client/export.xlsx? (Excel 导出)
- GET /prod-api/system/config/export.xlsx? (Excel 导出)
- GET /prod-api/system/dict/data/export.xlsx? (Excel 导出)
- GET /prod-api/system/dict/type/export.xlsx? (Excel 导出)
- GET /prod-api/system/expLog/export.xlsx? (Excel 导出)
- GET /prod-api/system/expTotal/export.xlsx? (Excel 导出)
- GET /prod-api/system/expVipTicketPush/export.xlsx? (Excel 导出)
- GET /prod-api/system/post/export.xlsx? (Excel 导出)
- GET /prod-api/system/role/export.xlsx? (Excel 导出)
- GET /prod-api/system/tenant/export.xlsx? (Excel 导出)
- GET /prod-api/system/tenant/package/export.xlsx? (Excel 导出)
- GET /prod-api/system/user/export.xlsx? (Excel 导出)
- GET /prod-api/system/user/importTemplate.xlsx? (Excel 导出)
- GET /prod-api/tPost/export.xlsx? (Excel 导出)
- GET /prod-api/tPostStatistics/export.xlsx? (Excel 导出)
- GET /prod-api/workflow/formManage/export.xlsx? (Excel 导出)
- GET /prod-api/workflow/leave/export.xlsx? (Excel 导出)

## 上传端点
- POST /prod-api/resource/oss/upload (multipart, 头带 Bearer+clientid)
- POST /prod-api/resource/oss/upload (富文本编辑器内嵌)
- POST /prod-api/system/user/importData?updateSupport=0/1 (xls/xlsx 导入)
- POST /prod-api/system/user/profile/avatar
- POST /prod-api/workflow/processDefinition/deployByFile (BPMN 文件上传)
- POST /prod-api/workflow/model/save

## 高风险组件入口(后续验证输入)
- /prod-api/tool/gen/* 代码生成器 (db/list 可读库表结构, preview 可读模板, importTable/synchDb 写操作)
- /prod-api/monitor/cache (Redis 缓存监控)
- /prod-api/resource/oss/config* (OSS accessKey/secretKey 明文配置)
- /prod-api/system/config/configKey/{key}, /system/config/updateByKey
- /prod-api/system/tenant/dynamic/{id}, /system/tenant/syncTenantDict|syncTenantPackage
- /prod-api/monitor/online/{tokenId} 强退, /monitor/logininfor/unlock/{key}, /auth/unlock/{key}
- 业务模块: /csq/exp* (expUser/expTask/expVipModel/expVipModelTicket), /qmd/black|good|join, /tPost|tTopic|tComment|tGoods, /watermark, /workflow/*, /snail-job, /admin/applications

## 前端路由(78个 view)

chenh/comment/index, chenh/goods/index, chenh/post/index, chenh/postStatistics/index, chenh/topic/index, demo/demo/index, demo/tree/index, error/401, error/404, exp/expLog/index, exp/expTask/index, exp/expTaskLog/index, exp/expTaskModule/index, exp/expTotal/index, exp/expUser/index, exp/expVipModel/index, exp/expVipModelTicket/SideBar, exp/expVipModelTicket/index, exp/expVipTicketPush/index, exp/expertExamine/index, exp/expertSetting/index, exp/watermark/index, exp/zjyInfo/index, index, login, monitor/admin/index, monitor/cache/index, monitor/logininfor/index, monitor/online/index, monitor/operlog/index, monitor/snailjob/index, qmd/black/index, qmd/good/index, qmd/join/index, redirect, redirect/index, register, system/client/index, system/config/index, system/dept/index, system/dict/data, system/dict/index, system/menu/index, system/notice/index, system/oss/config, system/oss/index, system/post/index, system/role/authUser, system/role/index, system/role/selectUser, system/tenant/index, system/tenantPackage/index, system/user/authRole, system/user/index, system/user/profile/index, system/user/profile/onlineDevice, system/user/profile/resetPwd, system/user/profile/thirdParty, system/user/profile/userAvatar, system/user/profile/userInfo, tool/gen/basicInfoForm, tool/gen/editTable, tool/gen/genInfoForm, tool/gen/importTable, tool/gen/index, workflow/category/index, workflow/formManage/index, workflow/leave/index, workflow/leave/leaveEdit, workflow/model/index, workflow/processDefinition/components/processPreview, workflow/processDefinition/index, workflow/processInstance/index, workflow/task/allTaskWaiting, workflow/task/myDocument, workflow/task/taskCopyList, workflow/task/taskFinish, workflow/task/taskWaiting