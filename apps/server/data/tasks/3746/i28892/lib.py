#!/usr/bin/env python3
import urllib.request, urllib.error, json, base64, re, time, sys
import ddddocr
BASE='http://144.123.22.234:9080/prod-api'
CLIENT_ID='7882175c171521a945ee6bdd5580377f'
std=None; beta=None
def ocr_engines():
    global std,beta
    if std is None:
        std=ddddocr.DdddOcr(show_ad=False)
        beta=ddddocr.DdddOcr(beta=True,show_ad=False)
    return std,beta
def parse(t):
    t=(t.replace('×','*').replace('✕','*').replace('x','*').replace('X','*')
         .replace('＋','+').replace('一','-').replace('—','-').replace(' ',''))
    m=re.search(r'(\d)\s*([+\-*])\s*(\d)',t)
    if not m: return None
    a,op,c=int(m.group(1)),m.group(2),int(m.group(3))
    return {'+':a+c,'-':a-c,'*':a*c}[op], '%d%s%d'%(a,op,c)
def get_code():
    t0=time.time()
    t=urllib.request.urlopen(BASE+'/auth/code',timeout=20).read().decode()
    dt=time.time()-t0
    d=json.loads(t)
    if d.get('code')!=200 or not d.get('data'):
        return None,t,d,dt
    data=d['data']; uuid=data['uuid']; img=base64.b64decode(data['img'])
    s,b=ocr_engines()
    tb=b.classification(img); ts=s.classification(img)
    ans=expr=None
    for t2 in (tb,ts):
        p=parse(t2)
        if p: ans,expr=p; break
    return {'uuid':uuid,'img':img,'ans':ans,'expr':expr,'ocr':(tb,ts)},t,d,dt
def post_json(path, body, extra_headers=None):
    hdr={'Content-Type':'application/json;charset=utf-8','clientid':CLIENT_ID}
    if extra_headers: hdr.update(extra_headers)
    req=urllib.request.Request(BASE+path,data=json.dumps(body,ensure_ascii=False).encode(),
        headers=hdr)
    t0=time.time()
    try:
        r=urllib.request.urlopen(req,timeout=60); st=r.status; txt=r.read().decode()
    except urllib.error.HTTPError as e:
        st=e.code; txt=e.read().decode()
    except Exception as e:
        return None,str(e),time.time()-t0
    return st,txt,time.time()-t0
def get(path):
    t0=time.time()
    try:
        r=urllib.request.urlopen(BASE+path,timeout=60); st=r.status; txt=r.read().decode()
    except urllib.error.HTTPError as e:
        st=e.code; txt=e.read().decode()
    except Exception as e:
        return None,str(e),time.time()-t0
    return st,txt,time.time()-t0
def login_with(overrides, tag, baseline_username='no_such_user_9x8z'):
    """overrides: dict of body field -> value (raw, may be list/dict)."""
    cap,_,_,_=get_code()
    if not cap:
        print('[%s] NO_CAPTCHA'%tag); return None
    if cap['ans'] is None:
        print('[%s] OCR_FAIL %r'%(tag,cap['ocr'])); return None
    body={"tenantId":"000000","username":baseline_username,"password":"Zz9!notreal",
          "code":str(cap['ans']),"uuid":cap['uuid'],"clientId":CLIENT_ID,"grantType":"password"}
    body.update(overrides)
    st,txt,dt=post_json('/auth/login',body)
    print('[%s] t=%.2fs st=%s body=%s'%(tag,dt,st,json.dumps(body,ensure_ascii=False)[:400]))
    print('[%s] RESP %s %s'%(tag,st,(txt or '')[:700].replace('\n',' ')))
    open('log_%s.txt'%tag,'w').write(json.dumps({'body':body,'status':st,'resp':txt,'time':dt},ensure_ascii=False,indent=1))
    return st,txt,dt
