import assert from 'node:assert/strict';
import {test} from 'node:test';
import http from 'node:http';
import {spawn} from 'node:child_process';

test('MCP search proxy does not replace vetted-address HTTP transport',async()=>{
  let proxyCalls=0,directCalls=0;
  const origin=http.createServer((_req,res)=>{directCalls++;res.end('direct');});
  const proxy=http.createServer((_req,res)=>{proxyCalls++;res.end('proxied');});
  // EnvHttpProxyAgent tunnels even plain HTTP through CONNECT.
  proxy.on('connect',(_req,socket)=>{
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data',()=>{proxyCalls++;socket.end('HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied');});
  });
  await Promise.all([new Promise<void>(r=>origin.listen(0,'127.0.0.1',r)),new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r))]);
  try{
    const url=(s:http.Server)=>`http://127.0.0.1:${(s.address() as {port:number}).port}`;
    const script=`import http from 'node:http';const a=await(await fetch('http://proxy-check.invalid/')).text();const b=await new Promise((resolve,reject)=>http.get(${JSON.stringify(url(origin))},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>resolve(s));}).on('error',reject));console.log(JSON.stringify([a,b]));`;
    const child=spawn(process.execPath,['--import',new URL('./mcp-fetch-proxy.mjs',import.meta.url).href,'--input-type=module','-e',script],{
      env:{...process.env,FATE_MCP_FETCH_PROXY:'1',NODE_USE_ENV_PROXY:'0',HTTP_PROXY:url(proxy),HTTPS_PROXY:url(proxy),NO_PROXY:'',http_proxy:url(proxy),https_proxy:url(proxy),no_proxy:''},stdio:['ignore','pipe','pipe'],
    });
    let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
    const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    assert.equal(code,0,stderr);assert.deepEqual(JSON.parse(stdout),['proxied','direct']);
    assert.equal(proxyCalls,1);assert.equal(directCalls,1);
  }finally{origin.closeAllConnections();proxy.closeAllConnections();await Promise.all([new Promise<void>(r=>origin.close(()=>r())),new Promise<void>(r=>proxy.close(()=>r()))]);}
});
