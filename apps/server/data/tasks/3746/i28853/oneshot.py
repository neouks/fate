#!/usr/bin/env python3
"""Single-shot login attempt: one /auth/code -> OCR -> compute -> one /auth/login."""
import urllib.request, urllib.error, json, base64, re, sys, time
import ddddocr

BASE='http://144.123.22.234:9080/prod-api'
CLIENT_ID='7882175c171521a945ee6bdd5580377f'
std=ddddocr.DdddOcr(show_ad=False)
beta=ddddocr.DdddOcr(beta=True,show_ad=False)

def parse(t):
    t=(t.replace('×','*').replace('✕','*').replace('x','*').replace('X','*')
         .replace('＋','+').replace('一','-').replace('—','-'))
    m=re.search(r'(\d)\s*([+\-*])\s*(\d)',t)
    if not m: return None
    a,op,c=int(m.group(1)),m.group(2),int(m.group(3))
    return {'+':a+c,'-':a-c,'*':a*c}[op], '%d%s%d'%(a,op,c)

def main(user,pw,tag):
    t=urllib.request.urlopen(BASE+'/auth/code',timeout=20).read().decode()
    d=json.loads(t)
    print('CODE_RESP',t[:120])
    if d.get('code')!=200 or not d.get('data'):
        print('ABORT_NO_CODE'); return
    data=d['data']; uuid=data['uuid']
    img=base64.b64decode(data['img'])
    open('cap_%s.png'%tag,'wb').write(img)
    tb=beta.classification(img); ts=std.classification(img)
    print('OCR beta=%r std=%r'%(tb,ts))
    ans=None; expr=None
    for t2 in (tb,ts):
        p=parse(t2)
        if p: ans,expr=p; break
    if ans is None:
        print('OCR_FAIL_NO_ANSWER'); return
    print('EXPR',expr,'ANS',ans,'UUID',uuid)
    body={"tenantId":"000000","username":user,"password":pw,"code":str(ans),
          "uuid":uuid,"clientId":CLIENT_ID,"grantType":"password"}
    req=urllib.request.Request(BASE+'/auth/login',data=json.dumps(body).encode(),
        headers={'Content-Type':'application/json;charset=utf-8','clientid':CLIENT_ID})
    try:
        r=urllib.request.urlopen(req,timeout=20); st=r.status; txt=r.read().decode()
    except urllib.error.HTTPError as e:
        st=e.code; txt=e.read().decode()
    print('LOGIN_REQ',json.dumps(body))
    print('LOGIN_RESP',st,txt[:1500])
    open('login_%s.json'%tag,'w').write(json.dumps({'req':body,'status':st,'resp':txt}))

if __name__=='__main__':
    main(sys.argv[1],sys.argv[2],sys.argv[3] if len(sys.argv)>3 else 'x')
