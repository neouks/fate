import urllib.request, json, time

base = "http://144.123.22.234:9080/prod-api"

def send(method, path, body=b'{}'):
    h = {'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Content-Type': 'application/json'}
    data = body if method in ('PUT', 'POST', 'PATCH') else None
    req = urllib.request.Request(base + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            st = r.status; b = r.read(2000).decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        st = e.code; b = e.read(2000).decode('utf-8', 'replace')
    except Exception as e:
        st = -1; b = 'ERR ' + str(e)
    print(f"== {method} {path} -> HTTP{st} :: {b[:300]}")
    return st, b

tests = [
    ('PUT', '/system/user/profile/updatePwd'),      # body {} -> expect 401
    ('PUT', '/monitor/logininfor/unlock'),          # body {} -> expect 401
    ('PUT', '/system/role/authUser/cancel'),        # body {} -> expect 401
    ('DELETE', '/resource/oss/0'),                  # id 0 nonexistent
    ('DELETE', '/monitor/operlog/0'),
    ('DELETE', '/monitor/logininfor/0'),
    ('POST', '/auth/smsLogin'),
    ('POST', '/auth/emailLogin'),
    ('POST', '/resource/sms/code'),                 # empty body: must not send SMS
]
res = []
for m, p in tests:
    st, b = send(m, p)
    res.append({'method': m, 'path': p, 'http': st, 'body': b[:400]})
    time.sleep(1.3)
json.dump(res, open('safe_probe.json', 'w'), ensure_ascii=False, indent=1)
