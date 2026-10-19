import test from 'node:test';
import assert from 'node:assert/strict';
import {openActivityStream} from './activity-event-source.ts';
const wait=()=>new Promise(resolve=>setTimeout(resolve,550));
class Source extends EventTarget {
 static CLOSED=2;static instances=[];
 readyState=0;
 constructor(url){super();this.url=url;Source.instances.push(this);}
 close(){this.readyState=2;}
 fail(state=2){this.readyState=state;this.dispatchEvent(new Event('error'));}
}
test('proxy failure reopens a closed stream from the latest durable cursor',async()=>{
 const original=globalThis.EventSource;globalThis.EventSource=Source;Source.instances=[];let cursor=7;const states=[];
 const stream=openActivityStream(()=>`/stream?since=${cursor}`,()=>{},v=>states.push(v));
 try{Source.instances[0].fail();cursor=19;await wait();assert.equal(Source.instances.length,2);assert.equal(Source.instances[1].url,'/stream?since=19');assert.deepEqual(states,[false]);}
 finally{stream.close();globalThis.EventSource=original;}
});
test('native retry remains native, without opening a parallel connection',async()=>{
 const original=globalThis.EventSource;globalThis.EventSource=Source;Source.instances=[];
 const stream=openActivityStream(()=>'/stream',()=>{},()=>{});
 try{Source.instances[0].fail(0);await wait();assert.equal(Source.instances.length,1);}
 finally{stream.close();globalThis.EventSource=original;}
});
test('switching sessions or revoking access cancels a scheduled retry',async()=>{
 const original=globalThis.EventSource;globalThis.EventSource=Source;Source.instances=[];
 try{const stream=openActivityStream(()=>'/stream',()=>{},()=>{});Source.instances[0].fail();stream.close();await wait();assert.equal(Source.instances.length,1);}
 finally{globalThis.EventSource=original;}
});
