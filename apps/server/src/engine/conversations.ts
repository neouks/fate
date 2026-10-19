import {randomUUID} from 'node:crypto';
import {LiveStreamWriter,runnerActivityMetadata} from './live-stream.js';
import {createTrackedRunner} from './runtime-config.js';
import {EventEmitter} from 'node:events';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import type {Database} from '../db/index.js';
import type {Engine,ModelResolver} from './engine.js';
import {acquireSessionLease} from './session-lease.js';
import {AgentRunner,type RunnerActivity} from '../pi/runner.js';
import {agentRunConfig,agentBudgets,applyToolBindings,disabledBuiltinTools,workerEgressBashTool} from '../agent/roles.js';
import {systemRolePrompt,constraintBlock,hostProtocol} from '../agent/prompts.js';
import {roleResources} from '../agent/resources.js';
import {skillDir} from '../config/index.js';
import {runContext,type AgentRole} from '../tools/context.js';
import {domainTool} from '../tools/define.js';
import {listAssetsTool} from '../tools/assets.js';
import {reportFindingTool,listFindingsTool} from '../tools/findings.js';
import {recordFactTool,nodeDetailTool} from '../tools/graph.js';
import {graphOverviewTool} from '../tools/overview.js';
import {httpRequestTool,trafficBodyTool,readAttachmentTool} from '../tools/evidence.js';
import {customWorkerTools} from '../tools/custom.js';
import {loadConstraints} from '../tools/index.js';
import {interceptGate} from '../intercept/gate.js';
import {findingEvidence} from '../evidence/store.js';
import {prepareAttachments} from '../evidence/attachments.js';
import {toolOutputTool} from '../tools/output.js';
import {contextSearchTool,contextGetTool} from '../tools/context-read.js';

const ORCHESTRATORS=new Set(['goals','planner','mainagent','worker','retester']);
export class ConversationService {
 readonly bus=new EventEmitter();
 private active=new Map<number,{controller:AbortController;done:Promise<void>}>();
 private closing=false;
 constructor(private db:Database,private resolve:ModelResolver,private dataDir:string,private engine:Engine,private egress?:string){}
 async list(){
  const rows=await this.db.query(`SELECT c.*,a.name AS agent_name,(EXISTS(
   SELECT 1 FROM conversation_runs r WHERE r.conversation_id=c.id AND r.status IN ('queued','running')
  ) OR EXISTS(SELECT 1 FROM finding_retests f WHERE f.conversation_id=c.id AND f.status IN ('pending','running'))
  ) AS running FROM conversations c LEFT JOIN agents a ON a.key=c.agent_key ORDER BY c.pinned_at DESC NULLS LAST,c.updated_at DESC,c.id DESC LIMIT 500`);
  return rows.rows;
 }
 async create(key:string,title='',profile?:number|null,taskID?:number){
  const agent=await this.db.platform().getAgentByKey(key);
  if(!agent||!agent.enabled||ORCHESTRATORS.has(key))throw Object.assign(new Error('该角色不能创建独立对话'),{statusCode:400});
  const cleanTitle=title.trim()||'新对话';
  if(Array.from(cleanTitle).length>120)throw Object.assign(new Error('标题最多 120 个字符'),{statusCode:400});
  if(profile!==undefined&&profile!==null){const row=await this.db.query('SELECT id FROM llm_profiles WHERE id=$1',[profile]);if(!row.rowCount)throw Object.assign(new Error('指定的 LLM 配置不存在'),{statusCode:400});}
  if(taskID&&!await this.db.tasks().getTask(taskID))throw Object.assign(new Error('task not found'),{statusCode:404});
  return (await this.db.query('INSERT INTO conversations(agent_key,title,llm_profile_id,task_id) VALUES($1,$2,$3,$4) RETURNING *',[key,cleanTitle,profile??null,taskID??null])).rows[0]!;
 }
 async update(id:number,patch:{title?:string;pinned?:boolean}){
  const title=patch.title?.trim();
  if(patch.title!==undefined&&(!title||Array.from(title).length>120))throw Object.assign(new Error('标题不能为空且最多 120 个字符'),{statusCode:400});
  const row=(await this.db.query(`UPDATE conversations SET title=COALESCE($2,title),pinned_at=CASE WHEN $3::boolean IS NULL THEN pinned_at WHEN $3 THEN COALESCE(pinned_at,now()) ELSE NULL END
   WHERE id=$1 RETURNING *`,[id,title??null,patch.pinned??null])).rows[0];
  if(!row)throw Object.assign(new Error('conversation not found'),{statusCode:404});return row;
 }
 async setProfile(id:number,profile:number|null){
  if(profile!==null&&!(await this.db.query('SELECT id FROM llm_profiles WHERE id=$1',[profile])).rowCount)throw Object.assign(new Error('指定的 LLM 配置不存在'),{statusCode:400});
  const r=await this.db.query('UPDATE conversations SET llm_profile_id=$2 WHERE id=$1 RETURNING id',[id,profile]);
  if(!r.rowCount)throw Object.assign(new Error('conversation not found'),{statusCode:404});return {ok:true};
 }
 async remove(id:number){
  const retest=await this.db.query("SELECT id FROM finding_retests WHERE conversation_id=$1 AND status IN ('pending','running')",[id]);
  if(retest.rowCount&&(await this.engine.retests.stop(id)).status==='stopping')return {status:'stopping'};
  if((await this.stop(id)).status==='stopping')return {status:'stopping'};
  const r=await this.db.query('DELETE FROM conversations WHERE id=$1 RETURNING id',[id]);
  if(!r.rowCount)throw Object.assign(new Error('conversation not found'),{statusCode:404});return {deleted:Number(r.rows[0]!.id)};
 }
 async enqueue(id:number,message:string,attachments:unknown=[],requestID:string=randomUUID()){
  if((!message.trim()&&(!Array.isArray(attachments)||attachments.length===0))||message.length>100000)throw Object.assign(new Error('消息为空或过长'),{statusCode:400});
  const row=await this.db.transaction(async tx=>{
   const conv=(await tx.query('SELECT * FROM conversations WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!conv)throw Object.assign(new Error('conversation not found'),{statusCode:404});
   const existing=await tx.query('SELECT id FROM conversation_runs WHERE conversation_id=$1 AND turn_id=$2',[id,requestID]);
   if(existing.rows[0])return existing.rows[0];
   if(ORCHESTRATORS.has(String(conv.agent_key)))throw Object.assign(new Error('请通过该角色的专用入口执行'),{statusCode:409});
   if((await tx.query("SELECT id FROM conversation_runs WHERE conversation_id=$1 AND status IN ('queued','running')",[id])).rowCount)throw Object.assign(new Error('当前会话仍有待处理消息'),{statusCode:409});
   const first=(await tx.query('SELECT id FROM conversation_activities WHERE conversation_id=$1 AND worker=\'user\' LIMIT 1',[id])).rowCount===0;
   await tx.query("INSERT INTO conversation_activities(conversation_id,worker,kind,summary,detail,metadata) VALUES($1,'user','user',$2,$3,$4::jsonb)",[id,message.slice(0,1000),message,JSON.stringify({turn_id:requestID,attachments})]);
   await tx.query("UPDATE conversations SET title=CASE WHEN title='' OR title='新对话' THEN $2 ELSE title END WHERE id=$1",[id,(message.trim().split(/\r?\n/,1)[0]||'附件消息').slice(0,40)]);
   if(!first)await tx.query('UPDATE conversations SET updated_at=now() WHERE id=$1',[id]);
   return (await tx.query('INSERT INTO conversation_runs(conversation_id,message,attachments,turn_id) VALUES($1,$2,$3::jsonb,$4) RETURNING id',[id,message,JSON.stringify(attachments),requestID])).rows[0]!;
  });
  void this.pump().catch(()=>{});return {status:'queued',run_id:Number(row.id)};
 }
 async stop(id:number){
  await this.db.query("UPDATE conversation_runs SET status='stopped',finished_at=now() WHERE conversation_id=$1 AND status='queued'",[id]);
  await this.db.query('UPDATE runtime_session_leases SET stop_requested=true WHERE key=$1',[`conversation:${id}`]);
  this.active.get(id)?.controller.abort('user');await this.active.get(id)?.done;
  const pending=!!(await this.db.query('SELECT key FROM runtime_session_leases WHERE key=$1 AND expires_at>now()',[`conversation:${id}`])).rowCount;
  return {status:pending?'stopping':'stopped'};
 }
 async shutdown(){this.closing=true;for(const a of this.active.values())a.controller.abort('shutdown');await Promise.allSettled([...this.active.values()].map(a=>a.done));}
 async pump(){
  if(this.closing)return;
  // Interrupted runs are visible; the next user turn resumes native history without replaying tool effects.
  await this.db.query(`UPDATE conversation_runs r SET status='failed',error='执行器已离线；会话历史已保留，可发送新消息继续',finished_at=now()
   WHERE status='running' AND NOT EXISTS(SELECT 1 FROM runtime_session_leases l WHERE l.key='conversation:'||r.conversation_id AND l.token=r.token AND l.expires_at>now())`);
  const rows=await this.db.query("SELECT DISTINCT conversation_id FROM conversation_runs WHERE status='queued' ORDER BY conversation_id LIMIT 32");
  for(const r of rows.rows){const id=Number(r.conversation_id);if(this.active.has(id))continue;
   const controller=new AbortController();const done=this.run(id,controller).catch(()=>{}).finally(()=>this.active.delete(id));this.active.set(id,{controller,done});}
 }
 private async run(id:number,controller:AbortController){
  const lease=await acquireSessionLease(this.db,`conversation:${id}`,controller);
  let runner:AgentRunner|undefined,runID=0,tail=Promise.resolve();
  let writer:LiveStreamWriter|undefined;let turnID="";
  const persist=(a:RunnerActivity)=>{
   this.bus.emit(`conversation:${id}`,a);
   writer?.push(a);
   if(['assistant_delta','queue_update'].includes(a.kind))return;
   const kind=a.kind==='run_metadata'||a.kind==='settled'?'status':a.kind==='tool_start'?'tool_use':a.kind==='tool_end'?'tool_result':a.kind==='usage'?'usage':a.kind==='assistant_message_end'&&a.isThinking?'thinking':'assistant';
   const detail=a.kind==='tool_start'?JSON.stringify(a.args):'text' in a?a.text??'':'';
   tail=tail.then(async()=>{const saved=await this.db.query(`INSERT INTO conversation_activities(conversation_id,worker,kind,tool,tool_use_id,summary,detail,is_error,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,metadata)
    SELECT $1,'assistant',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$14::jsonb WHERE EXISTS(SELECT 1 FROM runtime_session_leases WHERE key=$12 AND token=$13 AND expires_at>clock_timestamp())`,[id,kind,'toolName' in a?a.toolName:null,'toolCallId' in a?a.toolCallId:null,detail.slice(0,1000),detail,'isError' in a?a.isError:false,a.kind==='usage'?a.input:0,a.kind==='usage'?a.output:0,a.kind==='usage'?a.cacheRead:0,a.kind==='usage'?a.cacheWrite:0,`conversation:${id}`,lease.token,JSON.stringify({turn_id:turnID,...runnerActivityMetadata(a)})]);
    if(saved.rowCount&&a.kind==='assistant_message_end'&&a.streamID)await writer?.committed(a.streamID,a.isThinking?'thinking':'text');});
  };
  try{
   const claimed: (Record<string, unknown> & {run:Record<string, unknown>}) | undefined = await this.db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(4200000003)');
    const c=(await tx.query('SELECT c.*,a.enabled,a.trigger_run_mode,a.trigger_max_parallel FROM conversations c JOIN agents a ON a.key=c.agent_key WHERE c.id=$1',[id])).rows[0];
    if(!c||!c.enabled)return;
    const count=await tx.query("SELECT count(*) n FROM conversation_runs r JOIN conversations c ON c.id=r.conversation_id WHERE c.agent_key=$1 AND r.trigger_id IS NOT NULL AND r.status='running'",[c.agent_key]);
    const configured=Number(c.trigger_max_parallel);
    const limit=c.trigger_run_mode==='parallel'?(Number.isFinite(configured)?Math.max(0,configured):5):1;
    if(limit>0&&Number(count.rows[0]!.n)>=limit)return;
    const r=await tx.query(`UPDATE conversation_runs SET status='running',token=$2,started_at=now() WHERE id=(SELECT id FROM conversation_runs WHERE conversation_id=$1 AND status='queued' AND (trigger_id IS NULL OR EXISTS(SELECT 1 FROM agent_triggers t WHERE t.id=conversation_runs.trigger_id AND t.enabled)) ORDER BY id LIMIT 1 FOR UPDATE) RETURNING *`,[id,lease.token]);
    return r.rows[0]?{...c,run:r.rows[0]}:undefined;
   });
   if(!claimed)return;runID=Number(claimed.run.id);
   turnID=String(claimed.run.turn_id||`conversation:${runID}`);
   writer=new LiveStreamWriter(this.db,'conversation',id,{worker:'assistant',turn_id:turnID});
   const role=String(claimed.agent_key),taskID=Number(claimed.task_id)||0,task=taskID?await this.db.tasks().getTask(taskID):null;
   const config=await agentRunConfig(this.db,role);
   const model=await this.resolve(taskID,role,{conversationID:id,profileID:Number(claimed.llm_profile_id)||undefined});
   const cwd=path.join(this.dataDir,'conversations',String(id));await mkdir(cwd,{recursive:true});
   const ctx=runContext(this.db,taskID,task?.exploration_id??0,role as AgentRole,{conversationID:id,hooks:{assertOwnership:lease.assert}});
   const gate=interceptGate(this.db,{taskID,agentName:role,worker:`conversation#${id}`});
   const tools=[readAttachmentTool(ctx),toolOutputTool(ctx)];
   if(task)tools.push(contextSearchTool(ctx),contextGetTool(ctx),listAssetsTool(ctx),listFindingsTool(ctx),nodeDetailTool(ctx),graphOverviewTool(ctx),trafficBodyTool(ctx));
   if(role==='auto'){
    const make=(name:string,description:string,properties:Record<string,unknown>,run:(a:Record<string,unknown>)=>Promise<Record<string,unknown>>,required:string[]=[])=>domainTool({name,description,transactional:false,parameters:{type:'object',properties,required},run},ctx);
    tools.push(make('list_tasks','分页列出平台任务',{after_id:{type:'integer'}},async a=>({tasks:(await this.db.query('SELECT id,name,goal,status,paused,queued FROM tasks WHERE deleted_at IS NULL AND id>$1 ORDER BY id LIMIT 10',[Number(a.after_id)||0])).rows})),
     make('get_task','查询任务状态',{task_id:{type:'integer'}},async a=>({task:await this.db.tasks().getTask(Number(a.task_id))}),['task_id']),
     make('list_llm_profiles','列出可选模型，不返回密钥',{},async()=>({profiles:(await this.db.platform().listProfiles()).map(p=>({id:p.id,name:p.name,model:p.model}))})),
     make('spawn_task','按用户目标创建并启动任务',{description:{type:'string'},goal:{type:'string'},asset_ids:{type:'array',items:{type:'integer'}},company_ids:{type:'array',items:{type:'integer'}},execution_mode:{type:'string',enum:['managed','manual']},asset_approval_template:{type:'string',enum:['all_assets','related_assets','explicit_targets']},source_task_ids:{type:'array',items:{type:'integer'}},llm_profile_id:{type:'integer'},seed_first_intent:{type:'boolean'}},async a=>{
      const profile=Number(a.llm_profile_id)||Number(claimed.llm_profile_id)||0;
      const t=await this.db.tasks().createTaskWithOptions(String(a.description),String(a.goal??a.description),{companyIDs:a.company_ids as number[]|undefined,executionMode:a.execution_mode==='manual'?'manual':'managed',assetApprovalTemplate:a.asset_approval_template as string|undefined,assetIDs:a.asset_ids as number[]|undefined,sourceTaskIDs:a.source_task_ids as number[]|undefined,llmProfileIDs:profile?[profile]:[],seedFirstIntent:a.seed_first_intent===true});
      await this.db.query('UPDATE tasks SET parent_ref=$2 WHERE id=$1',[t.id,`conversation:${id}`]);await this.engine.admitTask(t.id,{decompose:{description:t.description}});return {task:t};
     },['description']),
     make('pause_task','暂停指定任务',{task_id:{type:'integer'}},async a=>{const n=Number(a.task_id);await this.db.tasks().applyTaskPause(n);const result=await this.engine.pause(n);return {task_id:n,status:result.status,command_id:result.command_id};},['task_id']),
     make('resume_task','恢复指定任务并返回实际准入状态',{task_id:{type:'integer'}},async a=>{const n=Number(a.task_id);await this.engine.admitTask(n);return {task:await this.db.tasks().getTask(n)};},['task_id']),
     make('add_task_hint','追加任务提示',{task_id:{type:'integer'},message:{type:'string'}},async a=>{const n=Number(a.task_id),t=await this.db.tasks().getTask(n);if(!t)throw new Error('任务不存在');const node=await this.db.exploration(t.exploration_id).addNode('hint',{text:String(a.message),source:'user_request',conversation_id:id},0,'open','auto',[]);this.engine.notify(n);await this.db.query("WITH saved AS (INSERT INTO blackboard_wakeups(exploration_id,event_key,kind,node_id) VALUES($1,$2,'control_changed',$3) ON CONFLICT DO NOTHING RETURNING id) UPDATE explorations SET published_revision=published_revision+1 WHERE id=$1 AND EXISTS(SELECT 1 FROM saved)",[t.exploration_id,`hint:${node}`,node]);return {saved:true,node_id:node};},['task_id','message']));
   }
   const pendingReports=new Set<number>();
   // Trigger metadata is authoritative; model prose cannot silently skip a queued report.
   if(role==='reporter'&&Array.isArray(claimed.run.event_keys)){
    const expected=await this.db.query(`SELECT f.id FROM agent_trigger_events e JOIN findings f ON f.id=(e.payload->>'finding_id')::bigint
      WHERE e.event_key=ANY($1::text[]) AND e.kind='finding' AND ($2::bigint=0 OR f.task_id=$2) AND finding_readable(f.id)
      AND (COALESCE(f.report,'')='' OR f.report_evidence_version IS DISTINCT FROM f.evidence_version)`,[claimed.run.event_keys,taskID]);
    for(const row of expected.rows)pendingReports.add(Number(row.id));
   }
   let reportSaved=false;
   if(['reporter','auto'].includes(role)){
     tools.push(domainTool<{finding_id:number;offset?:number}>({name:'get_finding',description:'读取漏洞、证据版本及绑定；报告正文使用 offset 续读。',readOnly:true,parameters:{type:'object',properties:{finding_id:{type:'integer'},offset:{type:'integer',minimum:0}},required:['finding_id']},async run(a,c){
     const f=(await c.db.query('SELECT * FROM findings WHERE id=$1 AND ($2::bigint=0 OR task_id=$2) AND finding_readable(id)',[a.finding_id,taskID])).rows[0];if(!f)throw new Error('漏洞不存在或未获当前任务授权');if(role==='reporter'&&(!f.report||f.report_evidence_version==null||Number(f.report_evidence_version)!==Number(f.evidence_version)))pendingReports.add(Number(f.id));
     const body=JSON.stringify(f),off=Math.max(0,a.offset??0);
     return {finding_id:Number(f.id),evidence_version:Number(f.evidence_version),content:body.slice(off,off+1500),next_offset:off+1500<body.length?off+1500:null,evidence:await findingEvidence(c.db,a.finding_id)};
    }},ctx) as never,domainTool<{finding_id:number;evidence_version:number;report:string}>({name:'update_finding_report',description:'仅在证据版本一致时更新漏洞报告；冲突后重新读取证据。',parameters:{type:'object',properties:{finding_id:{type:'integer'},evidence_version:{type:'integer'},report:{type:'string'}},required:['finding_id','evidence_version','report']},async run(a,c){
     const r=await c.db.query('UPDATE findings SET report=$3,report_evidence_version=$4 WHERE id=$1 AND ($2::bigint=0 OR task_id=$2) AND evidence_version=$4 AND finding_readable(id) RETURNING id',[a.finding_id,taskID,a.report,a.evidence_version]);if(!r.rowCount)throw new Error('证据版本已变化或漏洞不可用，请重新读取');pendingReports.delete(a.finding_id);reportSaved=true;return {saved:true};
    }},ctx) as never);
   }
   const bash=role==='pentest'?workerEgressBashTool(cwd,this.egress,taskID,0,`conversation:${id}:${lease.token}`):undefined;
   if(role==='pentest'&&task){const pentestTools:unknown[]=[Object.assign(recordFactTool(ctx),{name:'record_conversation_fact'}),Object.assign(reportFindingTool(ctx),{name:'report_conversation_finding'}),httpRequestTool(ctx),...(bash?[bash]:[]),...await customWorkerTools(ctx,cwd,bash,gate)];tools.push(...pentestTools as never[]);}
   const bound=await applyToolBindings(this.db,role,tools),disabled=await disabledBuiltinTools(this.db,role),resources=await roleResources(this.db,role,skillDir());
   if(role==='reporter'&&(!bound.some(t=>t.name==='get_finding')||!bound.some(t=>t.name==='update_finding_report')))throw new Error('Reporter 的必要读取或保存工具已禁用');
   const attachment=await prepareAttachments(this.db,this.dataDir,id,claimed.run.attachments,'conversation');
   if(attachment.images.length&&!model.model.input.includes('image'))throw new Error('模型未启用图片输入');
   const prompt=await systemRolePrompt(this.db,role);
   const taskContext=task?`\n\n【当前绑定任务】\n任务 #${taskID}：${task.description}\n用户目标：${task.goal}`:'';
   runner=await createTrackedRunner(this.db,taskID,role,{...model,...resources,cwd,agentDir:path.join(this.dataDir,'pi-agent'),resumeSessionPath:path.join(cwd,'session.jsonl'),signal:controller.signal,
    stopWhen:role==='reporter'?async()=>reportSaved&&pendingReports.size===0:undefined,
    loadDomainState:async()=>({conversation_id:id,...(role==='reporter'?{pending_report_ids:[...pendingReports],read_tool:'get_finding',save_tool:'update_finding_report'}:{})}),
    ...agentBudgets(config,{maxTurns:30,maxDurationMs:1200_000}),maxWrapupTurns:config.wrapupMaxTurns||2,
    wrapup:()=>role==='reporter'&&pendingReports.size?{prompt:config.wrapupPrompt||hostProtocol('reporter')}:undefined,
    systemPrompt:prompt+taskContext+(task?constraintBlock(await loadConstraints(this.db,task.exploration_id)):''),customTools:bound,
    toolAllowlist:[...bound.map(t=>t.name),...(['auto','reporter','pentest'].includes(role)?['read',...(role==='pentest'&&task?['bash','write','edit']:[])].filter(n=>!disabled.has(n)):[]),...((role==='auto'||task)&&resources.mcpEntries?.length?['mcp__*']:[])],
    guard:async g=>{await lease.assert();await agentRunConfig(this.db,role);const permitted=await applyToolBindings(this.db,role,[{name:g.toolName}]);if(!permitted.length)return {block:true,reason:'工具已禁用或解除绑定'};return gate(g);},onActivity:persist},id);
   await this.db.query('UPDATE conversations SET session_file=$2 WHERE id=$1',[id,runner.sessionFile??path.join(cwd,'session.jsonl')]);
   const triggerEvents=claimed.run.trigger_id?(await this.db.query('SELECT event_key,kind,task_id,payload FROM agent_trigger_events WHERE event_key=ANY($1::text[]) ORDER BY id',[claimed.run.event_keys??[]])).rows:null;
   const message=triggerEvents?JSON.stringify(triggerEvents.map(event=>({source:'blackboard',kind:event.kind,task_id:event.task_id,event_key:event.event_key,
     ...Object.fromEntries(Object.entries(event.payload as Record<string,unknown>??{}).filter(([key,value])=>/(?:_id|_version)$/.test(key)&&(typeof value==='string'||typeof value==='number')))}))):String(claimed.run.message);
   const result=await runner.prompt(message+(attachment.text?'\n\n'+attachment.text:''),attachment.images);
   await tail;if(!result.aborted&&pendingReports.size)throw new Error('报告未按证据版本保存');
   await this.db.query("UPDATE conversation_runs SET status=$3,finished_at=now() WHERE id=$1 AND token=$2",[runID,lease.token,result.aborted?'stopped':'completed']);
  }catch(error){if(runID)await this.db.query('UPDATE conversation_runs SET status=$3,error=$4,finished_at=now() WHERE id=$1 AND token=$2',[runID,lease.token,controller.signal.aborted?'stopped':'failed',String(error).slice(0,2000)]);}
  finally{await runner?.dispose();await tail.catch(()=>{});
   if(runID)await this.db.query(`INSERT INTO conversation_activities(conversation_id,worker,kind,summary,metadata)
    SELECT $1,'assistant','result',COALESCE(NULLIF(error,''),'回复结束'),jsonb_build_object('turn_id',$2::text,'event_type','lifecycle','status',status)
    FROM conversation_runs WHERE id=$3 AND token=$4 AND status IN ('completed','stopped','failed')`,[id,turnID,runID,lease.token]);
   await writer?.close().catch(()=>{});await lease.release();this.bus.emit(`conversation:${id}`,{kind:'settled'});}
 }
}
