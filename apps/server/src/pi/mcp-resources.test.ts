import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer,type ServerResponse} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {McpClient} from '@earendil-works/pi-mcp';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {createServerTransport,LegacySseTransport,validateServerTransport} from './mcpTransport.js';
import {registerMcpMgmtRoutes} from '../http/routes/mcp-mgmt.js';
import {AgentRunner,type RunnerActivity} from './runner.js';

async function fixture(fn:(url:string,calls:string[])=>Promise<void>,resourceOnly=false,toolsDelay=0){
 const streams=new Map<string,ServerResponse>(),calls:string[]=[];let seq=0;
 const server=createServer(async(req,res)=>{
  if(req.headers.authorization!=='Bearer local-fixture'){res.writeHead(401).end();return;}
  const url=new URL(req.url!,'http://localhost');
  if(req.method==='GET'&&url.pathname==='/sse'){
   const id=String(++seq);res.writeHead(200,{'Content-Type':'text/event-stream'});streams.set(id,res);
   res.write(`event: endpoint\r\ndata: /messages?id=${id}\r\n\r\n`);req.on('close',()=>streams.delete(id));return;
  }
  if(req.method!=='POST'){res.writeHead(405).end();return;}
  let body='';for await(const chunk of req)body+=chunk;const message=JSON.parse(body);
  if(message.id===undefined){res.writeHead(202).end();return;}
  let result:unknown;
  if(message.method==='initialize')result={protocolVersion:message.params.protocolVersion,capabilities:resourceOnly?{resources:{}}:{tools:{}},serverInfo:{name:'local-fixture',version:'1'}};
  else if(message.method==='tools/list'){await new Promise(r=>setTimeout(r,toolsDelay));result={tools:[{name:'fixture_echo',description:'Echo local synthetic text',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};}
  else if(message.method==='tools/call'){calls.push(message.params.name);result={content:[{type:'text',text:'echo:'+message.params.arguments.text}]};}
  else result={};
  const response=JSON.stringify({jsonrpc:'2.0',id:message.id,result});
  if(url.pathname==='/messages'){streams.get(url.searchParams.get('id')!)!.write(`event: message\ndata: ${response}\n\n`);res.writeHead(202).end();}
  else{res.writeHead(200,{'Content-Type':'application/json'}).end(response);}
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{await fn(`http://127.0.0.1:${(server.address() as {port:number}).port}`,calls);}finally{for(const s of streams.values())s.end();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
}
for(const transport of ['http','sse'])test(`${transport}: unsaved/saved probe and actual tool call share authentication`,async()=>fixture(async(url,calls)=>{
 const config={transport,url:url+(transport==='sse'?'/sse':'/mcp'),env:{Authorization:'Bearer local-fixture'}};
 const app=Fastify();app.decorate('db',{query:async()=>({rows:[config]})});registerMcpMgmtRoutes(app);
 try{
  for(const input of [{method:'POST' as const,url:'/api/mcp/test',payload:config},{method:'GET' as const,url:'/api/mcp/1/test'}]){
   const response=await app.inject(input);assert.equal(response.statusCode,200);assert.equal(response.json().ok,true,response.body);assert.equal(response.json().tool_count,1);
  }
  const client=new McpClient({name:'test',version:'1',requestTimeoutMs:1000});
  try{await client.connect(createServerTransport(config,tmpdir()));assert.equal((await client.listTools()).length,1);assert.match(JSON.stringify(await client.callTool('fixture_echo',{text:'local'})),/echo:local/);}finally{await client.close();}
  assert.deepEqual(calls,['fixture_echo']);
 }finally{await app.close();}
}));
test('resource-only MCP probe succeeds with zero tools',async()=>fixture(async url=>{
 const app=Fastify();registerMcpMgmtRoutes(app);
 try{const r=await app.inject({method:'POST',url:'/api/mcp/test',payload:{transport:'http',url,env:{Authorization:'Bearer local-fixture'}}});assert.equal(r.json().ok,true,r.body);assert.equal(r.json().tool_count,0);}finally{await app.close();}
},true));
test('legacy SSE close before endpoint rejects start promptly',async()=>{
 const stream=new ReadableStream<Uint8Array>({start(){}});
 const transport=new LegacySseTransport('http://localhost/sse',{},async()=>new Response(stream,{status:200}));
 const rejection=assert.rejects(transport.start(),/closed before endpoint/);
 await new Promise(r=>setImmediate(r));await transport.close();await rejection;
});
test('invalid MCP configurations rejected before launching',()=>{
 for(const cfg of [{transport:'stdio'}, {transport:'stdio',command:'node',args:[1]}, {transport:'http',url:'file:///tmp'}, {transport:'http',url:'http://localhost',env:[]}, {transport:'http',url:'http://localhost',env:{token:123}}])assert.throws(()=>validateServerTransport(cfg));
});
test('stdio discovers and calls local tool',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fate-mcp-stdio-'));
 await writeFile(join(dir,'server.mjs'),`import {createInterface} from 'node:readline';for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'stdio-ok'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}`);
 const client=new McpClient({name:'test',version:'1',requestTimeoutMs:1000});
 try{await client.connect(createServerTransport({transport:'stdio',command:process.execPath,args:['server.mjs']},dir));assert.equal((await client.listTools())[0]?.name,'echo');assert.match(JSON.stringify(await client.callTool('echo',{})),/stdio-ok/);}finally{await client.close();await rm(dir,{recursive:true,force:true});}
});
test('native pi deferred MCP discovery, call, restore and live revocation',async()=>fixture(async(url,calls)=>{
 const dir=await mkdtemp(join(tmpdir(),'fate-mcp-native-'));let enabled=true;
 const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
 const faux=fauxProvider({provider:'mcp-local'});runtime.registerNativeProvider(faux.provider);const activities:RunnerActivity[]=[];
 const options={cwd:dir,agentDir:dir,resumeSessionPath:join(dir,'session.jsonl'),modelRuntime:runtime,model:faux.getModel(),systemPrompt:'本地合成 MCP 回归。',toolAllowlist:['mcp__*'],
  toolLoading:{version:'lean-tools-v1',initialActive:['mcp__*'],deferred:[],compatibility:[]},
  mcpEntries:[{name:'fixture',config:{transport:'http',url,headers:{Authorization:'Bearer local-fixture'},exposure:'deferred'}}],
  mcpGuard:async(_server:string,method:string)=>{if(method==='tools/call'&&!enabled)throw new Error('fixture revoked');},onActivity:(a:RunnerActivity)=>{activities.push(a);}};
 try{
  faux.setResponses([fauxAssistantMessage([fauxToolCall('tool_search',{query:'fixture echo'})]),fauxAssistantMessage([fauxToolCall('mcp__fixture__fixture_echo',{text:'first'})]),fauxAssistantMessage('完成')]);
  let runner=await AgentRunner.create(options);
  try{assert.ok(!runner.activeToolNames.includes('mcp__fixture__fixture_echo'));await runner.prompt('本地工具搜索并调用');assert.deepEqual(calls,['fixture_echo']);}finally{await runner.dispose();}
  enabled=false;faux.setResponses([fauxAssistantMessage([fauxToolCall('mcp__fixture__fixture_echo',{text:'revoked'})]),fauxAssistantMessage('结束')]);
  runner=await AgentRunner.create(options);
  try{await runner.prompt('恢复后检查撤销');assert.deepEqual(calls,['fixture_echo']);assert.ok(activities.some(a=>a.kind==='tool_end'&&a.isError));}finally{await runner.dispose();}
 }finally{await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
}));

test('mixed platform and MCP discovery waits for native registration before searching',async()=>fixture(async(url,calls)=>{
 const dir=await mkdtemp(join(tmpdir(),'fate-mcp-slow-'));
 const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
 const faux=fauxProvider({provider:'slow-mcp'});runtime.registerNativeProvider(faux.provider);const activities:RunnerActivity[]=[];
 faux.setResponses([fauxAssistantMessage([fauxToolCall('tool_search',{query:'fixture echo'})]),
  fauxAssistantMessage([fauxToolCall('mcp__fixture__fixture_echo',{text:'ready'})]),fauxAssistantMessage('done')]);
 const runner=await AgentRunner.create({cwd:dir,agentDir:dir,inMemory:true,modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Local fixture.',
  toolAllowlist:['mcp__*','local_echo'],toolLoading:{version:'lean-tools-v1',initialActive:['mcp__*'],deferred:['local_echo'],compatibility:[]},
  mcpEntries:[{name:'fixture',config:{transport:'http',url,headers:{Authorization:'Bearer local-fixture'},exposure:'deferred'}}],
  customTools:[{name:'local_echo',label:'Local',description:'Local echo',exposure:'deferred',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'local'}]})}],
  onActivity:a=>{activities.push(a);}});
 try{
  await runner.prompt('local fixture');assert.deepEqual(calls,['fixture_echo']);
  const search=activities.find(a=>a.kind==='tool_end'&&a.toolName==='tool_search');
  assert.ok(search?.kind==='tool_end'&&!search.isError);assert.match(search.text??'',/mcp__fixture__fixture_echo/);
  assert.doesNotMatch(search.text??'',/MCP 发现未完成/);
 }finally{await runner.dispose();await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
},false,250));

for(const query of ['本地回显','local_echo'])test(`unavailable MCP does not block native internal discovery: ${query}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fate-mcp-offline-'));
 const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
 const faux=fauxProvider({provider:'offline-local'});runtime.registerNativeProvider(faux.provider);const activities:RunnerActivity[]=[];let calls=0;
 const options={cwd:dir,agentDir:dir,inMemory:true,modelRuntime:runtime,model:faux.getModel(),systemPrompt:'Local fixture.',toolAllowlist:['local_echo','mcp__*'],toolLoading:{version:'lean-tools-v1',initialActive:['mcp__*'],deferred:['local_echo'],compatibility:[]},mcpEntries:[{name:'offline',config:{transport:'http',url:'http://127.0.0.1:1',exposure:'deferred'}}],customTools:[{name:'local_echo',label:'Local echo',exposure:'deferred' as const,description:'本地回显合成文本。Echo local synthetic text',parameters:{type:'object',properties:{}},execute:async()=>{calls++;return{content:[{type:'text',text:'local-ok'}],details:{}};}}],onActivity:(a:RunnerActivity)=>{activities.push(a);}};
 faux.setResponses([fauxAssistantMessage([fauxToolCall('tool_search',{query})]),fauxAssistantMessage([fauxToolCall('local_echo',{})]),fauxAssistantMessage('done')]);
 const runner=await AgentRunner.create(options as Parameters<typeof AgentRunner.create>[0]);
 try{assert.ok(!runner.activeToolNames.includes('local_echo'));await runner.prompt('local fixture');assert.ok(runner.activeToolNames.includes('local_echo'));assert.equal(calls,1);const searches=activities.filter(a=>a.kind==='tool_end'&&a.toolName==='tool_search');assert.equal(searches.length,1);for(const result of searches){assert.ok(!result.isError);assert.match(result.text??'',/local_echo/);}assert.ok(activities.some(a=>a.kind==='tool_end'&&!a.isError&&a.text?.includes('MCP 发现未完成')));}finally{await runner.dispose();await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});
