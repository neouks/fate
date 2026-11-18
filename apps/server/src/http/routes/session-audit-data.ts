import type {ArchivedRead,AuditMember,AuditRound,AuditSession,FactAudit,FactEvent,FactRow,ReadCounts} from '../session-audit-types.js';
// Read-only projections of saved PI messages. Never used to build agent input.
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import type {Database} from '../../db/index.js';
import {join} from 'node:path';

type Doc = Record<string, unknown>;
const object = (value:unknown):Doc => value && typeof value==='object' && !Array.isArray(value) ? value as Doc : {};
const list = (value:unknown):unknown[] => Array.isArray(value) ? value : [];
const integer = (value:unknown) => typeof value==='number' && Number.isSafeInteger(value) && value>=0 ? value : null;
function parse(text:unknown):unknown {
  if(typeof text!=='string')return text;
  try{return JSON.parse(text);}catch{return undefined;}
}

type Original = {session:string;round:number;kind:string;field?:string;start?:unknown;end?:unknown;content:unknown};
type Selection = {id:number;version:number;originals:Original[]};

// Historical byte accounting only. Retain digests and source locations, never another copy of the text.
function compareArchivedReads() {
  const first=new Map<string,{round:number;call:string;index:number}>();
  const ranges=new Map<string,Set<string>>();
  return (event:FactEvent,row:Doc,call:unknown,index:number):ArchivedRead|undefined=>{
    const body=event.kind==='read'?row.content:row.summary;
    if(event.kind==='submit'||typeof body!=='string'||!body)return;
    const receipt=object(row.read_receipt);
    const source=JSON.stringify([event.id,event.version,event.kind,row.field,row.view,row.offset_unit,
      receipt.coordinate,receipt.source_hash,receipt.total??row.total_chars]);
    const start=integer(receipt.start??row.offset),end=integer(receipt.end??row.next_offset);
    const range=JSON.stringify([start,end]);
    const digest=createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const key=JSON.stringify([source,range,digest]);
    const result:ArchivedRead={match:'distinct',originalBytes:Buffer.byteLength(JSON.stringify(body))};
    if(event.kind==='read'&&start!==null&&end!==null&&end>start){
      result.start=start;result.end=end;
      if(typeof receipt.source_hash==='string'&&receipt.source_hash){
        const prior=ranges.get(source)??new Set<string>();
        if(prior.size&&!prior.has(range))result.match='page';
        prior.add(range);ranges.set(source,prior);
      }
    }
    const prior=first.get(key);
    if(prior){
      result.match='identical';result.firstRound=prior.round;
      if(prior.call)result.referenceBytes=Buffer.byteLength(JSON.stringify({
        ref:row.ref,version:event.version,tool_call_id:prior.call,item_index:prior.index,
      }));
    }else first.set(key,{round:event.round,call:typeof call==='string'?call:'',index});
    return result;
  };
}

export async function inspectSession(file:string,name:string,allowed:Set<number>,selection?:Selection):Promise<AuditSession> {
  const session:AuditSession={name,rounds:[],warnings:[]};
  const calls=new Map<string,unknown[]>();
  let sizes=new Map<string,number>(),last:AuditRound|undefined,previousEntry:unknown;
  let largeOutputs:AuditRound['largeOutputs']=[];
  let compareRead=compareArchivedReads();
  const resetWindow=()=>{last=undefined;sizes.clear();calls.clear();largeOutputs=[];compareRead=compareArchivedReads();};
  const add=(label:string,bytes:number)=>sizes.set(label,(sizes.get(label)??0)+bytes);
  const warn=(message:string)=>{if(!session.warnings.includes(message))session.warnings.push(message);};
  let handle;
  try{handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    session.warnings.push('未找到会话日志');return session;
  }
  try{
    const stat=await handle.stat();
    if(!stat.isFile()||stat.nlink!==1)throw new Error('会话来源不是独立文件');
    if(!stat.size)return session;
    // Pin EOF so a concurrently appended turn cannot be observed halfway through this scan.
    const lines=createInterface({input:handle.createReadStream({end:stat.size-1,autoClose:false}),crlfDelay:Infinity});
    for await(const line of lines){
      if(!line.trim())continue;
      const parsed=parse(line);
      if(!parsed){warn('存在无法解析的日志行，轮次归因可能不完整');resetWindow();continue;}
      const entry=object(parsed);
      if(entry.type!=='session'&&entry.id){
        if(previousEntry && entry.parentId!==previousEntry){resetWindow();warn('日志含分支，分支起点单独计量');}
        previousEntry=entry.id;
      }
      if(entry.type==='compaction'){resetWindow();warn('存在上下文压缩，压缩边界单独计量');continue;}
      const m=object(entry.message);
      const blocks=list(m.content).map(object);
      if(m.role==='assistant'){
        const u=object(m.usage),input=integer(u.input),cacheRead=integer(u.cacheRead),cacheWrite=integer(u.cacheWrite);
        const measured=input!==null&&cacheRead!==null&&cacheWrite!==null?input+cacheRead+cacheWrite:null;
        const total=measured===0&&['error','aborted'].includes(String(m.stopReason))?null:measured;
        const round:AuditRound={number:session.rounds.length+1,input,cacheRead,cacheWrite,total,
          delta:last?.total!=null&&total!==null?total-last.total:null,
          additions:Array.from(sizes,([label,bytes])=>({label,bytes})).sort((a,b)=>b.bytes-a.bytes),largeOutputs,events:[]};
        session.rounds.push(round);last=round;sizes=new Map();largeOutputs=[];
        for(const b of blocks){
          if(b.type==='toolCall'){
            add(String(b.name)+' 参数 JSON',Buffer.byteLength(JSON.stringify(b.arguments??{})));
            if(b.name==='record_fact'&&typeof b.id==='string'&&selection){
              const args=object(parse(b.arguments));
              calls.set(b.id,Array.isArray(parse(args.facts))?list(parse(args.facts)).map(parse):[parse(args.fact)??args]);
            }
          }else if(typeof b.text==='string')add('模型文本',Buffer.byteLength(b.text));
          else if(typeof b.thinking==='string')add('思考文本',Buffer.byteLength(b.thinking));
        }
        continue;
      }
      if(m.role!=='toolResult'){
        const content=m.content??entry.content;
        if(content!==undefined)add('其他会话消息',Buffer.byteLength(typeof content==='string'?content:JSON.stringify(content)));
        continue;
      }
      const tool=String(m.toolName),text=blocks.flatMap(b=>typeof b.text==='string'?[b.text]:[]);
      const bytes=text.reduce((n,s)=>n+Buffer.byteLength(s),0);
      add(tool+' 输出',bytes);
      if(bytes>=4096)largeOutputs.push({label:tool,bytes});
      if(!last||!['record_fact','context_get','context_search'].includes(tool))continue;
      const result=object(parse(text[0]));
      const entries=tool==='record_fact'?(Array.isArray(result.results)?result.results:[result]):list(result.items);
      for(const [index,item] of entries.entries()){
        const row=object(item),receipt=object(row.read_receipt);
        if(row.error)continue;
        const id=tool==='record_fact'?integer(row.fact_id):Number(/^node:(\d+)$/.exec(String(row.ref))?.[1]);
        const version=integer(row.version);
        if(!id||!allowed.has(id)||version===null)continue;
        const kind=tool==='record_fact'?'submit':tool==='context_get'?'read':'search';
        const event:FactEvent={id,version,session:name,round:last.number,time:String(entry.timestamp??''),kind};
        if(!selection)event.comparison=compareRead(event,row,m.toolCallId,index);
        last.events.push(event);
        if(selection?.id===id&&selection.version===version){
          const content=kind==='submit'?calls.get(String(m.toolCallId))?.[index]:kind==='read'?row.content:row.summary;
          if(content!==undefined)selection.originals.push({session:name,round:last.number,kind,field:typeof row.field==='string'?row.field:undefined,
            start:receipt.start,end:receipt.end,content});
        }
      }
      calls.delete(String(m.toolCallId));
    }
  }finally{await handle.close();}
  return session;
}

export function groupFacts(facts:FactRow[],sessions:AuditSession[]):FactAudit {
  const members=new Map<string,AuditMember>();
  for(const fact of facts)members.set(fact.id+'@'+fact.version,{...fact,events:[]});
  const nodes=new Map(facts.map(f=>[f.id,f]));
  const all=sessions.flatMap(s=>s.rounds.flatMap(r=>r.events)).sort((a,b)=>a.time.localeCompare(b.time));
  for(const event of all){
    const key=event.id+'@'+event.version,current=nodes.get(event.id);
    if(!current)continue;
    let member=members.get(key);
    if(!member){
      member={...current,version:event.version,summary:'历史版本',signature:null,events:[]};
      members.set(key,member);
    }
    member.events.push(event);
  }
  const buckets=new Map<string,AuditMember[]>();
  let repeatCount=0;
  for(const member of members.values()){
    const refs=member.events.filter(e=>e.kind!=='submit');
    repeatCount+=refs.filter(e=>e!==member.events[0]).length;
    const group=member.signature??member.id+'@'+member.version;
    const bucket=buckets.get(group)??[];
    bucket.push(member);buckets.set(group,bucket);
  }
  const groups=[...buckets.values()].flatMap(bucket=>
    bucket.length>1&&new Set(bucket.map(m=>m.worker)).size>1?[bucket]:bucket.map(m=>[m]));
  const counts=():ReadCounts=>({items:0,pages:0,identical:0,netBytes:0});
  const reads={read:counts(),search:counts()};
  for(const event of all){
    if(event.kind==='submit'||!event.comparison)continue;
    const tally=reads[event.kind],c=event.comparison;
    tally.items++;
    if(c.match==='page')tally.pages++;
    if(c.match==='identical'){
      tally.identical++;
      if(c.referenceBytes!==undefined)tally.netBytes+=Math.max(0,c.originalBytes-c.referenceBytes);
    }
  }
  return {rawCount:facts.length,repeatCount,groups,sessions,reads};
}

// Only verified observations with identical original fields can share a display group.
export const factSignatureSQL = `CASE WHEN n.state='confirmed' AND n.payload->>'observation_type' IN ('observed','negative')
      AND nullif(n.payload->>'evidence','') IS NOT NULL AND nullif(n.payload->>'summary','') IS NOT NULL
      AND n.payload ? 'from_intent' AND n.payload->>'planner_attention' IS DISTINCT FROM 'conflict'
    THEN encode(sha256(convert_to(jsonb_build_array(n.payload->'summary',n.payload->'evidence',n.payload->'scope',
      n.payload->'observation_type',n.payload->'detail',n.payload->'confidence',n.payload->'planner_attention',
      ARRAY(SELECT asset_id FROM exploration_anchors WHERE node_id=n.id ORDER BY asset_id))::text,'UTF8')),'hex') END`;

export async function sessionAudit(db:Database,dataDir:string,expID:number,selected?:{id:number;version:number}) {
  // Fingerprint canonical PostgreSQL jsonb plus the sorted set of actual asset anchors.
  const facts=(await db.query(`SELECT n.id::text,n.content_version version,left(n.payload->>'summary',240) summary,
    COALESCE('Worker #'||(n.payload->>'from_intent'),nullif(n.origin,''),'来源未记录') worker,
    ${factSignatureSQL} signature
    FROM exploration_nodes n WHERE exploration_id=$1 AND kind='fact' AND state<>'origin'
    AND exploration_node_readable($1,n.id) ORDER BY n.id`,[expID])).rows.map(r=>({
      id:Number(r.id),version:Number(r.version),worker:String(r.worker),summary:String(r.summary??''),signature:r.signature as string|null}));
  const allowed=new Set(facts.map(f=>f.id));
  if(selected&&!allowed.has(selected.id))throw Object.assign(new Error('事实不可读取'),{statusCode:404});
  const intents=(await db.query(`SELECT id FROM exploration_nodes WHERE exploration_id=$1 AND kind='intent'
    AND exploration_node_readable($1,id) ORDER BY id`,[expID])).rows;
  const selection=selected?{...selected,originals:[] as Original[]}:undefined;
  const prefix=join(dataDir,'sessions','exp'+expID);
  const sessions=[await inspectSession(prefix+'-planner.jsonl','Planner',allowed,selection)];
  for(const intent of intents){
    const name='Worker #'+intent.id;
    sessions.push(await inspectSession(prefix+'-worker-i'+Number(intent.id)+'.jsonl',name,allowed,selection));
  }
  if(selection){
    const current=(await db.query(`SELECT payload,ARRAY(SELECT asset_id FROM exploration_anchors WHERE node_id=n.id ORDER BY asset_id) asset_ids
      FROM exploration_nodes n WHERE exploration_id=$1 AND id=$2 AND content_version=$3 AND exploration_node_readable($1,id)`,
      [expID,selection.id,selection.version])).rows[0];
    return {current:current??null,originals:selection.originals};
  }
  return groupFacts(facts,sessions);
}
