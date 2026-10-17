import lib,time,json
cap=None
for i in range(4):
    c,t,d,dt=lib.get_code()
    if c and c['ans'] is not None:
        cap=c; break
    print('retry_code', (t or '')[:80]); time.sleep(6)
if cap:
    body={'tenantId':'000000','username':'no_such_user_9x8z','password':'Zz9!notreal','code':str(cap['ans']),'uuid':cap['uuid'],'clientId':"7882175c171521a945ee6bdd5580377f'",'grantType':"password'"}
    st,txt,dt2=lib.post_json('/auth/login',body)
    print('OCR',cap['ocr'],'EXPR',cap['expr'])
    print('st',st,'%.2fs'%dt2)
    print((txt or '')[:900])
    open('log_11_grant_client_quote.txt','w').write(json.dumps({'body':body,'status':st,'resp':txt,'time':dt2},ensure_ascii=False,indent=1))
else:
    print('NO_CODE')
