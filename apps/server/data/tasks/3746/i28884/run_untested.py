import urllib.request, time, json
base="http://144.123.22.234:9080/prod-api"
paths=[l.strip() for l in open('untested.txt') if l.strip()]
paths=[p for p in paths if p.startswith('/prod-api/') is False]
out=[]
for p in paths:
    req=urllib.request.Request(base+p,method='GET',headers={'User-Agent':'Mozilla/5.0','Accept':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=15) as r: st=r.status; body=r.read(600).decode('utf-8','replace')
    except urllib.error.HTTPError as e: st=e.code; body=e.read(600).decode('utf-8','replace')
    except Exception as e: st=-1; body='ERR:'+str(e)
    out.append({'path':p,'status':st,'body':body})
    tag='401' if '"code":401' in body else '**'
    print(f"{tag} [{st}] {p} :: {body[:150]}",flush=True)
    time.sleep(0.45)
json.dump(out,open('matrix_untested.jsonl','w'),ensure_ascii=False)
print('done',len(out))
