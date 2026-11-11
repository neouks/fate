import type {FastifyInstance} from 'fastify';
import {conversationReadable} from '../activity-stream.js';
import {readTurnSummaries,readTurnModelName} from '../../engine/turn-summary.js';
import {isFinishedFileChangeTurn,readTurnFileChange,readTurnFileChangePage} from '../../db/turn-file-changes.js';

const validTurnID=(id:string)=>id.length<=240&&/^[\w:-]+$/.test(id);
const validCursor=(id:string)=>/^(?:0|[1-9]\d{0,18})$/.test(id)&&BigInt(id)<=9223372036854775807n;

export function registerTurnRoutes(app:FastifyInstance){
 for(const scope of ['tasks','conversations'] as const){
  const base=`/api/${scope}/:id/turns/:turnId/file-changes`;
  for(const url of [base,`${base}/:changeId`])app.get(url,async(req,reply)=>{
   const {id:rawID,turnId,changeId}=req.params as {id:string;turnId:string;changeId?:string};
   const {cursor='0'}=req.query as {cursor?:string};
   const id=Number(rawID),kind=scope==='tasks'?'task':'conversation';
   if(!Number.isSafeInteger(id)||id<1||!validTurnID(turnId)||
      typeof cursor!=='string'||!validCursor(cursor)||changeId!==undefined&&(!validCursor(changeId)||changeId==='0')){
    return reply.code(400).send({error:'无效的轮次、文件标识或续读位置'});
   }
   const task=kind==='task'?await app.db.tasks().getTask(id):null;
   if(kind==='task'?!task:!await conversationReadable(app.db,id))return reply.code(404).send({error:'会话或任务不存在'});
   const [turn]=await readTurnSummaries(app.db,kind,task?.exploration_id??id,[turnId]);
   if(!turn||!isFinishedFileChangeTurn(turn))return reply.code(404).send({error:'本轮文件改动不可查看'});
   const fileScope={kind,id,turnID:turnId} as const;
   reply.header('Cache-Control','private, no-store');
   if(!changeId)return readTurnFileChangePage(app.db,fileScope,cursor);
   const change=await readTurnFileChange(app.db,fileScope,changeId);
   if(!change)return reply.code(404).send({error:'文件改动不存在'});
   return change;
  });
 }
 for(const scope of ['tasks','conversations'] as const)app.get(`/api/${scope}/:id/turns`,async(req,reply)=>{
  const id=Number((req.params as {id:string}).id);
  const q=req.query as Record<string,string|undefined>;
  const ids=[...new Set(String(q.ids??'').split(',').filter(Boolean))];
  if(!Number.isSafeInteger(id)||id<1||!ids.length||ids.length>100||ids.some(s=>!validTurnID(s)))return reply.code(400).send({error:'需要有效范围及最多 100 个 turn_id'});
  const task=scope==='tasks'?await app.db.tasks().getTask(id):null;
  if(scope==='tasks'?!task:!await conversationReadable(app.db,id))return reply.code(404).send({error:'会话或任务不存在'});
  const integer=(key:string)=>q[key]===undefined?0:/^\d+$/.test(q[key]!)&&Number.isSafeInteger(Number(q[key]))&&Number(q[key])<=2147483646?Number(q[key]):NaN;
  const offset=integer('models_offset'),nameIndex=integer('name_index'),nameOffset=integer('name_offset');
  if(![offset,nameIndex,nameOffset].every(Number.isFinite)||q.models_offset!==undefined&&ids.length!==1||q.name_index!==undefined&&ids.length!==1||q.data_revision!==undefined&&!/^\d{1,40}$/.test(q.data_revision))return reply.code(400).send({error:'续读需要单个轮次和有效位置、版本'});
  const domain=scope==='tasks'?'task':'conversation',activityID=task?.exploration_id??id;
  if(q.name_index!==undefined){
   if(!q.data_revision)return reply.code(400).send({error:'名称续读需要 data_revision'});
   return {name:await readTurnModelName(app.db,domain,activityID,ids[0]!,nameIndex,nameOffset,q.data_revision)};
  }
  const items=await readTurnSummaries(app.db,domain,activityID,ids,offset);
  if(q.data_revision&&items.some(s=>s.data_revision!==q.data_revision))return reply.code(409).send({error:'本轮记录已变化，请重新打开详情'});
  return {items};
 });
}
