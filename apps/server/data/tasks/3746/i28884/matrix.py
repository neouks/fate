import urllib.request, json, time, sys
base="http://144.123.22.234:9080/prod-api"
paths=[l.strip() for l in open('test_list.txt') if l.strip()]
out=open('matrix_results.jsonl','w')
for i,p in enumerate(paths,1):
    url=base+p
    req=urllib.request.Request(url,method='GET',headers={'User-Agent':'Mozilla/5.0','Accept':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=15) as r:
            st=r.status; body=r.read(2000).decode('utf-8','replace'); hdr=dict(r.headers)
    except urllib.error.HTTPError as e:
        st=e.code; body=e.read(2000).decode('utf-8','replace')
    except Exception as e:
        st=-1; body='ERR:'+str(e)
    rec={'path':p,'status':st,'body':body[:600]}
    out.write(json.dumps(rec,ensure_ascii=False)+'\n'); out.flush()
    if st!=401:
        print(f"[{st}] {p} :: {body[:240]}")
    time.sleep(0.35)
out.close()
print("DONE",len(paths))
