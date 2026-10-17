import urllib.request, time, json
base="http://144.123.22.234:9080/prod-api"
T=[
 ("GET","/resource/oss/list?pageNum=1&pageSize=10",None),
 ("GET","/resource/oss/download/1",None),
 ("POST","/resource/oss/upload",'{"a":1}'),
 ("GET","/resource/oss/config/list",None),
 ("GET","/resource/oss/config/1",None),
 ("GET","/resource/file/list?pageNum=1&pageSize=10",None),
 ("GET","/system/oss/list",None),
 ("GET","/system/oss/config/list",None),
 ("GET","/system/notice/list?pageNum=1&pageSize=10",None),
 ("GET","/system/notice/1.html",None),
 ("GET","/resource/oss/1.html",None),
 ("POST","/auth/smsLogin",'{"phone":"13800000000","clientId":"7882175c171521a945ee6bdd5580377f","grantType":"sms"}'),
 ("POST","/auth/social/callback",'{"socialCode":"x","source":"gitee","clientId":"7882175c171521a945ee6bdd5580377f","grantType":"social"}'),
 ("GET","/auth/social/callback?code=x&source=gitee",None),
 ("GET","/auth/binding/gitee?tenantId=000000&domain=144.123.22.234",None),
 ("GET","/callback",None),
 ("POST","/notify",'{}'),
 ("GET","/open/api/list",None),
 ("GET","/export",None),
 ("GET","/system/user/export?pageNum=1",None),
 ("GET","/monitor/server",None),
 ("GET","/system/user/getInfo",None),
 ("GET","/system/menu/getRouters",None),
 ("GET","/tool/gen/list",None),
 ("GET","/system/client/1.html",None),
 ("GET","/system/social/list?pageNum=1",None),
]
out=[]
for m,p,d in T:
    url=base+p
    data=d.encode() if d is not None else None
    h={'User-Agent':'Mozilla/5.0','Accept':'application/json'}
    if data: h['Content-Type']='application/json'
    req=urllib.request.Request(url,data=data,method=m,headers=h)
    try:
        with urllib.request.urlopen(req,timeout=20) as r: st=r.status; body=r.read(900).decode('utf-8','replace')
    except urllib.error.HTTPError as e: st=e.code; body=e.read(900).decode('utf-8','replace')
    except Exception as e: st=-1; body='ERR:'+str(e)
    print(f"[{st}] {m} {p} :: {body[:260]}",flush=True)
    out.append({'method':m,'path':p,'status':st,'body':body})
    time.sleep(0.8)
json.dump(out,open('anonfamily.json','w'),ensure_ascii=False,indent=1)
