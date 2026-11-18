import {reporterTrafficTools} from './reporter-traffic.js';
import {webSearchTool} from './web-search.js';
import {archiveReport,prepareReproduction,attachStepTraffic,assembleReport,reproductionSchema,expandTrafficPackets} from '../evidence/reproduction.js';
import {reportSections,reportSectionsSchema} from '../evidence/report-sections.js';
import {requireTaskGoal} from "../agent/task-goal.js";
import type {ToolDefinition} from '@earendil-works/pi-coding-agent';
import {domainTool} from './define.js';
import type {ToolRunContext} from './context.js';
import {findingEvidence} from '../evidence/store.js';
export function conversationDomainTools(ctx:ToolRunContext,options:{profileID?:number;pendingReports?:Set<number>;onSaved?:()=>void}={}){
 const tools:ToolDefinition[]=[],role=ctx.role,taskID=ctx.taskID,profileID=options.profileID??0;
 if(role!=='goals')tools.push(webSearchTool(ctx));
 tools.push(...reporterTrafficTools(ctx));
 const reads=new Map<number,{evidence:number;revision:number;ranges:Array<[number,number]>;total:number;complete:boolean}>();
 const pendingReports=options.pendingReports??new Set<number>(),onSaved=options.onSaved??(()=>{});
   if(role==='auto'){
    const make=(name:string,description:string,properties:Record<string,unknown>,run:(a:Record<string,unknown>)=>Promise<Record<string,unknown>>,required:string[]=[])=>domainTool({name,description,transactional:false,parameters:{type:'object',properties,required},run},ctx);
    tools.push(make('list_tasks','分页列出平台任务',{after_id:{type:'integer'}},async a=>({tasks:(await ctx.db.query('SELECT id,name,goal,status,paused,queued FROM tasks WHERE deleted_at IS NULL AND id>$1 ORDER BY id LIMIT 10',[Number(a.after_id)||0])).rows})),
     make('get_task','查询任务状态',{task_id:{type:'integer'}},async a=>({task:await ctx.db.tasks().getTask(Number(a.task_id))}),['task_id']),
     make('list_llm_profiles','列出可选模型，不返回密钥',{},async()=>({profiles:(await ctx.db.platform().listProfiles()).map(p=>({id:p.id,name:p.name,model:p.model}))})),
     make('spawn_task','创建目标会话，由用户进入任务继续对话',{description:{type:'string'},goal:{type:'string'},llm_profile_id:{type:'integer',minimum:1}},async a=>{
      const profile=Number(a.llm_profile_id)||profileID;
      const task=await ctx.db.tasks().createGoalTask(String(a.description),requireTaskGoal(a.goal),{llmProfileIDs:profile?[profile]:[]});
      return {task};
     },['description','goal']));
   }
   if(['reporter','auto'].includes(role)){
     const reporter=role==='reporter';
     tools.push(domainTool<{finding_id:number;offset?:number}>({name:'get_finding',description:'读取漏洞、证据版本及绑定；报告正文使用 offset 续读。',readOnly:true,parameters:{type:'object',properties:{finding_id:{type:'integer'},offset:{type:'integer',minimum:0}},required:['finding_id']},async run(a,c){
     const f=(await c.db.query('SELECT * FROM findings WHERE id=$1 AND ($2::bigint=0 OR task_id=$2) AND finding_readable(id)',[a.finding_id,taskID])).rows[0];if(!f)throw new Error('漏洞不存在或未获当前任务授权');if(role==='reporter'&&(!f.report||f.report_evidence_version==null||Number(f.report_evidence_version)!==Number(f.evidence_version)))pendingReports.add(Number(f.id));
     const body=Array.from(JSON.stringify(f)),off=Math.max(0,a.offset??0),end=Math.min(body.length,off+1500);
     const prior=reads.get(Number(f.id));
     const read=prior&&prior.evidence===Number(f.evidence_version)&&prior.revision===Number(f.report_revision)?prior:{evidence:Number(f.evidence_version),revision:Number(f.report_revision),ranges:[] as Array<[number,number]>,total:body.length,complete:false};
     read.ranges.push([Math.min(off,body.length),end]);read.ranges.sort((x,y)=>x[0]-y[0]);let covered=0;for(const [start,stop] of read.ranges){if(start>covered)break;covered=Math.max(covered,stop);}read.complete=covered>=body.length;reads.set(Number(f.id),read);
     return {finding_id:Number(f.id),evidence_version:Number(f.evidence_version),report_revision:Number(f.report_revision),read_complete:read.complete,content:body.slice(off,off+1500).join(''),next_offset:off+1500<body.length?off+1500:null,evidence:await findingEvidence(c.db,a.finding_id)};
    }},ctx) as never,domainTool<{finding_id:number;evidence_version:number;report?:string;report_revision?:number;report_sections?:unknown;reproduction?:unknown}>({name:'update_finding_report',transactional:false,description:'先读完漏洞证据，再带版本保存精简自然语言报告。复现 HTTP 请求和响应引用完整协议报文，优先用真实 traffic_id 展开 Header 和 Body；缺失说明，不补造。',parameters:{
      type:'object',
      properties:{
        finding_id:{type:'integer',minimum:1},
        evidence_version:{type:'integer',minimum:0},
        ...(!reporter?{report:{type:'string',pattern:'\\S',description:'兼容旧报告；优先提交 report_sections'}}:{}),
        report_revision:{type:'integer',minimum:0,description:'get_finding 返回的报告版本'},
        report_sections:reportSectionsSchema(reporter),
        reproduction:reproductionSchema,
      },
      required:['finding_id','evidence_version',...(reporter?['report_revision','report_sections']:[])],
      ...(reporter?{additionalProperties:false}:{anyOf:[{required:['report_sections']},{required:['report']}]}),
    },async run(a,c){
     const sections=reporter||a.report_sections!==undefined?reportSections(a.report_sections,reporter):null;
     if(reporter&&a.report_revision===undefined)throw new Error('需要 get_finding 返回的 report_revision');
     if(sections ? !sections.description.trim() : !a.report?.trim())
       throw new Error('需要非空 report_sections.description 或兼容的非空 report');
     const saved=await c.db.transaction(async db=>{await c.hooks.assertOwnership?.(db);c={...c,db};
     const seen=reads.get(a.finding_id);
     if(!seen)throw new Error('必须先 get_finding 读取证据及报告版本');
     if(!seen.complete)throw new Error('漏洞内容尚未读完，请按 get_finding 的 next_offset 续读；分段预览不等于全文已读');
     const f=(await c.db.query('SELECT * FROM findings WHERE id=$1 AND ($2::bigint=0 OR task_id=$2) AND finding_readable(id) FOR UPDATE',[a.finding_id,taskID])).rows[0];
     if(!f||Number(f.evidence_version)!==a.evidence_version||Number(f.report_revision)!==seen.revision||
        (a.report_revision!==undefined&&a.report_revision!==seen.revision)||seen.evidence!==a.evidence_version)throw new Error('证据或报告版本已变化，请重新读取');
     await archiveReport(c.db,f);
     const repro=a.reproduction===undefined?await expandTrafficPackets(c.db,structuredClone(f.reproduction) as import('../evidence/reproduction.js').Reproduction|null,Number(f.task_id)):await prepareReproduction(c.db,a.reproduction,{taskID:Number(f.task_id),evidence:String(f.evidence),findingNodeID:Number(f.node_id)},true);
     if(a.reproduction!==undefined)await attachStepTraffic(c.db,a.finding_id,Number(f.task_id),repro);
     const version=Number((await c.db.query('SELECT evidence_version FROM findings WHERE id=$1',[a.finding_id])).rows[0]!.evidence_version);
     const report=sections?assembleReport({...f,report_sections:sections,reproduction:repro,report_evidence_version:version,evidence_version:version}):a.report!;
     await c.db.query('UPDATE findings SET report=$2,report_sections=$3,reproduction=$4,report_evidence_version=$5,report_revision=report_revision+1 WHERE id=$1',[a.finding_id,report,sections,repro,version]);
     return {saved:true};
     });pendingReports.delete(a.finding_id);onSaved();return saved;
    }},ctx) as never);
   }

 return tools;
}
