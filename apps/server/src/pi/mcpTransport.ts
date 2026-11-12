import { StdioTransport, StreamableHttpTransport, type McpTransport, type JsonRpcMessage, type McpTransportSendOptions, type AuthProvider } from '@earendil-works/pi-mcp';
import { Agent, fetch as undiciFetch } from 'undici';
import path from 'node:path';
import { homedir } from 'node:os';

type Fetcher = typeof globalThis.fetch;
/** Legacy SSE is a transport adapter only; pi still owns RPC, tools, cancellation and lifecycle. */
export class LegacySseTransport implements McpTransport {
  private controller = new AbortController();
  private messages = new Set<(m:JsonRpcMessage)=>void>();
  private errors = new Set<(e:Error)=>void>();
  private closes = new Set<()=>void>();
  private endpoint?: URL;
  private closed = false;
  private pump?: Promise<void>;
  private rejectReady?: (error:unknown)=>void;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  constructor(private url:string,private headers:Record<string,string>={},private fetcher:Fetcher=fetch) {}
  onMessage(fn:(m:JsonRpcMessage)=>void){this.messages.add(fn);return()=>{this.messages.delete(fn);};}
  onError(fn:(e:Error)=>void){this.errors.add(fn);return()=>{this.errors.delete(fn);};}
  onClose(fn:()=>void){this.closes.add(fn);return()=>{this.closes.delete(fn);};}
  async start() {
    const connectTimer=setTimeout(()=>this.controller.abort(new Error('MCP SSE connection timeout')),15_000);
    let response:Response;
    try { response=await this.fetcher(this.url,{headers:{...this.headers,Accept:'text/event-stream'},signal:this.controller.signal}); }
    finally { clearTimeout(connectTimer); }
    if(!response.ok||!response.body){await response.body?.cancel();throw new Error(`MCP SSE HTTP ${response.status}`);}
    let ready!:()=>void,rejectReady!:(e:unknown)=>void;
    const readyPromise=new Promise<void>((resolve,reject)=>{ready=resolve;rejectReady=reject;});
    this.rejectReady=rejectReady;
    const timer=setTimeout(()=>{rejectReady(new Error('MCP SSE endpoint timeout'));void this.close();},15_000);
    this.pump=(async()=>{
      const reader=response.body!.getReader(),decoder=new TextDecoder();this.reader=reader;let buffer='';
      try {
        while(!this.closed){
          const {value,done}=await reader.read();if(done)break;
          buffer=(buffer+decoder.decode(value,{stream:true})).replace(/\r\n/g,'\n');
          if(buffer.length>8*1024*1024)throw new Error('MCP SSE frame too large');
          let index;
          while((index=buffer.indexOf('\n\n'))>=0){
            const frame=buffer.slice(0,index);buffer=buffer.slice(index+2);
            let event='message';const data:string[]=[];
            for(const line of frame.split('\n')){if(line.startsWith('event:'))event=line.slice(6).trim();if(line.startsWith('data:'))data.push(line.slice(5).trimStart());}
            if(event==='endpoint'){
              const endpoint=new URL(data.join('\n'),this.url);
              if(endpoint.origin!==new URL(this.url).origin)throw new Error('MCP SSE endpoint must share server origin');
              this.endpoint=endpoint;this.rejectReady=undefined;ready();
            } else if(data.length){const message=JSON.parse(data.join('\n')) as JsonRpcMessage;for(const fn of this.messages)fn(message);}
          }
        }
        if(!this.closed)throw new Error('MCP SSE stream closed');
      }catch(error){rejectReady(error);if(!this.closed)for(const fn of this.errors)fn(error instanceof Error?error:new Error(String(error)));}
      finally{clearTimeout(timer);await reader.cancel().catch(()=>{});if(!this.closed){this.closed=true;for(const fn of this.closes)fn();}}
    })();
    await readyPromise;clearTimeout(timer);
  }
  async send(message:JsonRpcMessage,options:McpTransportSendOptions={}) {
    options.signal?.throwIfAborted();
    if(this.closed||!this.endpoint)throw new Error('MCP SSE not connected');
    const response=await this.fetcher(this.endpoint,{method:'POST',headers:{...this.headers,'Content-Type':'application/json'},body:JSON.stringify(message),signal:options.signal?AbortSignal.any([this.controller.signal,options.signal]):this.controller.signal});
    await response.body?.cancel();if(!response.ok)throw new Error(`MCP SSE POST ${response.status}`);
  }
  async close(){if(this.closed)return;this.closed=true;this.rejectReady?.(new Error('MCP SSE connection closed before endpoint'));this.rejectReady=undefined;this.controller.abort();await this.reader?.cancel().catch(()=>{});await this.pump;for(const fn of this.closes)fn();}
}
/** Shared interpretation for saved configurations, form probes and runtime sessions. */
export function validateServerTransport(config:Record<string,unknown>) {
  const transport=String(config.transport ?? ('url' in config?'http':'stdio'));
  if(!['stdio','http','sse'].includes(transport))throw new Error(`不支持的 MCP transport: ${transport}`);
  const env=config.env??{};
  if(typeof env!=='object'||env===null||Array.isArray(env)||Object.values(env).some(v=>typeof v!=='string'))throw new Error('MCP env 必须为字符串键值对象');
  if(config.args!==undefined&&(!Array.isArray(config.args)||config.args.some(v=>typeof v!=='string')))throw new Error('MCP args 必须为字符串数组');
  if(transport==='stdio'){
    if(typeof config.command!=='string'||!config.command.trim())throw new Error('MCP command 不能为空');
  }else{
    if(typeof config.url!=='string'||!config.url.trim())throw new Error('MCP url 不能为空');
    let url:URL;try{url=new URL(config.url);}catch{throw new Error('MCP url 必须为有效 HTTP/HTTPS 地址');}
    if(!['http:','https:'].includes(url.protocol))throw new Error('MCP url 必须为有效 HTTP/HTTPS 地址');
    const headers=config.headers??env;
    if(typeof headers!=='object'||headers===null||Array.isArray(headers)||Object.values(headers).some(v=>typeof v!=='string'))throw new Error('MCP headers 必须为字符串键值对象');
    try{new Headers(headers as Record<string,string>);}catch{throw new Error('MCP 请求头名称或值无效');}
  }
  return transport;
}
export function createServerTransport(config:Record<string,unknown>,cwd:string,authProvider?:AuthProvider):McpTransport {
  const transport=validateServerTransport(config);
  if(transport==='stdio')return new StdioTransport({command:String(config.command).replace(/^~(?=\/|$)/,homedir()),args:config.args as string[]|undefined,env:config.env as Record<string,string>|undefined,cwd:path.resolve(cwd,String(config.cwd??'.')),stderr:'pipe'});
  if(!['http','sse'].includes(transport))throw new Error(`不支持的 MCP transport: ${transport}`);
  if(!config.url)throw new Error('MCP url 不能为空');
  const dispatcher=config.insecure===true?new Agent({connect:{rejectUnauthorized:false}}):undefined;
  const scopedFetch:Fetcher=dispatcher?((url,init)=>undiciFetch(url as string,{...init,dispatcher} as never) as unknown as Promise<Response>):fetch;
  const headers=(config.headers??config.env) as Record<string,string>|undefined;
  const result=transport==='sse'?new LegacySseTransport(String(config.url),headers,scopedFetch):new StreamableHttpTransport({url:String(config.url),headers,fetch:scopedFetch,authProvider});
  if(dispatcher){const close=result.close.bind(result);result.close=async()=>{try{await close();}finally{await dispatcher.close();}};}
  return result;
}
