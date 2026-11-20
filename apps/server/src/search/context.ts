import {createHash} from 'node:crypto';
import type {ContextEvent} from '@earendil-works/pi-coding-agent';
import {readingURL} from './reading.js';

// Budget includes all projected web receipts, including omission metadata.
// Rebuild from the retained native branch; never mutate persisted evidence.
export const WEB_CONTEXT_CHARS=16_000;
export function projectWebHistory(messages:ContextEvent['messages']):ContextEvent['messages'] {
  const seen=new Set<string>(),urls=new Set<string>(),output=[...messages];
  const parsed:{index:number;message:Extract<typeof messages[number],{role:'toolResult'}>;data:Record<string,any>}[]=[];
  for(let index=0;index<messages.length;index++) {
    const message=messages[index]!;
    if(message.role!=='toolResult'||message.isError||!['web_search','web_read'].includes(message.toolName)||message.content.length!==1)continue;
    const part=message.content[0];if(part?.type!=='text')continue;
    try{const data=JSON.parse(part.text);if(data&&typeof data==='object'&&!Array.isArray(data))parsed.push({index,message,data});}catch{/* Keep non-JSON diagnostics. */}
  }
  // Keep actually read source passages ahead of newer search snippets. Reserve
  // enough space for a small receipt for every older omitted item.
  let remaining=Math.max(0,WEB_CONTEXT_CHARS-parsed.length*2);
  const ordered=[...parsed].sort((a,b)=>Number(b.message.toolName==='web_read')-Number(a.message.toolName==='web_read')||b.index-a.index);
  for(const {index,message,data} of ordered) {
    const newIDs:string[]=[],newURLs:string[]=[];
    if(message.toolName==='web_read'&&Array.isArray(data.blocks))data.blocks=data.blocks.map(block=>{
      if(!block||typeof block.text!=='string')return block;
      const id=createHash('sha256').update(block.text).digest('hex');
      if(seen.has(id)||newIDs.includes(id))return {id,duplicate:true};
      newIDs.push(id);return {...block,id};
    });
    if(message.toolName==='web_search'&&Array.isArray(data.results))data.results=data.results.map(row=>{
      if(!row||typeof row.url!=='string')return row;
      const url=readingURL(row.url);
      if(urls.has(url)||newURLs.includes(url))return {url,duplicate:true};
      newURLs.push(url);return {...row,url};
    });
    let text=JSON.stringify(data),chars=Array.from(text).length;
    if(chars>remaining+2){
      text=JSON.stringify({history_omitted:true,url:data.url,offset:data.offset,query:data.query,backend:data.backend,
        read_again:message.toolName,note:'此资料已从当前请求省略；需要原文时重新调用同一工具。'});
      if(Array.from(text).length>remaining+2)text='{}';
    }else{
      // Only retained passages may suppress older copies. Marking omitted
      // passages as seen could remove the sole remaining readable copy.
      newIDs.forEach(id=>seen.add(id));newURLs.forEach(url=>urls.add(url));
    }
    remaining-=Math.max(0,Array.from(text).length-2);
    output[index]={...message,content:[{type:'text',text}]};
  }
  return output;
}

/** One bounded, derived reminder; no new persistent messages on each request. */
export function webReadingReminder(messages:ContextEvent['messages']):string|undefined {
  const pages=new Map<string,{version:unknown;offset:number;next:unknown;url:string}>();
  let lastSearch:Record<string,any>|undefined,lastWebError=false;
  for(const message of messages){
    if(message.role!=='toolResult'||!['web_read','web_search'].includes(message.toolName))continue;
    if(message.isError){lastWebError=true;continue;}
    const part=message.content[0];if(part?.type!=='text')continue;
    let data;try{data=JSON.parse(part.text);}catch{continue;}if(!data)continue;
    lastWebError=false;
    if(message.toolName==='web_search'&&data.results?.length)lastSearch=data;
    if(message.toolName==='web_read'&&typeof data.url==='string'&&Array.isArray(data.blocks)){
      const key=readingURL(data.url),old=pages.get(key),offset=Number(data.offset??0);
      if(!old||old.version!==data.version||offset>=old.offset)pages.set(key,{version:data.version,offset,next:data.next_offset,url:key});
    }
  }
  if(!lastSearch&&!pages.size)return;
  const pending=[...pages.values()].filter(p=>Number.isInteger(p.next)&&p.url.length<=1000).slice(-2).map(p=>({url:p.url,offset:p.next,version:p.version}));
  return '【公开资料阅读状态】搜索摘要不是已读原文。拟引用的技术结论须有正文支持；已有资料充分则直接引用，不重复检索。'+
    (pending.length?' 尚有未读段落：'+JSON.stringify(pending)+ '。若当前只读到导航/标题或尚未覆盖问题，加载 web_read 并按上述参数续读；已找到足够证据即可停止。':
      !pages.size?' 尚未成功读取任何网页正文；从已有相关搜索结果选官方文档，通过 tool_search 精确加载 web_read 后读取，避免反复换词搜索。':' 已读取过网页，结合实际正文判断证据是否充分。')+
    (lastWebError?' 最近一次检索/阅读失败，不能当作已读；限流或验证码时换一个公开来源或说明无法核实，不反复重试。':'');
}
