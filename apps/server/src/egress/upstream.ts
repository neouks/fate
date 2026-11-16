import {Agent,ProxyAgent,Socks5ProxyAgent,type Dispatcher} from 'undici';
import {HttpProxyAgent} from 'http-proxy-agent';
import {HttpsProxyAgent} from 'https-proxy-agent';
import {SocksProxyAgent} from 'socks-proxy-agent';
import type {Database} from '../db/index.js';
const tls={rejectUnauthorized:false};
const direct=new Agent({connect:tls});
const dispatchers=new Map<string,Dispatcher>();
export async function targetProxy(db:Database){return (await db.platform().getSetting('global_proxy'))?.trim()??'';}
export function targetDispatcher(proxy:string):Dispatcher {
 if(!proxy)return direct;
 let dispatcher=dispatchers.get(proxy);if(dispatcher)return dispatcher;
 dispatcher=proxy.startsWith('socks5:')||proxy.startsWith('socks5h:')?new Socks5ProxyAgent(proxy.replace(/^socks5h:/,'socks5:'),{requestTls:tls}):new ProxyAgent({uri:proxy,requestTls:tls});
 dispatchers.set(proxy,dispatcher);
 if(dispatchers.size>16){const [key,old]=dispatchers.entries().next().value!;dispatchers.delete(key);void old.close();}
 return dispatcher;
}
/** Per-request agents keep upstream changes live without changing task credentials. */
export function upstreamAgent(proxy:string,secure:boolean){
 if(proxy.startsWith('socks5:')||proxy.startsWith('socks5h:'))return new SocksProxyAgent(proxy.replace(/^socks5:/,'socks5h:'));
 return secure?new HttpsProxyAgent(proxy):new HttpProxyAgent(proxy);
}
