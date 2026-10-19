import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,link,rm,open} from 'node:fs/promises';
import path from 'node:path';
import type {Database} from '../db/index.js';
const roots=new WeakMap<object,string>();
export function configureEvidenceStore(db:Database,dataDir:string){roots.set(db.pool,path.resolve(dataDir,'evidence'));}
export async function putBlob(db:Database,bytes:Buffer){
 const hash=createHash('sha256').update(bytes).digest('hex'),root=roots.get(db.pool);
 if(!root){await db.query('INSERT INTO evidence_blobs(hash,bytes) VALUES($1,$2) ON CONFLICT DO NOTHING',[hash,bytes]);return hash;}
 return db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4818))',[hash]);
  const relative=path.join(hash.slice(0,2),hash),filename=path.join(root,relative),temporary=filename+'.'+randomUUID();
  await mkdir(path.dirname(filename),{recursive:true});
  try{
   await writeFile(temporary,bytes,{flag:'wx',mode:0o600});
   try{await link(temporary,filename);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
   await tx.query('INSERT INTO evidence_blobs(hash,bytes,file_path,size) VALUES($1,NULL,$2,$3) ON CONFLICT DO NOTHING',[hash,relative,bytes.length]);
  }finally{await rm(temporary,{force:true});}
  return hash;
 });
}

/** Called after a failed upload transaction; the per-hash lock protects a
 * concurrent upload that may be committing the same content. */
export async function cleanupOrphanBlobs(db:Database,hashes:Iterable<string>){
 const root=roots.get(db.pool);if(!root)return;
 for(const hash of hashes){if(!/^[a-f0-9]{64}$/.test(hash))continue;
  await db.transaction(async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4818))',[hash]);
   if(!(await tx.query('SELECT hash FROM evidence_blobs WHERE hash=$1',[hash])).rowCount)await rm(path.join(root,hash.slice(0,2),hash),{force:true});
  });
 }
}
export async function readBlob(db:Database,hash:string){
 const row=(await db.query('SELECT bytes,file_path FROM evidence_blobs WHERE hash=$1',[hash])).rows[0];
 if(!row)throw Object.assign(new Error('证据正文不存在'),{statusCode:404});
 if(row.bytes!==null)return row.bytes as Buffer;
 const root=roots.get(db.pool);if(!root||!row.file_path||!(/^[a-f0-9]{64}$/.test(hash)))throw new Error('证据存储未配置');
 const expected=path.join(hash.slice(0,2),hash);if(row.file_path!==expected)throw new Error('无效证据路径');
 return readFile(path.join(root,expected));
}

/** Bounded read for evidence pagination; immutable hashes keep cursors stable. */
export async function readBlobRange(db:Database,hash:string,offset:number,limit:number){
 const row=(await db.query('SELECT file_path,COALESCE(octet_length(bytes),size) AS total,substring(bytes FROM $2::int+1 FOR $3::int) AS part FROM evidence_blobs WHERE hash=$1',[hash,offset,limit])).rows[0];
 if(!row)throw Object.assign(new Error('证据正文不存在'),{statusCode:404});
 const total=Number(row.total),start=Math.min(offset,total);
 if(row.part!==null)return {bytes:row.part as Buffer,total,start};
 const root=roots.get(db.pool),expected=path.join(hash.slice(0,2),hash);
 if(!root||!/^[a-f0-9]{64}$/.test(hash)||row.file_path!==expected)throw new Error('无效证据路径');
 const handle=await open(path.join(root,expected),'r');
 try{const bytes=Buffer.alloc(Math.min(limit,Math.max(0,total-start)));const read=await handle.read(bytes,0,bytes.length,start);return {bytes:bytes.subarray(0,read.bytesRead),total,start};}finally{await handle.close();}
}
/** Search decoded text in bounded windows, including UTF-8 and query boundaries. */
export async function blobContains(db:Database,hash:string,query:string){
 const needle=query.toLocaleLowerCase(),decoder=new TextDecoder();let offset=0,tail='';
 for(;;){const page=await readBlobRange(db,hash,offset,65536),next=page.start+page.bytes.length;
  const text=tail+decoder.decode(page.bytes,{stream:next<page.total}).toLocaleLowerCase();
  if(text.includes(needle))return true;if(next>=page.total||next<=offset)return false;
  tail=needle.length>1?text.slice(1-needle.length):'';offset=next;
 }
}
