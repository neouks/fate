import assert from 'node:assert/strict';
import {createServer, get} from 'node:http';
import {gzipSync} from 'node:zlib';
import {test} from 'node:test';
import Fastify from 'fastify';
import {registerFrontendProxy} from './frontend-proxy.js';

test('frontend proxy preserves pages, RSC, cookies, assets and bodies while API stays local', async t => {
  const seen: Array<{url:string;host:string|undefined;forwarded:string|undefined;cookie:string|undefined;rsc:string|undefined;body:string}> = [];
  const compressed=gzipSync('synthetic javascript');let base='';
  const upstream=createServer(async (req,res)=>{
    const body=[];for await(const chunk of req)body.push(chunk);
    seen.push({url:req.url!,host:req.headers.host,forwarded:req.headers['x-forwarded-host'] as string,cookie:req.headers.cookie,rsc:req.headers.rsc as string,body:Buffer.concat(body).toString()});
    if(req.url==='/redirect'){res.writeHead(307,{location:base+'/login?next=%2Ffunction%2Ftasks'}).end();return;}
    if(req.url?.startsWith('/_next/')){res.writeHead(200,{'content-type':'application/javascript','content-encoding':'gzip','cache-control':'public, max-age=31536000, immutable'}).end(compressed);return;}
    res.writeHead(200,{'content-type':req.headers.rsc?'text/x-component':'text/html','set-cookie':['first=1; Path=/','second=2; Path=/'],'connection':'close'});
    res.write('first chunk');res.end(' second chunk');
  });
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  base='http://127.0.0.1:'+(upstream.address() as {port:number}).port;
  const app=Fastify();registerFrontendProxy(app,base);
  app.get('/api/health',async()=>({local:true}));
  t.after(async()=>{await app.close();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const page=await app.inject({url:'/function/tasks/detail?id=4899&tab=profiles',headers:{host:'127.0.0.1:8787',cookie:'series_token=fixture'}});
  assert.equal(page.statusCode,200);assert.equal(page.body,'first chunk second chunk');assert.equal(page.cookies.length,2);
  assert.equal(seen[0]!.url,'/function/tasks/detail?id=4899&tab=profiles');assert.equal(seen[0]!.forwarded,'127.0.0.1:8787');assert.equal(seen[0]!.cookie,'series_token=fixture');
  const rsc=await app.inject({url:'/function/tasks/detail?_rsc=fixture',headers:{rsc:'1','next-router-state-tree':'fixture'}});
  assert.equal(rsc.headers['content-type'],'text/x-component');assert.equal(seen.at(-1)!.rsc,'1');
  const asset=await app.inject('/_next/static/chunks/fixture.js');assert.deepEqual(asset.rawPayload,compressed);assert.equal(asset.headers['content-encoding'],'gzip');
  await app.inject({method:'POST',url:'/function/tasks/detail',headers:{'content-type':'text/plain','next-action':'fixture'},payload:'action body'});assert.equal(seen.at(-1)!.body,'action body');
  const redirect=await app.inject('/redirect');assert.equal(redirect.statusCode,307);assert.equal(redirect.headers.location,'/login?next=%2Ffunction%2Ftasks');
  const count=seen.length;assert.deepEqual((await app.inject('/api/health')).json(),{local:true});assert.equal((await app.inject('/api/missing')).statusCode,404);assert.equal(seen.length,count);
  await app.inject('//other.invalid/path');assert.equal(seen.at(-1)!.host,new URL(base).host,'request path cannot override configured upstream');
});

test('unavailable frontend returns 502 and cannot affect the API',async()=>{
  const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=(probe.address() as {port:number}).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const app=Fastify();registerFrontendProxy(app,`http://127.0.0.1:${port}`);app.get('/api/health',async()=>({ok:true}));
  try{assert.equal((await app.inject('/login')).statusCode,502);assert.equal((await app.inject('/api/health')).statusCode,200);}finally{await app.close();}
});

test('frontend configuration accepts origins only',()=>{
  for(const url of ['file:///tmp/site','http://user:password@localhost:3000','http://localhost:3000/sub','http://localhost:3000/?token=secret']){
    assert.throws(()=>registerFrontendProxy(Fastify(),url),/frontend_url/);
  }
});

test('cancelled frontend streams never fall through to local routes and leave API usable', async t => {
  let upstreamClosed!: () => void;
  const closed = new Promise<void>(resolve => { upstreamClosed = resolve; });
  const upstream = createServer((_req, res) => {
    res.writeHead(200, {'content-type': 'application/octet-stream'});
    res.write(Buffer.alloc(64 * 1024));
    res.once('close', upstreamClosed);
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const app = Fastify();
  registerFrontendProxy(app, `http://127.0.0.1:${(upstream.address() as {port:number}).port}`);
  let fallthrough = 0;
  app.setNotFoundHandler((_req, reply) => { fallthrough++; reply.raw.destroy(); });
  app.get('/api/health', async () => ({ok: true}));
  t.after(async () => { await app.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const address = await app.listen({host: '127.0.0.1', port: 0});
  await new Promise<void>((resolve, reject) => {
    get(address + '/_next/static/chunk.js', response => {
      response.once('data', () => { response.destroy(); resolve(); });
      response.once('error', reject);
    }).once('error', reject);
  });
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('upstream not cancelled')), 2000); timer.unref(); })]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fallthrough, 0, 'a cancelled proxy response must not run the local 404 handler');
  const health = await fetch(address + '/api/health');
  assert.deepEqual(await health.json(), {ok: true});
});
