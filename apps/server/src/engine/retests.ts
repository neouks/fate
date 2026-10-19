import {LiveStreamWriter,runnerActivityMetadata} from './live-stream.js';
import {systemRolePrompt,constraintBlock,hostProtocol} from '../agent/prompts.js';
import {createTrackedRunner} from './runtime-config.js';
import {leaseWatchdog} from './lease-watchdog.js';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import type {Database} from '../db/index.js';
import type {ModelResolver} from './engine.js';
import {AgentRunner,type RunnerActivity} from '../pi/runner.js';
import {agentRunConfig,agentBudgets,applyToolBindings} from '../agent/roles.js';
import {roleResources} from '../agent/resources.js';
import {runContext} from '../tools/context.js';
import {domainTool} from '../tools/define.js';
import {httpRequestTool,trafficBodyTool,readAttachmentTool} from '../tools/evidence.js';
import {listAssetsTool} from '../tools/assets.js';
import {interceptGate} from '../intercept/gate.js';
import {loadConstraints} from "../tools/index.js";
import {skillDir} from '../config/index.js';
import {toolOutputTool} from '../tools/output.js';
import {contextSearchTool,contextGetTool} from '../tools/context-read.js';
import {findingEvidence} from '../evidence/store.js';

type RetestTarget={host:string;port:number|null};
async function findingTargets(db:Database,finding:Record<string,unknown>,evidence:Awaited<ReturnType<typeof findingEvidence>>):Promise<RetestTarget[]>{
 const targets:RetestTarget[]=[];
 const addURL=(raw:unknown)=>{try{const url=new URL(String(raw));if(['http:','https:'].includes(url.protocol))targets.push({host:url.hostname.toLowerCase(),port:Number(url.port)||(url.protocol==='https:'?443:80)});}catch{/* malformed data grants no network access */}};
 for(const row of evidence.bindings)addURL((row.snapshot as Record<string,unknown>)?.url);
 const assets=await db.assets().getByIDs(Array.isArray(finding.asset_ids)?finding.asset_ids.map(Number):[]);
 for(const asset of assets){
  if(asset.url)addURL(asset.url);
  for(const host of [asset.domain,asset.ip].filter(Boolean))targets.push({host:String(host).toLowerCase(),port:asset.port||null});
 }
 return targets.filter((t,i)=>!(t.port===null&&targets.some(x=>x.host===t.host&&x.port!==null))&&targets.findIndex(x=>x.host===t.host&&x.port===t.port)===i);
}

/** Independent pi retester. Only a newly completed fixed verdict changes triage. */
export class RetestService {
 private active=new Map<number,{controller:AbortController;done:Promise<void>}>();
 private owner=randomUUID();
 constructor(private db:Database,private resolve:ModelResolver,private dataDir:string,private workers:number,private egress?:string){}
 async create(findingID:number,notes:string){
  const result=await this.db.transaction(async tx=>{
   const finding=(await tx.query('SELECT * FROM findings WHERE id=$1 AND finding_readable(id) FOR UPDATE',[findingID])).rows[0];
   if(!finding||!finding.task_id)throw Object.assign(new Error('漏洞不存在或已失去来源任务'),{statusCode:404});
   const existing=await tx.query("SELECT * FROM finding_retests WHERE finding_id=$1 AND status IN ('pending','running')",[findingID]);
   if(existing.rows[0])return {retest:existing.rows[0],created:false};
   const conv=await tx.query("INSERT INTO conversations(agent_key,title) VALUES('retester',$1) RETURNING id",[`复测：${finding.name||finding.vulnclass}`]);
   const evidence=await findingEvidence(tx,findingID);
   const snapshot={...finding,traffic_evidence:evidence,scope_targets:await findingTargets(tx,finding,evidence)};
   const row=await tx.query('INSERT INTO finding_retests(finding_id,conversation_id,notes,snapshot) VALUES($1,$2,$3,$4::jsonb) RETURNING *',[findingID,conv.rows[0]!.id,notes,JSON.stringify(snapshot)]);
   return {retest:row.rows[0]!,created:true};
  });
  this.kick(Number(result.retest.id));return result;
 }
 async pump(){await this.db.query("UPDATE finding_retests SET status='stopped',finished_at=now() WHERE stop_requested AND status IN ('pending','running') AND (lease_until IS NULL OR lease_until<=now())");const rows=await this.db.query("SELECT id FROM finding_retests WHERE NOT stop_requested AND (status='pending' OR (status='running' AND (lease_until IS NULL OR lease_until<now()))) ORDER BY id LIMIT 32");for(const r of rows.rows)this.kick(Number(r.id));}
 private kick(id:number){if(this.active.has(id))return;const controller=new AbortController();const done=this.run(id,controller).catch(()=>{}).finally(()=>this.active.delete(id));this.active.set(id,{controller,done});}
 async stop(conversation:number){
  const row=(await this.db.query(`UPDATE finding_retests SET stop_requested=true,
   status=CASE WHEN status='pending' OR lease_until IS NULL OR lease_until<=now() THEN 'stopped' ELSE status END,
   finished_at=CASE WHEN status='pending' OR lease_until IS NULL OR lease_until<=now() THEN now() ELSE finished_at END
   WHERE conversation_id=$1 AND status IN ('pending','running') RETURNING id`,[conversation])).rows[0];
  if(row){const running=this.active.get(Number(row.id));running?.controller.abort('user');await running?.done;}
  const pending=!!(await this.db.query("SELECT id FROM finding_retests WHERE conversation_id=$1 AND status='running' AND lease_until>now()",[conversation])).rowCount;
  return {status:pending?'stopping':'stopped'};
 }
 async shutdown(){for(const run of this.active.values())run.controller.abort();await Promise.all([...this.active.values()].map(r=>r.done));}
 async finish(id:number,token:string,status:'completed'|'stopped'|'failed') {
  return this.db.transaction(async tx=>{
   // Same lock order as create: finding before retest.
   await tx.query('SELECT id FROM findings WHERE id=(SELECT finding_id FROM finding_retests WHERE id=$1) FOR UPDATE',[id]);
   const r=await tx.query(`UPDATE finding_retests SET status=CASE WHEN $3='completed' AND verdict='' THEN 'failed' ELSE $3 END,
    error=CASE WHEN $3='completed' AND verdict='' THEN 'Agent 未保存复测结论' ELSE error END,finished_at=now(),lease_until=NULL
    WHERE id=$1 AND lease_token=$2 AND status='running' AND NOT stop_requested AND lease_until>clock_timestamp()
    RETURNING finding_id,status,verdict,snapshot`,[id,token,status]);
   const result=r.rows[0];
   if(result?.status==='completed'&&result.verdict==='fixed'){
    const snapshot=result.snapshot as Record<string,unknown>;
    await tx.query("UPDATE findings SET status='fixed' WHERE id=$1 AND triage_version=$2",[result.finding_id,Number(snapshot.triage_version??0)]);
   }
   return result;
  });
 }
 private async run(id:number,controller:AbortController){
  const token=this.owner+':'+randomUUID();
  const claimed=await this.db.transaction(async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(4200000002)');
   const limit=Math.max(1,Number(await tx.platform().getSetting('workers'))||this.workers);
   const count=await tx.query(`SELECT (SELECT count(*) FROM engine_worker_slots s JOIN engine_task_leases l ON l.task_id=s.task_id AND l.token=s.token WHERE l.expires_at>now() AND NOT s.manual)+(SELECT count(*) FROM finding_retests WHERE status='running' AND lease_until>now()) n`);
   if(Number(count.rows[0]?.n)>=limit)return undefined;
   const r=await tx.query(`UPDATE finding_retests SET status='running',started_at=COALESCE(started_at,now()),lease_token=$2,lease_until=now()+interval '15 seconds' WHERE id=$1 AND NOT stop_requested AND (status='pending' OR (status='running' AND (lease_until IS NULL OR lease_until<now()))) RETURNING *`,[id,token]);return r.rows[0];
  });
  if(!claimed)return;
  const snapshot=claimed.snapshot as Record<string,unknown>,taskID=Number(snapshot.task_id),conversation=Number(claimed.conversation_id);
  const turnID=`retest:${id}:${token}`;
  const writer=new LiveStreamWriter(this.db,'conversation',conversation,{worker:'worker',turn_id:turnID});
  let tail=Promise.resolve();
  const persist=(a:RunnerActivity)=>{
   writer.push(a);
   if(a.kind==='assistant_delta'||a.kind==='usage'||a.kind==='queue_update')return;
   const kind=a.kind==='run_metadata'||a.kind==='settled'?'status':a.kind==='tool_start'?'tool_use':a.kind==='tool_end'?'tool_result':a.kind==='assistant_message_end'&&a.isThinking?'thinking':'assistant';
   const detail=a.kind==='tool_start'?JSON.stringify(a.args):'text' in a?a.text:'';
   tail=tail.then(async()=>{const saved=await this.db.query('INSERT INTO conversation_activities(conversation_id,worker,kind,tool,tool_use_id,summary,detail,is_error,metadata) SELECT $1,\'worker\',$2,$3,$4,$5,$6,$7,$8::jsonb WHERE EXISTS(SELECT 1 FROM finding_retests WHERE id=$9 AND lease_token=$10 AND lease_until>clock_timestamp())',[conversation,kind,'toolName' in a?a.toolName:null,'toolCallId' in a?a.toolCallId:null,detail?.slice(0,20000),detail,'isError' in a?a.isError:false,JSON.stringify({turn_id:turnID,...runnerActivityMetadata(a)}),id,token]);if(saved.rowCount&&a.kind==='assistant_message_end'&&a.streamID)await writer.committed(a.streamID,a.isThinking?'thinking':'text');});
  };
  const assert=async(db:Database=this.db)=>{controller.signal.throwIfAborted();if(!(await db.query("SELECT id FROM finding_retests WHERE id=$1 AND lease_token=$2 AND status='running' AND NOT stop_requested AND lease_until>clock_timestamp() FOR SHARE",[id,token])).rowCount)throw new Error('复测执行已停止或租约失效');};
  const stopWatchdog=leaseWatchdog(async()=>{await assert();const r=await this.db.query("UPDATE finding_retests SET lease_until=now()+interval '15 seconds' WHERE id=$1 AND lease_token=$2 AND status='running' AND NOT stop_requested AND lease_until>now() RETURNING id",[id,token]);if(!r.rowCount)throw new Error('lease lost');},()=>controller.abort());
  let runner:AgentRunner|undefined;
  try{
   const task=await this.db.tasks().getTask(taskID);if(!task)throw new Error('来源任务不存在');
   const cfg=await agentRunConfig(this.db,'retester'),source=await this.resolve(taskID,'retester');
   if(!(await this.db.query('SELECT 1 WHERE finding_readable($1)',[Number(snapshot.id)])).rowCount)throw new Error('漏洞授权已撤销');
   const cwd=path.join(this.dataDir,'retests',String(id));await mkdir(cwd,{recursive:true});
   const ctx=runContext(this.db,taskID,task.exploration_id,'retester',{conversationID:conversation,networkTargets:Array.isArray(snapshot.scope_targets)?snapshot.scope_targets as RetestTarget[]:[],workerName:`retest#${id}`,hooks:{assertOwnership:assert}});
   const submit=domainTool<{verdict:string;summary:string;evidence:string}>({name:'record_finding_retest_result',description:'提交本次复测结论；成功完成且明确判定 fixed 时更新原漏洞状态。只有实际复现证据才能判 reproduced，证据不足必须 inconclusive。',parameters:{type:'object',properties:{verdict:{type:'string',enum:['reproduced','fixed','inconclusive']},summary:{type:'string'},evidence:{type:'string'}},required:['verdict','summary','evidence']},async run(args,c){
    if(!['reproduced','fixed','inconclusive'].includes(args.verdict)||!args.summary.trim()||(args.verdict!=='inconclusive'&&!args.evidence.trim()))throw new Error('必须提交有效结论和证据');
    await c.db.query("UPDATE finding_retests SET verdict=$3,summary=$4,evidence=$5 WHERE id=$1 AND lease_token=$2",[id,token,args.verdict,args.summary,args.evidence]);return {saved:true};
   }},ctx);
   const gate=interceptGate(this.db,{taskID,agentName:'retester',worker:`retest#${id}`});
   const contextTool=domainTool<{offset?:number}>({name:'get_finding_retest_context',description:'读取本次复测固定快照，按 JSON 字符偏移分页；只能查看当前漏洞。',readOnly:true,parameters:{type:'object',properties:{offset:{type:'integer',minimum:0}}},async run(args){
    const body=JSON.stringify({finding_id:Number(snapshot.id),name:snapshot.name,vulnclass:snapshot.vulnclass,severity:snapshot.severity,status:snapshot.status,summary:snapshot.summary,evidence:snapshot.evidence,report:snapshot.report,asset_ids:snapshot.asset_ids,traffic_evidence:snapshot.traffic_evidence,scope_targets:snapshot.scope_targets,notes:claimed.notes});
    const offset=Math.max(0,args.offset??0),end=Math.min(body.length,offset+6000);return {content:body.slice(offset,end),offset,total:body.length,next_offset:end<body.length?end:null};
   }},ctx);
   const tools=await applyToolBindings(this.db,'retester',[contextSearchTool(ctx),contextGetTool(ctx),toolOutputTool(ctx),httpRequestTool(ctx),trafficBodyTool(ctx),readAttachmentTool(ctx),listAssetsTool(ctx),contextTool,submit]);
   if(!tools.some(t=>t.name==='record_finding_retest_result')||!tools.some(t=>t.name==='get_finding_retest_context'))throw new Error('Retester 的必要读取或提交工具已禁用');
   const resources=await roleResources(this.db,'retester',skillDir());
   runner=await createTrackedRunner(this.db,taskID,'retester',{stopWhen:async()=>!!(await this.db.query('SELECT verdict FROM finding_retests WHERE id=$1 AND lease_token=$2',[id,token])).rows[0]?.verdict,...source,skillsDir:resources.skillsDir,allowedSkills:resources.allowedSkills,cwd,agentDir:path.join(this.dataDir,'pi-agent'),sessionDir:cwd,signal:controller.signal,...agentBudgets(cfg,{maxTurns:20,maxDurationMs:600_000}),
    loadDomainState:async()=>{await assert();const row=(await this.db.query('SELECT verdict FROM finding_retests WHERE id=$1 AND lease_token=$2',[id,token])).rows[0];return {retest_id:id,finding_id:Number(snapshot.id),saved_verdict:row?.verdict??null,scope:'原漏洞固定快照；get_finding_retest_context 读取',read_tool:'get_finding_retest_context',save_tool:'record_finding_retest_result'};},
    systemPrompt:(await systemRolePrompt(this.db,'retester'))+constraintBlock(await loadConstraints(this.db,task.exploration_id)),
    wrapup:async()=>{
     const saved=(await this.db.query('SELECT verdict FROM finding_retests WHERE id=$1 AND lease_token=$2',[id,token])).rows[0];
     return saved?.verdict ? undefined : {prompt:cfg.wrapupPrompt||hostProtocol('retester')};
    },maxWrapupTurns:cfg.wrapupMaxTurns||2,
    customTools:tools,toolAllowlist:[...tools.map(t=>t.name),'read'],guard:async g=>{
     await assert();await agentRunConfig(this.db,'retester');
     if(!(await applyToolBindings(this.db,'retester',[{name:g.toolName}])).length)return {block:true,reason:'工具已禁用或解除绑定'};
     if(!(await this.db.query('SELECT 1 WHERE finding_readable($1)',[Number(snapshot.id)])).rowCount)return {block:true,reason:'原漏洞授权已撤销'};
     if(g.toolName==='http_request'){
      if(!['GET','HEAD','OPTIONS'].includes(String(g.args.method??'GET').toUpperCase()))return {block:true,reason:'复测仅允许 GET、HEAD、OPTIONS 等无副作用请求'};
      const url=new URL(String(g.args.url)),port=Number(url.port)||(url.protocol==='https:'?443:80);
      const targets=Array.isArray(snapshot.scope_targets)?snapshot.scope_targets as RetestTarget[]:[];
      if(!targets.some(t=>t.host===url.hostname.toLowerCase()&&(t.port===null||t.port===port)))return {block:true,reason:'复测仅允许原漏洞快照中的主机和端口；无明确范围时应提交 inconclusive'};
      await this.db.taskScope().validateTaskHostPort(taskID,url.hostname,port);
     }
     return gate(g);
    },onActivity:persist,
   },conversation);
   await this.db.query("INSERT INTO conversation_activities(conversation_id,worker,kind,summary,detail,metadata) VALUES($1,'user','user',$2,$2,$3::jsonb)",[conversation,String(claimed.notes||'开始复测'),JSON.stringify({turn_id:turnID})]);
   const result=await runner.prompt(`复测记录 #${id}；使用 get_finding_retest_context 分页读取漏洞、原始证据和用户要求。用户复测要求：${claimed.notes}`);
   await tail;await assert();
   await this.finish(id,token,result.aborted?'stopped':'completed');
  }catch(error){await this.db.query("UPDATE finding_retests SET status=$3,error=$4,finished_at=now(),lease_until=NULL WHERE id=$1 AND lease_token=$2 AND status='running'",[id,token,controller.signal.aborted?'stopped':'failed',String(error).slice(0,2000)]);}
  finally{stopWatchdog();await runner?.dispose();await tail.catch(()=>{});
   await this.db.query(`INSERT INTO conversation_activities(conversation_id,worker,kind,summary,metadata)
    SELECT $1,'worker','result',COALESCE(NULLIF(summary,''),NULLIF(error,''),'复测结束'),jsonb_build_object('turn_id',$2::text,'event_type',CASE WHEN verdict<>'' THEN 'outcome' ELSE 'lifecycle' END,'status',status)
    FROM finding_retests WHERE id=$3 AND lease_token=$4 AND status IN ('completed','stopped','failed')`,[conversation,turnID,id,token]);
   await writer.close().catch(()=>{});
  }
 }
}
