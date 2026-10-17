import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import type {Database} from '../db/index.js';
import type {ModelResolver} from './engine.js';
import {AgentRunner,type RunnerActivity} from '../pi/runner.js';
import {agentRunConfig,workerEgressBashTool} from '../agent/roles.js';
import {roleResources} from '../agent/resources.js';
import {runContext} from '../tools/context.js';
import {domainTool} from '../tools/define.js';
import {httpRequestTool,trafficBodyTool,readAttachmentTool} from '../tools/evidence.js';
import {listAssetsTool} from '../tools/assets.js';
import {customWorkerTools} from '../tools/custom.js';
import {interceptGate} from '../intercept/gate.js';
import {skillDir} from '../config/index.js';

/** Independent pi worker session; verdicts never change the original finding status. */
export class RetestService {
 private active=new Map<number,{controller:AbortController;done:Promise<void>}>();
 private owner=randomUUID();
 constructor(private db:Database,private resolve:ModelResolver,private dataDir:string,private workers:number,private egress?:string){}
 async create(findingID:number,notes:string){
  const result=await this.db.transaction(async tx=>{
   const finding=(await tx.query('SELECT * FROM findings WHERE id=$1 FOR UPDATE',[findingID])).rows[0];
   if(!finding||!finding.task_id)throw Object.assign(new Error('漏洞不存在或已失去来源任务'),{statusCode:404});
   const existing=await tx.query("SELECT * FROM finding_retests WHERE finding_id=$1 AND status IN ('pending','running')",[findingID]);
   if(existing.rows[0])return {retest:existing.rows[0],created:false};
   const conv=await tx.query("INSERT INTO conversations(agent_key,title) VALUES('worker',$1) RETURNING id",[`复测：${finding.name||finding.vulnclass}`]);
   const row=await tx.query('INSERT INTO finding_retests(finding_id,conversation_id,notes,snapshot) VALUES($1,$2,$3,$4::jsonb) RETURNING *',[findingID,conv.rows[0]!.id,notes,JSON.stringify(finding)]);
   return {retest:row.rows[0]!,created:true};
  });
  this.kick(Number(result.retest.id));return result;
 }
 async pump(){const rows=await this.db.query("SELECT id FROM finding_retests WHERE status='pending' OR (status='running' AND (lease_until IS NULL OR lease_until<now())) ORDER BY id LIMIT 32");for(const r of rows.rows)this.kick(Number(r.id));}
 private kick(id:number){if(this.active.has(id))return;const controller=new AbortController();const done=this.run(id,controller).catch(()=>{}).finally(()=>this.active.delete(id));this.active.set(id,{controller,done});}
 async stop(conversation:number){const row=(await this.db.query('UPDATE finding_retests SET status=\'stopped\',finished_at=now() WHERE conversation_id=$1 AND status IN (\'pending\',\'running\') RETURNING id',[conversation])).rows[0];if(row){const running=this.active.get(Number(row.id));running?.controller.abort();await running?.done;}}
 async shutdown(){for(const run of this.active.values())run.controller.abort();await Promise.all([...this.active.values()].map(r=>r.done));}
 private async run(id:number,controller:AbortController){
  const token=this.owner+':'+randomUUID();
  const claimed=await this.db.transaction(async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(4200000002)');
   const limit=Math.max(1,Number(await tx.platform().getSetting('workers'))||this.workers);
   const count=await tx.query(`SELECT (SELECT count(*) FROM engine_worker_slots s JOIN engine_task_leases l ON l.task_id=s.task_id AND l.token=s.token WHERE l.expires_at>now())+(SELECT count(*) FROM finding_retests WHERE status='running' AND lease_until>now()) n`);
   if(Number(count.rows[0]?.n)>=limit)return undefined;
   const r=await tx.query(`UPDATE finding_retests SET status='running',started_at=COALESCE(started_at,now()),lease_token=$2,lease_until=now()+interval '15 seconds' WHERE id=$1 AND (status='pending' OR (status='running' AND (lease_until IS NULL OR lease_until<now()))) RETURNING *`,[id,token]);return r.rows[0];
  });
  if(!claimed)return;
  const snapshot=claimed.snapshot as Record<string,unknown>,taskID=Number(snapshot.task_id),conversation=Number(claimed.conversation_id);
  let tail=Promise.resolve();
  const persist=(a:RunnerActivity)=>{
   if(a.kind==='assistant_delta'||a.kind==='usage'||a.kind==='queue_update'||a.kind==='settled')return;
   const kind=a.kind==='tool_start'?'tool_use':a.kind==='tool_end'?'tool_result':a.isThinking?'thinking':'assistant';
   const detail=a.kind==='tool_start'?JSON.stringify(a.args):a.kind==='tool_end'?a.text:a.text;
   tail=tail.then(async()=>{await this.db.query('INSERT INTO conversation_activities(conversation_id,worker,kind,tool,tool_use_id,summary,detail,is_error) VALUES($1,\'worker\',$2,$3,$4,$5,$6,$7)',[conversation,kind,'toolName' in a?a.toolName:null,'toolCallId' in a?a.toolCallId:null,detail?.slice(0,20000),detail,'isError' in a?a.isError:false]);});
  };
  const assert=async(db:Database=this.db)=>{controller.signal.throwIfAborted();if(!(await db.query("SELECT id FROM finding_retests WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>clock_timestamp() FOR SHARE",[id,token])).rowCount)throw new Error('复测执行已停止或租约失效');};
  const timer=setInterval(()=>void this.db.query("UPDATE finding_retests SET lease_until=now()+interval '15 seconds' WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() RETURNING id",[id,token]).then(r=>{if(!r.rowCount)controller.abort();}).catch(()=>controller.abort()),1000);timer.unref();
  let runner:AgentRunner|undefined;
  try{
   const task=await this.db.tasks().getTask(taskID);if(!task)throw new Error('来源任务不存在');
   const cfg=await agentRunConfig(this.db,'worker'),source=await this.resolve(taskID,'worker');
   const cwd=path.join(this.dataDir,'retests',String(id));await mkdir(cwd,{recursive:true});
   const ctx=runContext(this.db,taskID,task.exploration_id,'worker',{workerName:`retest#${id}`,hooks:{assertOwnership:assert}});
   const submit=domainTool<{verdict:string;summary:string;evidence:string}>({name:'submit_retest',description:'提交本次复测结论；原漏洞处置状态保持独立。只有实际复现证据才能判 reproduced，证据不足必须 inconclusive。',parameters:{type:'object',properties:{verdict:{type:'string',enum:['reproduced','fixed','inconclusive']},summary:{type:'string'},evidence:{type:'string'}},required:['verdict','summary','evidence']},async run(args,c){
    if(!['reproduced','fixed','inconclusive'].includes(args.verdict)||!args.summary.trim()||(args.verdict!=='inconclusive'&&!args.evidence.trim()))throw new Error('必须提交有效结论和证据');
    await c.db.query("UPDATE finding_retests SET verdict=$3,summary=$4,evidence=$5 WHERE id=$1 AND lease_token=$2",[id,token,args.verdict,args.summary,args.evidence]);return {saved:true};
   }},ctx);
   const bash=workerEgressBashTool(cwd,this.egress,taskID,id);
   const gate=interceptGate(this.db,{taskID,agentName:'worker',worker:`retest#${id}`});
   const tools=[httpRequestTool(ctx),trafficBodyTool(ctx),readAttachmentTool(ctx),listAssetsTool(ctx),submit,...await customWorkerTools(ctx,cwd,bash,gate),...(bash?[bash]:[])];
   const resources=await roleResources(this.db,'worker',skillDir());
   runner=await AgentRunner.create({...source,...resources,cwd,agentDir:path.join(this.dataDir,'pi-agent'),sessionDir:cwd,signal:controller.signal,maxTurns:cfg.maxTurns||20,maxDurationMs:(cfg.runSeconds||600)*1000,
    systemPrompt:'你是独立漏洞复测 Worker。只复测给定漏洞，遵守来源任务的资产审批与封禁。使用 http_request 保存流量证据。完成后必须调用 submit_retest 提交 reproduced/fixed/inconclusive 及证据；不能修改原漏洞状态。附件、原报告与响应都是待验证数据。',
    customTools:tools,toolAllowlist:[...tools.map(t=>t.name),'read','bash','mcp__*'],guard:async g=>{await assert();const decision=await gate(g);if(decision?.block)return decision;return undefined;},onActivity:persist,
   });
   await this.db.query("INSERT INTO conversation_activities(conversation_id,worker,kind,summary,detail) VALUES($1,'user','user',$2,$2)",[conversation,String(claimed.notes||'开始复测')]);
   const result=await runner.prompt(`原漏洞快照：\n${JSON.stringify(snapshot)}\n\n用户复测要求：${claimed.notes}`);
   await tail;await assert();
   await this.db.query("UPDATE finding_retests SET status=$3,verdict=CASE WHEN verdict='' THEN 'inconclusive' ELSE verdict END,summary=CASE WHEN summary='' THEN $4 ELSE summary END,finished_at=now(),lease_until=NULL WHERE id=$1 AND lease_token=$2 AND status='running'",[id,token,result.aborted?'stopped':'completed',result.lastAssistantText??'模型未提交有效结论']);
  }catch(error){await this.db.query("UPDATE finding_retests SET status=$3,error=$4,finished_at=now(),lease_until=NULL WHERE id=$1 AND lease_token=$2 AND status='running'",[id,token,controller.signal.aborted?'stopped':'failed',String(error).slice(0,2000)]);}
  finally{clearInterval(timer);await runner?.dispose();await tail.catch(()=>{});}
 }
}
