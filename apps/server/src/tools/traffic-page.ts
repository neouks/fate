import {createHash} from 'node:crypto';

export const trafficCursorSchema={type:'string',description:'原样使用返回的 next_cursor，保留查询条件；优先直接使用 next'};
const signature=(scope:unknown)=>createHash('sha256').update(JSON.stringify(scope)).digest('hex');
/** Keyset pagination avoids rereading older rows when new traffic arrives. */
export function trafficPagePosition(cursor:string|undefined,scope:unknown):[number|null,string]{
 if(!cursor)return [null,''];
 try{
  const page=JSON.parse(Buffer.from(cursor,'base64url').toString());
  if(page.signature!==signature(scope)||!Number.isSafeInteger(page.time)||page.time<0||typeof page.id!=='string'||!page.id)throw new Error();
  return [page.time,page.id];
 }catch{throw new Error('流量游标无效或查询条件已变化；保留原查询按 next 续页，修改查询时移除 cursor');}
}
export function trafficPageContinuation<T extends Record<string,unknown>>(args:T,scope:unknown,rows:Record<string,unknown>[],limit:number){
 const more=rows.length>limit,last=rows[limit-1];
 const cursor=more?Buffer.from(JSON.stringify({signature:signature(scope),time:Number(last!.captured_at),id:String(last!.id)})).toString('base64url'):null;
 return {has_more:more,next_cursor:cursor,...(cursor?{next:{...args,cursor}}:{})};
}
