import urllib.request, json, time
base="http://144.123.22.234:9080/prod-api"
paths=[p.strip() for p in """ /tPost/page /tTopic/page /tComment/page /tGoods/page /tPostStatistics/page /tPostStatistics/lastTenDays
/csq/expTask/list /csq/expUser/list /csq/expVipModel/list /csq/expVipModel/all-sider /csq/zjyInfo/list /csq/expTaskLog/list /csq/expVipModelTicket/list /csq/expVipTicketPush/list /csq/expTaskModule/list /csq/expertExamine/list /csq/expertSetting/list
/qmd/black/list /qmd/good/list /qmd/join/list
/system/dict/data/list /system/notice/list /system/expLog/list /system/expTotal/list /monitor/operlog/list /monitor/logininfor/list /resource/oss/list /resource/oss/listByIds /resource/oss/config/list /system/social/list /tool/gen/list /watermark/list /system/config/list /system/role/list /system/user/list /system/post/list /system/dept/list /system/menu/list /system/client/list /system/tenant/package/list /system/dict/type/list /system/role/authUser/allocatedList /system/role/authUser/unallocatedList""".split()]
res=[]
for p in paths:
    body=json.dumps({"pageNum":1,"pageSize":10}).encode()
    req=urllib.request.Request(base+p,data=body,method='POST',headers={'User-Agent':'Mozilla/5.0','Content-Type':'application/json','Accept':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=15) as r: st=r.status; b=r.read(2000).decode('utf-8','replace')
    except urllib.error.HTTPError as e: st=e.code; b=e.read(2000).decode('utf-8','replace')
    except Exception as e: st=-1; b='ERR '+str(e)
    try: j=json.loads(b)
    except: j={}
    res.append((p,st,j.get('code'),(j.get('msg') or '')[:70],str(j.get('data'))[:120]))
    print(st,j.get('code'),p,'|',(j.get('msg') or '')[:60],'|',str(j.get('data'))[:100])
    time.sleep(0.35)
