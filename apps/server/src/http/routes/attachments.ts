import type {FastifyInstance} from 'fastify';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
export function registerAttachmentRoutes(app:FastifyInstance){
 app.post('/api/chat/upload',async req=>{
  const q=req.query as {scope:string;id:string};let task:number|null=null,conversation:number|null=null;
  if(q.scope==='task'){task=Number(q.id);if(!await app.db.tasks().getTask(task))throw Object.assign(new Error('task not found'),{statusCode:404});}
  else if(q.scope==='session'){conversation=Number(q.id);if(!(await app.db.query('SELECT id FROM conversations WHERE id=$1',[conversation])).rowCount)throw Object.assign(new Error('conversation not found'),{statusCode:404});}
  else if(q.scope!=='staging')throw Object.assign(new Error('无效上传 scope'),{statusCode:400});
  const attachments:unknown[]=[];
  for await(const part of req.files({limits:{files:8,fileSize:10*1024*1024}})){
   const bytes=await part.toBuffer(),id=randomUUID(),name=path.basename(part.filename).replace(/[\x00-\x1f]/g,'_');
   const relative=`artifacts/${id}/${name||'file'}`,absolute=path.join(app.dataDir,relative);
   await mkdir(path.dirname(absolute),{recursive:true});await writeFile(absolute,bytes,{flag:'wx',mode:0o600});
   try{await app.db.query("INSERT INTO evidence_blobs(hash,bytes) VALUES($1,$2) ON CONFLICT DO NOTHING",[createHash("sha256").update(bytes).digest("hex"),bytes]);await app.db.query(`INSERT INTO chat_artifacts(id,task_id,conversation_id,name,path,mime,size,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,task,conversation,name,relative,part.mimetype,bytes.length,createHash('sha256').update(bytes).digest('hex')]);}
   catch(error){await rm(absolute,{force:true});throw error;}
   attachments.push({name,path:relative,size:bytes.length});
  }
  return {attachments};
 });
 app.get('/api/tasks/:id/attachments',async req=>({attachments:(await app.db.query('SELECT name,path,size,mime,sha256 FROM chat_artifacts WHERE task_id=$1 ORDER BY created_at',[Number((req.params as {id:string}).id)])).rows}));
}
