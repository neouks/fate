import {test} from 'node:test';
import assert from 'node:assert/strict';
import {searchPage,SEARCH_RECEIPT_BYTES,pageWindow,PAGE_READ_CHARS} from './reading.js';
import {projectWebHistory,webReadingReminder,WEB_CONTEXT_CHARS} from './context.js';
import {extractPage} from './pages.js';
const result=(id:string,tool:string,data:object)=>({role:'toolResult',toolCallId:id,toolName:tool,isError:false,content:[{type:'text',text:JSON.stringify(data)}],timestamp:1}) as any;

test('large searches remain bounded structured hits with usable pagination and read instructions',()=>{
 const original={backend:'github',query:'public docs',results:Array.from({length:50},(_,i)=>({title:'文档'.repeat(200),url:'https://example.com/'+i,summary:'长摘要'.repeat(2000),snippet:'snippet',date:null,engine:'github',source:'example.com'})),count:50,status:'ok',failures:[],latency_ms:1} as any;
 let offset=0;const urls:string[]=[];
 do{const page=searchPage(original,offset);assert(Buffer.byteLength(JSON.stringify(page))<=SEARCH_RECEIPT_BYTES);assert(page.results.length>0);assert.match(page.next_action,/web_read/);urls.push(...page.results.map(r=>String(r.url)));if(page.next_offset===null)break;assert(page.next_offset>offset);offset=page.next_offset;}while(true);
 assert.equal(new Set(urls).size,50);assert.equal(original.results[0].summary.length,6000);
});

test('short headings do not exhaust a body read; continuation covers every block',()=>{
 const blocks=[{id:'h',text:'Heading'},{id:'n',text:'Overview'},{id:'t',text:'Support'},...Array.from({length:10},(_,i)=>({id:String(i),text:'Useful content '+String(i)+'x'.repeat(1100)}))];
 const page={url:'https://example.com/doc',version:'v1',blocks};const first=pageWindow(page,0);
 assert(first.blocks.length>3);assert(first.returned_chars<=PAGE_READ_CHARS);assert.equal(first.continue_read?.version,'v1');
 const read=[...first.blocks];let next=first.next_offset;
 while(next!==null){const part=pageWindow(page,next);assert(part.returned_chars<=PAGE_READ_CHARS);read.push(...part.blocks);next=part.next_offset;}
 assert.deepEqual(read,blocks);
 const text=extractPage('<body><aside>menu</aside><main><div class="sidebar">nav</div><article><p>Actual content</p></article></main></body>','text/html');
 assert.equal(text,'Actual content');
});

test('context budget never suppresses the only retained copy; dedup uses canonical links and content',()=>{
 const messages=[result('a','web_read',{url:'https://example.com',blocks:[{id:'1',text:'Unique paragraph'}]}),
 result('b','web_read',{url:'https://mirror.example.com',blocks:[{id:'1',text:'Unique paragraph'},{id:'2',text:'overflow'.repeat(10000)}]}),
 ...Array.from({length:100},(_,i)=>result(String(i),'web_search',{results:[{url:'https://example.com/x?utm_source='+i,summary:'Search snippet'.repeat(1000)}]}))];
 const output=projectWebHistory(messages),texts=output.map((m:any)=>m.content[0].text);
 assert.equal(texts.join('').split('Unique paragraph').length-1,1);
 assert(texts.reduce((n,t)=>n+Array.from(t).length,0)<=WEB_CONTEXT_CHARS);
 assert.equal(messages[0].content[0].text.includes('Unique paragraph'),true);
 const a=result('1','web_search',{results:[{url:'https://example.com/x#section',summary:'same snippet'}]});
 const b=result('2','web_search',{results:[{url:'https://example.com/x?utm_source=test',summary:'same snippet'}]});
 assert.equal(JSON.stringify(projectWebHistory([a,b])).split('same snippet').length-1,1);
});

test('reading reminder tracks furthest page, clears completion and survives a repeated first page',()=>{
 const page=(offset:number,next:number|null)=>result(String(offset),'web_read',{url:'https://example.com',version:'v1',blocks:[],offset,next_offset:next});
 const messages=[page(0,4),page(4,8),page(0,4)];assert.match(webReadingReminder(messages)!,/"offset":8/);
 messages.push(page(8,null));assert.doesNotMatch(webReadingReminder(messages)!,/尚有未读段落/);
 const search=result('s','web_search',{results:[{url:'https://example.com',summary:'only snippet'}]});
 assert.match(webReadingReminder([search])!,/尚未成功读取/);
});


test('known built-in search guidance upgrades exactly; custom instructions survive',async()=>{
 const {effectiveToolDescription}=await import('../agent/tool-descriptions.js');
 const {WEB_SEARCH_DESCRIPTION,PREVIOUS_WEB_SEARCH_DESCRIPTION}=await import('./policy.js');
 assert.equal(effectiveToolDescription('web_search',WEB_SEARCH_DESCRIPTION,PREVIOUS_WEB_SEARCH_DESCRIPTION).description,WEB_SEARCH_DESCRIPTION);
 assert.equal(effectiveToolDescription('web_search',WEB_SEARCH_DESCRIPTION,'只搜索我批准的产品文档').source,'custom');
 assert.equal(effectiveToolDescription('web_read','当前正文读取说明','读取公开技术文档正文').description,'当前正文读取说明');
});


test('a long URL cannot stall the search cursor and Unicode failures fit the receipt',()=>{
 const r={backend:'auto',query:'字'.repeat(128),results:[{title:'字'.repeat(160),url:'https://example.com/'+ 'x'.repeat(8100),summary:'字'.repeat(320),date:null,engine:'bing',source:'字'.repeat(200)}],status:'partial',failures:[{source:'baidu',reason:'字'.repeat(256)}],latency_ms:1} as any;
 const page=searchPage(r);assert.equal(page.results.length,1);assert.equal(page.next_offset,null);assert(Buffer.byteLength(JSON.stringify(page))<=SEARCH_RECEIPT_BYTES);
});
