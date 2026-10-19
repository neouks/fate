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
  constructor(private url:string,private headers:Record<string,string>={},private fetcher:Fetcher=fetch) {}
  onMessage(fn:(m:JsonRpcMessage)=>void){this.messages.add(fn);return()=>{this.messages.delete(fn);};}
  onError(fn:(e:Error)=>void){this.errors.add(fn);return()=>{this.errors.delete(fn);};}
  onClose(fn:()=>void){this.closes.add(fn);return()=>{this.closes.delete(fn);};}
  async start() {
    const connectTimer=setTimeout(()=>this.controller.abort(new Error('MCP SSE connection timeout')),15_000);
    let response:Response;
    try { response=await this.fetcher(this.url,{headers:{...this.headers,Accept:'text/event-stream'},signal:this.controller.signal}); }
    finally { clearTimeout(connectTimer); }
    if(!response.ok||!response.body)throw new Error(`MCP SSE HTTP ${response.status}`);
    let ready!:()=>void,rejectReady!:(e:unknown)=>void;
    const readyPromise=new Promise<void>((resolve,reject)=>{ready=resolve;rejectReady=reject;});
    const timer=setTimeout(()=>{rejectReady(new Error('MCP SSE endpoint timeout'));void this.close();},15_000);
    this.pump=(async()=>{
      const reader=response.body!.getReader(),decoder=new TextDecoder();let buffer='';
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
              this.endpoint=endpoint;ready();
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
  async close(){if(this.closed)return;this.closed=true;this.controller.abort();await this.pump;for(const fn of this.closes)fn();}
}
export function createServerTransport(config:Record<string,unknown>,cwd:string,authProvider?:AuthProvider):McpTransport {
  const transport=String(config.transport ?? ('url' in config?'http':'stdio'));
  if(transport==='stdio')return new StdioTransport({command:String(config.command).replace(/^~(?=\/|$)/,homedir()),args:config.args as string[]|undefined,env:config.env as Record<string,string>|undefined,cwd:path.resolve(cwd,String(config.cwd??'.')),stderr:'pipe'});
  if(!['http','sse'].includes(transport))throw new Error(`不支持的 MCP transport: ${transport}`);
  if(!config.url)throw new Error('MCP url 不能为空');
  const dispatcher=config.insecure===true?new Agent({connect:{rejectUnauthorized:false}}):undefined;
  const scopedFetch:Fetcher=dispatcher?((url,init)=>undiciFetch(url as string,{...init,dispatcher} as never) as unknown as Promise<Response>):fetch;
  const result=transport==='sse'?new LegacySseTransport(String(config.url),config.headers as Record<string,string>,scopedFetch):new StreamableHttpTransport({url:String(config.url),headers:config.headers as Record<string,string>,fetch:scopedFetch,authProvider});
  if(dispatcher){const close=result.close.bind(result);result.close=async()=>{try{await close();}finally{await dispatcher.close();}};}
  return result;
}
