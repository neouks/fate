import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {targetFetch} from '../evidence/target-transport.js';
import {upstreamAgent} from './upstream.js';
test('SOCKS5 upstream routes target HTTP through remote DNS in both task transports',{timeout:15000},async t=>{
 const target=http.createServer((_q,r)=>r.end('proxied'));
 await new Promise<void>(r=>target.listen(0,'127.0.0.1',r));
 const sockets=new Set<net.Socket>();let connections=0;
 const socks=net.createServer(s=>{
  sockets.add(s);s.on('close',()=>sockets.delete(s));let state=0,buffer=Buffer.alloc(0);
  const handshake=(data:Buffer)=>{buffer=Buffer.concat([buffer,data]);
   if(state===0){if(buffer.length<2||buffer.length<2+buffer[1]!)return;buffer=buffer.subarray(2+buffer[1]!);s.write(Buffer.from([5,0]));state=1;}
   if(state===1){if(buffer.length<5)return;const type=buffer[3],length=type===1?4:type===3?buffer[4]!:16,offset=type===3?5:4;if(buffer.length<offset+length+2)return;const port=buffer.readUInt16BE(offset+length);const head=buffer.subarray(offset+length+2);state=2;s.removeListener('data',handshake);connections++;
    const remote=net.connect(port,'127.0.0.1',()=>{s.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));if(head.length)remote.write(head);s.pipe(remote);remote.pipe(s);});remote.on('error',()=>s.destroy());s.on('close',()=>remote.destroy());
   }
  };s.on('data',handshake);
 });await new Promise<void>(r=>socks.listen(0,'127.0.0.1',r));
 t.after(()=>{for(const s of sockets)s.destroy();socks.close();target.closeAllConnections();target.close();});
 const url=`http://fixture.invalid:${(target.address() as net.AddressInfo).port}/`;
 for(const protocol of ['socks5','socks5h']){
  const proxy=`${protocol}://127.0.0.1:${(socks.address() as net.AddressInfo).port}`;
  assert.equal(await (await targetFetch(url,{method:'GET',headers:{},redirect:'manual'},proxy)).text(),'proxied');
  const agent=upstreamAgent(proxy,false);try{const body=await new Promise<string>((resolve,reject)=>{http.get(url,{agent},r=>{let body='';r.on('data',b=>body+=b);r.on('end',()=>resolve(body));}).on('error',reject);});assert.equal(body,'proxied');}finally{agent.destroy();}
 }
 assert.equal(connections,4);
});
