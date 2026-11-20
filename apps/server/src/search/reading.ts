import {canonicalLink} from './public-web.js';
import type {referenceSearch} from './references.js';

// Keep search hits usable in the immediate receipt instead of externalizing a
// large JSON blob that hides URLs behind a second context_get operation.
export const SEARCH_RECEIPT_BYTES=12_000;
export function searchPage(result:Awaited<ReturnType<typeof referenceSearch>>,offset=0) {
  const results:Record<string,unknown>[]=[];
  let end=offset;
  for(const row of result.results.slice(offset)) {
    if(Buffer.byteLength(row.url)>8192){end++;continue;}
    const item={title:Array.from(row.title).slice(0,160).join(''),url:row.url,
      summary:Array.from(row.summary??row.snippet??'').slice(0,320).join(''),date:row.date?.slice(0,64)??null,
      engine:row.engine,source:row.source.slice(0,200),body_read:false};
    // A single long URL must not produce an empty page with the same cursor.
    // Leave room for Unicode query/failure metadata as well as reading hints.
    if(Buffer.byteLength(JSON.stringify(item))>SEARCH_RECEIPT_BYTES-3000){item.summary='';item.title=Array.from(item.title).slice(0,40).join('');item.source=item.source.slice(0,80);item.date=null;}
    if(Buffer.byteLength(JSON.stringify([...results,item]))>SEARCH_RECEIPT_BYTES-3000)break;
    results.push(item);end++;
  }
  return {backend:result.backend,query:result.query,status:result.status,failures:result.failures.map(f=>({source:f.source,reason:f.reason.slice(0,256)})),
    results,count:results.length,total_results:result.results.length,offset,
    next_offset:end<result.results.length?end:null,latency_ms:result.latency_ms,
    next_action:results.length?'选择与问题直接相关的官方文档，加载 web_read 后用结果 URL 读取。摘要不能证明已读原文。若当前结果不相关，换一个来源补查一次；不要反复换同义词搜索。':'没有可用结果；可换一个来源补查一次，仍无结果就明确资料缺失。',
    pagination:'next_offset 仅用于同一 web_search 的结果分页；网页正文使用 web_read 自己返回的 next_offset。'};
}

export const PAGE_READ_CHARS=3600;
export const PAGE_READ_BLOCKS=40;
export function pageWindow(page:{url:string;version:string;blocks:{id:string;text:string}[]},offset:number) {
  const blocks:typeof page.blocks=[];let chars=0,end=offset;
  for(const block of page.blocks.slice(offset)) {
    const size=Array.from(block.text).length;
    if(blocks.length&&(chars+size>PAGE_READ_CHARS||blocks.length>=PAGE_READ_BLOCKS))break;
    blocks.push(block);chars+=size;end++;
  }
  const next=end<page.blocks.length?end:null;
  return {url:page.url,version:page.version,blocks,offset,next_offset:next,total_blocks:page.blocks.length,
    returned_chars:chars,read_status:next===null?'end_of_page':'partial',
    ...(next===null?{}:{continue_read:{url:page.url,offset:next,version:page.version}}),
    next_action:next===null?'已读到页面末尾。仅引用正文实际支持的结论，保留 URL；资料充分时停止检索。':'尚未读完。如果当前内容只有标题/导航，或尚未覆盖具体问题，按 continue_read 调用 web_read 续读；已足够支持回答时可停止，不必通读。'};
}

export function readingURL(url:string){return canonicalLink(url)??url;}
