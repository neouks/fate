import urllib.request, json, time

base = "http://144.123.22.234:9080/prod-api"

def send(method, path, body, ctype, extra=None):
    h = {'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Content-Type': ctype}
    if extra: h.update(extra)
    req = urllib.request.Request(base + path, data=body, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            st = r.status; b = r.read(3000).decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        st = e.code; b = e.read(3000).decode('utf-8', 'replace')
    except Exception as e:
        st = -1; b = 'ERR ' + str(e)
    print(f"== {method} {path} [{ctype}] -> HTTP{st}\n{b[:600]}\n")
    return st, b

# 1) malformed JSON on a protected POST endpoint
send('POST', '/system/user', b'{', 'application/json')
time.sleep(1.2)
# 2) malformed JSON on another
send('POST', '/system/notice', b'{', 'application/json')
time.sleep(1.2)

# 3) multipart with empty file part on avatar
boundary = '----wb1234567890'
part = (
    f'--{boundary}\r\n'
    'Content-Disposition: form-data; name="avatarfile"; filename="x.txt"\r\n'
    'Content-Type: text/plain\r\n\r\n'
    '\r\n'
    f'--{boundary}--\r\n'
).encode()
send('POST', '/system/user/profile/avatar', part, f'multipart/form-data; boundary={boundary}')
