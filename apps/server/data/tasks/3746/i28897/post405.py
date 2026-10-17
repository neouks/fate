import urllib.request, json, time, sys, os

base = "http://144.123.22.234:9080/prod-api"
paths = [l.strip() for l in open('test_list.txt') if l.strip()]
out = open('post405_results.jsonl', 'w')

def post(path, body=b'{}'):
    url = base + path
    req = urllib.request.Request(url, data=body, method='POST', headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    })
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            st = r.status; b = r.read(3000).decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        st = e.code; b = e.read(3000).decode('utf-8', 'replace')
    except Exception as e:
        st = -1; b = 'ERR ' + str(e)
    return st, b, round(time.time() - t0, 2)

for p in paths:
    st, b, el = post(p)
    try:
        j = json.loads(b); code = j.get('code'); msg = (j.get('msg') or '')[:200]; data = j.get('data')
    except Exception:
        code = None; msg = b[:200]; data = None
    rec = {'path': p, 'http': st, 'code': code, 'msg': msg, 'data': str(data)[:300], 'body': b[:600], 'el': el}
    out.write(json.dumps(rec, ensure_ascii=False) + '\n'); out.flush()
    print(f"HTTP{st} code={code} {p} :: {msg[:150]} || data={str(data)[:120]}", flush=True)
    time.sleep(1.2)
out.close()
print("DONE", len(paths))
