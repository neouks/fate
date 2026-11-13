import {createHash} from 'node:crypto';
import type {Database} from '../db/index.js';
import type {ToolRunContext} from './context.js';
import type {Node} from '../db/exploration.js';
import {ToolResultError} from './errors.js';
import {writeAnchors,sameSource} from './write-origin.js';
import {archiveReport,prepareReproduction,attachStepTraffic,type Reproduction} from '../evidence/reproduction.js';
import {bindEvidence} from '../evidence/store.js';
import {normalizeWritebackScope,writebackReceipt,savedWritebackReceipt,type WritebackScope} from './writeback-scope.js';

export interface FindingWriteArgs {
  finding_id?:number; evidence_version?:number;
  vulnclass?:string; name?:string; severity?:'critical'|'high'|'medium'|'low'; summary?:string;
  evidence?:string; asset_ids?:number[]; scope?:WritebackScope; reproduction?:unknown;
  traffic_refs?:Array<{traffic_id:string;role?:string;note?:string}>;
  distinct_from?:number[]; distinct_reason?:string;
}


const canonical=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
export const findingRequestHash=(args:FindingWriteArgs)=>createHash('sha256').update(canonical(args)).digest('hex');
export const findingSourceKey=(c:ToolRunContext,origin:Node)=>`${c.role}:${origin.id}:${c.conversationID??c.mainSegment??''}`;
const norm=(v:unknown)=>String(v??'').trim().toLowerCase().replace(/\s+/g,' ');
const raw=(v:unknown)=>String(v??'').trim().replace(/\r\n/g,'\n');
const trigrams=(text:string)=>{const s=Array.from(norm(text)),set=new Set<string>();for(let i=0;i<s.length-2;i++)set.add(s.slice(i,i+3).join(''));return set;};
export function findingSimilarity(a:string,b:string){
  if(norm(a)===norm(b))return 1;
  const x=trigrams(a),y=trigrams(b);if(!x.size||!y.size)return 0;
  return 2*[...x].filter(k=>y.has(k)).length/(x.size+y.size);
}

/** Exact repeats reuse a row; resemblance requires explicit review, never an automatic merge. */
export async function findDuplicate(c:ToolRunContext,origin:Node,args:FindingWriteArgs,assets:number[]) {
  const candidates:Array<Record<string,unknown>>=[];let after=0,total=0;
  const exclusions=new Set(args.distinct_from??[]);
  for(;;){
    const rows=(await c.db.query(`SELECT f.id,f.node_id,f.summary,f.evidence,f.asset_ids,f.evidence_version,n.payload
      FROM findings f JOIN exploration_nodes n ON n.id=f.node_id
      WHERE f.task_id=$1 AND lower(btrim(f.vulnclass))=$2 AND f.id>$3 AND finding_readable(f.id)
      ORDER BY f.id LIMIT 100`,[c.taskID,norm(args.vulnclass),after])).rows;
    if(!rows.length)break;
    for(const row of rows){
      after=Number(row.id);
      const oldAssets=(row.asset_ids??[]) as number[];
      const overlap=oldAssets.some(id=>assets.includes(id));
      const originMatch=sameSource(c,origin,row.payload as Record<string,unknown>);
      // Disjoint explicit assets may represent independent issues even with identical titles.
      const identical=norm(row.summary)===norm(args.summary)&&raw(row.evidence)===raw(args.evidence);
      const evidenceMatch=raw(row.evidence).length>=20&&raw(row.evidence)===raw(args.evidence);
      const incompleteAssets=!oldAssets.length||!assets.length;
      if(!overlap&&!(originMatch&&incompleteAssets)&&!(evidenceMatch&&incompleteAssets))continue;
      // Unknown ownership is a review candidate, not proof that two issues are the same.
      if(identical&&!originMatch&&!overlap){
        if(exclusions.has(Number(row.id)))continue;
        total++;
        if(candidates.length<10)candidates.push({finding_id:Number(row.id),finding_node_id:Number(row.node_id),evidence_version:Number(row.evidence_version),summary:String(row.summary).slice(0,500),asset_ids:oldAssets});
        continue;
      }
      if(!identical&&!evidenceMatch&&findingSimilarity(String(row.summary),args.summary??'')<0.72)continue;
      if(identical)return {duplicate:row};
      if(exclusions.has(Number(row.id)))continue;
      total++;
      if(candidates.length<10)candidates.push({finding_id:Number(row.id),finding_node_id:Number(row.node_id),evidence_version:Number(row.evidence_version),summary:String(row.summary).slice(0,500),asset_ids:oldAssets});
    }
  }
  if(total)throw new ToolResultError('发现疑似重复漏洞；核对已有记录后使用 finding_id + evidence_version 补正。独立机理才填写 distinct_from 和 distinct_reason 创建。',{
    code:'FINDING_DUPLICATE_REVIEW',candidates,total,has_more:total>candidates.length,
  });
  return {};
}

export function findingReceipt(row:Record<string,unknown>,extra:Record<string,unknown>={}):Record<string,unknown> {
  return {finding_id:Number(row.id),finding_node_id:Number(row.node_id),evidence_version:Number(row.evidence_version),
    asset_ids:row.asset_ids??[],writeback:savedWritebackReceipt((row.payload as Record<string,unknown>)?.writeback),...extra};
}

/** Only append new steps. Replacing evidence or the original exploit chain is a separate human edit. */
export function mergeFindingReproduction(old:Reproduction|null,addition:Reproduction|null):Reproduction|null {
  if(!addition)return old;
  if(!old)return addition;
  const steps=structuredClone(old.steps);
  const fingerprint=(s:Reproduction['steps'][number])=>canonical({action:s.action,request:s.request,response:s.response,proves:s.proves,traffic_id:s.traffic_id,source:s.source,source_ref:s.source_ref});
  for(const step of addition.steps){
    if(steps.some(s=>fingerprint(s)===fingerprint(step)))continue;
    if(steps.some(s=>s.id===step.id))throw new Error('补充步骤 ID 与已有步骤冲突；保留旧步骤，新增步骤使用新 ID');
    steps.push(step);
  }
  if(steps.length>100)throw new Error('合并后的复现步骤超过 100 项；请引用证据，勿重复抄写步骤');
  return {...old,entry_point:old.entry_point||addition.entry_point,
    prerequisites:[...new Set([...old.prerequisites,...addition.prerequisites])],
    provenance:[...new Set([old.provenance,addition.provenance].filter(Boolean))].join('\n'),steps};
}

export async function amendFinding(c:ToolRunContext,origin:Node,args:FindingWriteArgs) {
  const db=c.db;
  const f=(await db.query(`SELECT f.*,n.payload FROM findings f JOIN exploration_nodes n ON n.id=f.node_id
    WHERE f.id=$1 AND f.task_id=$2 AND n.exploration_id=$3 AND finding_readable(f.id) FOR UPDATE OF f`,[args.finding_id,c.taskID,c.expID])).rows[0];
  if(!f)throw new ToolResultError('漏洞不存在或不属于当前任务；来源任务只读，请核对漏洞记录编号', {code:'FINDING_NOT_WRITABLE'});
  if(Number(f.evidence_version)!==args.evidence_version)throw new ToolResultError('证据版本已变化，请重新读取后补正，不要重新报洞',{
    code:'FINDING_VERSION_CONFLICT',finding_id:Number(f.id),evidence_version:Number(f.evidence_version),
  });
  // Compatible calls may include unchanged original fields, but cannot silently alter the issue.
  for(const key of ['vulnclass','name','severity','summary'] as const)
    if(args[key]!==undefined&&args[key]!==f[key])throw new Error(`补正不能改变 ${key}；本入口只补充资产、证据、复现与范围`);
  const assets=await writeAnchors(c,origin,[...new Set([...(f.asset_ids as number[]),...(args.asset_ids??[])])]);
  const addition=args.evidence?.trim()??'';
  const alreadyRecorded=addition&&(raw(f.evidence).includes(raw(addition))||(await db.query(`SELECT 1 FROM finding_evidence_amendments
    WHERE finding_id=$1 AND changes->>'evidence'=$2 LIMIT 1`,[f.id,addition])).rowCount);
  const evidence=addition&&!alreadyRecorded?String(f.evidence)+(f.evidence?'\n\n':'')+addition:String(f.evidence);
  const newRepro=await prepareReproduction(db,args.reproduction,{taskID:c.taskID,intentID:c.intentID,evidence});
  const reproduction=mergeFindingReproduction(f.reproduction as Reproduction|null,newRepro);
  const payload=f.payload as Record<string,unknown>;
  const oldScope=payload.scope as WritebackScope|undefined,newScope=normalizeWritebackScope(args.scope);
  // Supplemental scope must not erase earlier limitations or untested caveats.
  const scope=newScope?normalizeWritebackScope(Object.fromEntries(['tested','not_tested','limitations'].map(key=>[key,
    [...new Set([oldScope?.[key as keyof WritebackScope],newScope[key as keyof WritebackScope]].filter(Boolean))].join('\n')]))):oldScope;
  const beforeBindings=(await db.query('SELECT snapshot_id FROM finding_traffic_bindings WHERE finding_id=$1',[f.id])).rows.map(r=>String(r.snapshot_id));
  const refs=[...new Set([...(args.traffic_refs??[]).map(r=>r.traffic_id),...(newRepro?.steps.flatMap(s=>s.traffic_id?[s.traffic_id]:[])??[])])];
  // Validate even repeated references. All changes roll back if any reference is invalid.
  if(args.traffic_refs?.length)await bindEvidence(db,Number(f.id),args.traffic_refs,c.taskID,{bumpVersion:false});
  await attachStepTraffic(db,Number(f.id),c.taskID,newRepro,{bumpVersion:false});
  const changed=canonical(assets)!==canonical([...(f.asset_ids as number[])].sort((a,b)=>a-b))||evidence!==f.evidence||
    canonical(reproduction)!==canonical(f.reproduction)||canonical(scope)!==canonical(payload.scope)||refs.some(id=>!beforeBindings.includes(id));
  if(!changed){
    return findingReceipt(f,{created:false,updated:false});
  }
  const version=Number(f.evidence_version)+1;
  const receipt=writebackReceipt(assets,scope,evidence,'finding');
  await archiveReport(db,f);
  await db.query(`INSERT INTO finding_evidence_amendments(finding_id,task_id,evidence_version,source_key,call_id,before_record,changes)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[f.id,c.taskID,version,findingSourceKey(c,origin),c.toolCallID??null,
    {asset_ids:f.asset_ids,evidence:f.evidence,reproduction:f.reproduction,payload,report_revision:f.report_revision,evidence_version:f.evidence_version},
    {asset_ids:args.asset_ids??[],evidence:addition,traffic_refs:args.traffic_refs??[],reproduction:newRepro,scope:args.scope??null}]);
  await db.query(`UPDATE findings SET asset_ids=$2,evidence=$3,reproduction=$4,evidence_version=$5,report_revision=report_revision+1 WHERE id=$1`,
    [f.id,JSON.stringify(assets),evidence,reproduction,version]);
  for(const asset of assets)await db.exploration(c.expID).anchor(Number(f.node_id),asset);
  // Preserve original origin. The amendment audit records the supplementing actor separately.
  await db.query(`UPDATE exploration_nodes SET payload=payload||$2::jsonb,updated_at=now() WHERE id=$1`,
    [f.node_id,JSON.stringify({...(scope?{scope}:{}),writeback:receipt,finding_evidence_version:version})]);
  await db.query(`INSERT INTO blackboard_wakeups(exploration_id,event_key,kind,node_id)
    VALUES($1,$2,'finding_published',$3) ON CONFLICT DO NOTHING`,[c.expID,`finding:${f.node_id}:evidence:${version}`,f.node_id]);
  return findingReceipt({...f,asset_ids:assets,evidence_version:version,payload:{...payload,writeback:receipt}}, {created:false,updated:true});
}

export async function readFindingWriteReceipt(db:Database,c:ToolRunContext,origin:Node,args:FindingWriteArgs):Promise<Record<string,unknown>|undefined>{
  if(!c.toolCallID)return;
  const row=(await db.query('SELECT * FROM finding_write_receipts WHERE task_id=$1 AND call_id=$2',[c.taskID,c.toolCallID])).rows[0];
  if(!row)return;
  if(row.source_key!==findingSourceKey(c,origin)||row.request_hash!==findingRequestHash(args))throw new Error('工具调用编号已被不同来源或参数使用');
  if(!(await db.query('SELECT 1 FROM findings WHERE id=$1 AND task_id=$2 AND finding_readable(id)',[row.finding_id,c.taskID])).rowCount)throw new Error('原漏洞已不可读取');
  return {...row.result as Record<string,unknown>,replayed:true};
}
export async function saveFindingWriteReceipt(db:Database,c:ToolRunContext,origin:Node,args:FindingWriteArgs,result:Record<string,unknown>){
  if(c.toolCallID)await db.query(`INSERT INTO finding_write_receipts(task_id,call_id,source_key,request_hash,finding_id,result)
    VALUES($1,$2,$3,$4,$5,$6)`,[c.taskID,c.toolCallID,findingSourceKey(c,origin),findingRequestHash(args),result.finding_id,result]);
}
