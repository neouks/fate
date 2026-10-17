import type {FastifyInstance} from 'fastify';
import {bindEvidence,evidenceBody,findingEvidence} from '../../evidence/store.js';
export function registerEvidenceRoutes(app:FastifyInstance){
 const db=app.db;
 const finding=async(id:number,context?:number,write=false)=>{
  const f=(await db.query('SELECT * FROM findings WHERE id=$1',[id])).rows[0];
  if(!f)throw Object.assign(new Error('finding not found'),{statusCode:404});
  if(context&&context!==Number(f.task_id)){
   const source=await db.query('SELECT 1 FROM task_relations WHERE task_id=$1 AND source_task_id=$2',[context,f.task_id]);
   if(write||!source.rowCount)throw Object.assign(new Error('来源任务证据只读或不可访问'),{statusCode:403});
  }return f;
 };
 const snapshot=async(id:number,bid:string)=>{const r=await db.query('SELECT snapshot_id FROM finding_traffic_bindings WHERE finding_id=$1 AND id=$2',[id,bid]);if(!r.rowCount)throw Object.assign(new Error('binding not found'),{statusCode:404});return String(r.rows[0]!.snapshot_id);};
 app.get('/api/traffic',async req=>{
  const q=req.query as Record<string,string>;const page=Math.max(0,Number(q.page)||0),size=Math.min(500,Math.max(1,Number(q.size)||100));
  const args:unknown[]=[];const where:string[]=[];
  for(const [key,col] of [['host','e.host'],['method','s.method'],['status','s.status::text']] as const)if(q[key]){args.push(q[key]);where.push(`${col}=$${args.length}`);}
  for(const key of ['q','path','body'])if(q[key]){args.push('%'+q[key]+'%');where.push(`${key==='body'?"encode(b.bytes,'escape')":'s.url'} ILIKE $${args.length}`);}
  for(const [key,op] of [['resp_min','>='],['resp_max','<=']] as const)if(Number(q[key])>=0){args.push(Number(q[key]));where.push(`s.resp_len${op}$${args.length}`);}
  const from=`FROM traffic_exchanges e JOIN traffic_evidence_snapshots s ON s.id=e.id ${q.body?'JOIN evidence_blobs b ON b.hash=s.resp_hash':''}`;
  const filter=where.length?' WHERE '+where.join(' AND '):'';
  const count=await db.query(`SELECT count(*) n ${from}${filter}`,args);
  const order=q.order==='asc'?'ASC':'DESC',sort=q.sort==='resp_len'?'s.resp_len':q.sort==='status'?'s.status':'s.captured_at';
  const rows=await db.query(`SELECT s.id,s.captured_at AS ts,e.host,s.method,s.url,s.status,s.content_type,s.resp_len,e.task_id,e.truncated ${from}${filter} ORDER BY ${sort} ${order},s.id LIMIT ${size} OFFSET ${page*size}`,args);
  return {enabled:true,capture_mode:'native HTTP tools; CONNECT tunnels remain opaque',page,size,total:Number(count.rows[0]?.n),exchanges:rows.rows.map(r=>({...r,ts:new Date(Number(r.ts)).toISOString(),resp_len:Number(r.resp_len)}))};
 });
 app.get('/api/traffic/exchange',async req=>{
  const id=String((req.query as {id:string}).id);const row=(await db.query('SELECT s.* FROM traffic_exchanges e JOIN traffic_evidence_snapshots s ON s.id=e.id WHERE e.id=$1',[id])).rows[0];
  if(!row)throw Object.assign(new Error('traffic not found'),{statusCode:404});
  const request=await evidenceBody(db,id,'request'),response=await evidenceBody(db,id,'response');
  return {req:row.req_head+'\r\n\r\n'+request.content,resp:row.resp_head+'\r\n\r\n'+response.content,request,response};
 });
 app.get('/api/traffic/hosts',async()=>({hosts:(await db.query('SELECT host,count(*)::int count FROM traffic_exchanges GROUP BY host ORDER BY count(*) DESC')).rows}));
 app.delete('/api/traffic',async req=>({deleted:(await db.query('DELETE FROM traffic_exchanges WHERE host=$1',[(req.query as {host:string}).host])).rowCount}));
 app.delete('/api/traffic/hosts',async req=>({deleted:(await db.query('DELETE FROM traffic_exchanges WHERE host=ANY($1::text[])',[(req.body as {hosts:string[]}).hosts])).rowCount}));
 app.delete('/api/traffic/all',async()=>({deleted:(await db.query('DELETE FROM traffic_exchanges')).rowCount,reclaimed:0}));
 const base='/api/exploration/findings/:id/traffic';
 app.get(base,async req=>{const id=Number((req.params as {id:string}).id);await finding(id,Number((req.query as {context_task?:string}).context_task));return findingEvidence(db,id);});
 app.post(base,async req=>{
  const id=Number((req.params as {id:string}).id),f=await finding(id,Number((req.query as {context_task?:string}).context_task),true);
  const refs=(req.body as {traffic_refs?:Array<{traffic_id:string;role?:string;note?:string}>}).traffic_refs;
  if(!Array.isArray(refs)||refs.length>100)throw Object.assign(new Error('traffic_refs 必须为不超过 100 项的数组'),{statusCode:400});
  return db.transaction(tx=>bindEvidence(tx,id,refs,Number(f.task_id)));
 });
 for(const method of ['PATCH','DELETE','PUT'] as const)app.route({method,url:base+(method==='PUT'?'/order':'/:bid'),handler:async req=>{
  const p=req.params as {id:string;bid?:string},id=Number(p.id),body=req.body as {version:number;role?:string;note?:string;binding_ids?:string[]};
  await finding(id,Number((req.query as {context_task?:string}).context_task),true);
  return db.transaction(async tx=>{
   const f=(await tx.query('SELECT evidence_version FROM findings WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(Number(f?.evidence_version)!==Number(body.version))throw Object.assign(new Error('证据版本已变化，请刷新'),{statusCode:409});
   if(method==='PUT'){
    const ids=(await tx.query('SELECT id::text FROM finding_traffic_bindings WHERE finding_id=$1',[id])).rows.map(r=>String(r.id));
    if(!body.binding_ids||ids.length!==body.binding_ids.length||new Set(body.binding_ids).size!==ids.length||body.binding_ids.some(v=>!ids.includes(v)))throw Object.assign(new Error('必须提交完整绑定顺序'),{statusCode:400});
    for(const [position,bid] of body.binding_ids.entries())await tx.query('UPDATE finding_traffic_bindings SET position=$3 WHERE id=$1 AND finding_id=$2',[bid,id,position]);
   }else{
    await snapshot(id,p.bid!);
    if(method==='DELETE')await tx.query('DELETE FROM finding_traffic_bindings WHERE id=$1 AND finding_id=$2',[p.bid,id]);
    else{if(!['baseline','proof','verification','supporting'].includes(body.role??''))throw Object.assign(new Error('无效证据角色'),{statusCode:400});await tx.query('UPDATE finding_traffic_bindings SET role=$3,note=$4 WHERE id=$1 AND finding_id=$2',[p.bid,id,body.role,body.note??'']);}
   }
   await tx.query('UPDATE findings SET evidence_version=evidence_version+1 WHERE id=$1',[id]);return findingEvidence(tx,id);
  });
 }});
 app.get(base+'/:bid',async req=>{
  const p=req.params as {id:string;bid:string};await finding(Number(p.id),Number((req.query as {context_task?:string}).context_task));
  const sid=await snapshot(Number(p.id),p.bid),all=await findingEvidence(db,Number(p.id));
  return {binding:all.bindings.find(b=>String(b.id)===p.bid),request:await evidenceBody(db,sid,'request'),response:await evidenceBody(db,sid,'response')};
 });
 app.get(base+'/:bid/body',async(req,reply)=>{
  const p=req.params as {id:string;bid:string},q=req.query as Record<string,string>;await finding(Number(p.id),Number(q.context_task));
  const sid=await snapshot(Number(p.id),p.bid);
  if(q.download==='1'){const r=await db.query(`SELECT b.bytes FROM traffic_evidence_snapshots s JOIN evidence_blobs b ON b.hash=s.${q.side==='request'?'req_hash':'resp_hash'} WHERE s.id=$1`,[sid]);return reply.type('application/octet-stream').send(r.rows[0]?.bytes);}
  return evidenceBody(db,sid,q.side??'response',Number(q.offset)||0);
 });
}
