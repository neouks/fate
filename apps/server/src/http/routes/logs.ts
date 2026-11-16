import type {FastifyInstance} from 'fastify';
import type {Database} from '../../db/index.js';
import {format} from 'node:util';
interface LogLine {seq:number;db_id:number;ts:string;level:'info'|'warn'|'error';tag:string;text:string;}
export function redactLog(text:string){return text.replace(/([?&](?:token|api_key|key|password)=)[^\s&#]*/gi,'$1[redacted]').replace(/(Bearer\s+)[^\s"']+/gi,'$1[redacted]').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g,'$1[redacted]@').slice(0,8000);}
function line(row:Record<string,unknown>):LogLine{return {seq:Number(row.id),db_id:Number(row.id),ts:new Date(String(row.created_at)).toISOString(),level:row.level==='error'?'error':row.level==='warn'?'warn':'info',tag:String(row.tag),text:redactLog(String(row.text))};}
const stores=new WeakMap<object,ReturnType<typeof makeStore>>();
function makeStore(db:Database){
 let pending=Promise.resolve(),queued=0;const listeners=new Set<(line:LogLine)=>void>();
 return {listeners,flush:()=>pending,
  write(level:LogLine['level'],tag:string,text:string){
   if(queued>=1000)return;queued++;
   pending=pending.then(async()=>{const result=await db.query('INSERT INTO server_logs(level,tag,text) VALUES($1,$2,$3) RETURNING *',[level,tag.slice(0,80),redactLog(text)]);const item=line(result.rows[0]!);for(const listener of listeners)listener(item);}).catch(()=>{/* Do not recurse into the failing logger. */}).finally(()=>{queued--;});
  },
 };
}
export function systemLogs(db:Database){let store=stores.get(db.pool??db);if(!store){store=makeStore(db);stores.set(db.pool??db,store);}return store;}
/** Capture existing engine/process diagnostics without changing their stdout behavior. */
export function captureConsole(db:Database){
 const logs=systemLogs(db),original={log:console.log,info:console.info,warn:console.warn,error:console.error};
 for(const method of ['log','info','warn','error'] as const)console[method]=(...args:unknown[])=>{original[method](...args);const text=format(...args);logs.write(method==='log'?'info':method,text.match(/^\[([^\]]+)\]/)?.[1]??'server',text);};
 return async()=>{Object.assign(console,original);await logs.flush();};
}
export function registerLogRoutes(app:FastifyInstance){
 const logs=systemLogs(app.db),connections=new Set<()=>void>();
 app.addHook('onResponse',async req=>{if(req.url.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(req.method))logs.write('info','http',`${req.method} ${req.url.split('?')[0]}`);});
 app.addHook('preClose',async()=>{for(const close of connections)close();await logs.flush();});
 app.get('/api/logs/history',async req=>{
  const q=req.query as {before?:string;limit?:string},before=Number(q.before)||0,limit=Math.max(1,Math.min(500,Math.floor(Number(q.limit)||200)));
  const rows=(await app.db.query('SELECT * FROM server_logs WHERE ($1::bigint=0 OR id<$1) ORDER BY id DESC LIMIT $2',[Math.max(0,Math.floor(before)),limit+1])).rows;
  return {items:rows.slice(0,limit).reverse().map(line),has_more:rows.length>limit};
 });
 app.get('/api/logs/stream',async(req,reply)=>{
  const q=req.query as {since?:string};let cursor=Math.max(0,Math.floor(Number(req.headers['last-event-id']??q.since)||0));
  const buffered:LogLine[]=[];let replaying=true;
  const send=(item:LogLine)=>{if(item.seq<=cursor)return;cursor=item.seq;if(!reply.raw.write(`id: ${item.seq}\ndata: ${JSON.stringify(item)}\n\n`))close();};
  const listener=(item:LogLine)=>{if(replaying){if(buffered.length<1000)buffered.push(item);else close();}else send(item);};
  let heartbeat:ReturnType<typeof setInterval>|undefined;
  const close=()=>{if(heartbeat)clearInterval(heartbeat);logs.listeners.delete(listener);connections.delete(close);if(!reply.raw.writableEnded)reply.raw.end();};
  reply.hijack();reply.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});reply.raw.write(': connected\n\n');
  connections.add(close);reply.raw.once('close',close);logs.listeners.add(listener);
  try{const rows=(await app.db.query('SELECT * FROM server_logs WHERE id>$1 ORDER BY id DESC LIMIT 100',[cursor])).rows;for(const row of rows.reverse())send(line(row));replaying=false;for(const item of buffered)send(item);if(!reply.raw.writableEnded){heartbeat=setInterval(()=>{if(!reply.raw.write(': keepalive\n\n'))close();},15000);heartbeat.unref();}}
  catch{close();}
 });
}
