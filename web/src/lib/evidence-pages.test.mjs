import test from 'node:test';import assert from 'node:assert/strict';
import {appendEvidencePage} from './evidence-pages.ts';
test('body pages preserve split Chinese and emoji bytes without mutating previous state',()=>{
 const text='中文🙂分页',bytes=new TextEncoder().encode(text);
 const page=(a,b)=>({content:Buffer.from(bytes.slice(a,b)).toString('base64'),encoding:'base64',offset:a,next_offset:b,total:bytes.length,truncated:b<bytes.length,binary:true});
 const first=appendEvidencePage(undefined,page(0,8));const second=page(8,bytes.length);
 assert.equal(appendEvidencePage(first,second).text,text);assert.equal(appendEvidencePage(first,second).text,text);assert.equal(first.bytes.length,8);
});
