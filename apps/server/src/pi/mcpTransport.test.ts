import {describe,it,expect} from 'vitest';
import http from 'node:http';
import https from 'node:https';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {McpClient} from '@earendil-works/pi-mcp';
import {createServerTransport} from './mcpTransport.js';

async function fixture(transport:'http'|'sse',tls=false){
 let stream:http.ServerResponse|undefined;
 const received:string[]=[];
 const handler:http.RequestListener=async(req,res)=>{
  if(req.method==='DELETE'){res.writeHead(204).end();return;}
  if(req.method==='GET'){
   if(transport==='http'){res.writeHead(405).end();return;}
   stream=res;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: endpoint\ndata: /messages\n\n');return;
  }
  let body='';for await(const chunk of req)body+=chunk;
  const m=JSON.parse(body);received.push(m.method);
  if(m.id==null){res.writeHead(202).end();return;}
  let result:unknown={};
  if(m.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
  if(m.method==='tools/list')result={tools:[{name:'echo',description:'fixture',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]};
  if(m.method==='tools/call'){
   if(m.params.arguments.text==='wait'){res.writeHead(202).end();return;}
   result={content:[{type:'text',text:m.params.arguments.text}]};
  }
  const response=JSON.stringify({jsonrpc:'2.0',id:m.id,result});
  if(transport==='sse'){stream!.write(`event: message\ndata: ${response}\n\n`);res.writeHead(202).end();}
  else res.writeHead(200,{'Content-Type':'application/json'}).end(response);
 };
 const dir=mkdtempSync(tmpdir()+'/mcp-fixture-');
 let server:http.Server;
 if(tls){execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',dir+'/key','-out',dir+'/cert','-days','1','-subj','/CN=localhost'],{stdio:'ignore'});server=https.createServer({key:readFileSync(dir+'/key'),cert:readFileSync(dir+'/cert')},handler);}
 else server=http.createServer(handler);
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`${tls?'https':'http'}://127.0.0.1:${(server.address() as {port:number}).port}/mcp`;
 return {url,received,close:async()=>{stream?.end();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}};
}
describe('shared MCP transports',()=>{
 it.each(['http','sse'] as const)('%s supports native handshake, calls, cancellation and close',async transport=>{
  const fixtureServer=await fixture(transport),client=new McpClient({name:'test',version:'1',requestTimeoutMs:2000});
  try{
   await client.connect(createServerTransport({transport,url:fixtureServer.url},process.cwd()));
   expect((await client.listTools())[0]?.name).toBe('echo');
   expect((await client.callTool('echo',{text:'native'})).content).toContainEqual({type:'text',text:'native'});
   const abort=new AbortController(),pending=client.callTool('echo',{text:'wait'},{signal:abort.signal});
   setTimeout(()=>abort.abort(),30);await expect(pending).rejects.toThrow();
   await client.close();expect(client.connectionState).toBe('closed');
  }finally{await client.close();await fixtureServer.close();}
 });
 it('insecure TLS is scoped to the configured server',async()=>{
  const server=await fixture('http',true),client=new McpClient({name:'test',version:'1',requestTimeoutMs:2000});
  try{
   await expect(fetch(server.url)).rejects.toThrow();
   await client.connect(createServerTransport({transport:'http',url:server.url,insecure:true},process.cwd()));
   expect((await client.listTools())[0]?.name).toBe('echo');
   await expect(fetch(server.url)).rejects.toThrow();
  }finally{await client.close();await server.close();}
 });
});
