import urllib.request, urllib.error, time, json

base="http://144.123.22.234:9080"
UA="Mozilla/5.0 (compatible; pentest-whitelist/1.0)"

def req(method, path, body=None, ctype="application/json"):
    url=base+path
    data=None
    headers={"User-Agent":UA}
    if body is not None:
        data=body.encode()
        headers["Content-Type"]=ctype
    r=urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            b=resp.read()
            return resp.status, b.decode('utf-8','replace')
    except urllib.error.HTTPError as e:
        b=e.read()
        return e.code, b.decode('utf-8','replace')
    except Exception as e:
        return -1, "ERR:"+repr(e)

# (method, path, body)
tests=[
 ("GET","/prod-api/auth/tenant/list",None),
 ("GET","/prod-api/auth/logout",None),
 ("GET","/prod-api/auth/social/callback",None),
 ("GET","/prod-api/system/tenant/list",None),
 ("GET","/prod-api/system/dict/type/optionselect",None),
 ("GET","/prod-api/system/config/configKey/sys.account.captchaEnabled",None),
 ("GET","/prod-api/resource/oss/download/1",None),
 ("GET","/prod-api/monitor/online/list",None),
 ("GET","/prod-api/monitor/online/",None),
 ("GET","/prod-api/monitor/online/1",None),
 ("GET","/prod-api/common/download/resource?resource=test.txt",None),
 ("GET","/prod-api/common/download?fileName=test.txt&delete=false",None),
 ("GET","/prod-api/system/user/register",None),
 ("POST","/prod-api/auth/logout","{}"),
 ("POST","/prod-api/auth/smsLogin","{}"),
 ("POST","/prod-api/system/user/register","{}"),
 ("POST","/prod-api/auth/social/callback","{}"),
]

out=[]
for m,p,b in tests:
    st,body=req(m,p,b)
    snippet=body.replace("\n"," ").strip()[:300]
    line=f"[{st}] {m} {p} :: len={len(body)} :: {snippet}"
    print(line, flush=True)
    out.append({"method":m,"path":p,"status":st,"len":len(body),"snippet":snippet})
    time.sleep(1.6)

with open("whitelist_results.json","w") as f:
    json.dump(out,f,ensure_ascii=False,indent=1)
print("DONE")
