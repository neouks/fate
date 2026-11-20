import {stableJSON} from '../db/operation-journal.js';
import type {ToolRunContext,TodoItem} from '../tools/context.js';
import {resolveGraphNode} from '../db/graph_view.js';
import {plannerGrounding,type ReadCoverage} from './planner-grounding.js';
import type {EvidenceRef} from './intent-contract.js';

export interface FollowUp { positive: string; question: string; blocker: 'method'|'environment'|'prerequisite'|'authorization'|'none'; }
export const followUpSchema={type:'object',additionalProperties:false,properties:{
 positive:{type:'string',minLength:1,maxLength:500,description:'实际观察到且尚有价值的正向能力或现象，不写推测的影响'},
 question:{type:'string',minLength:1,maxLength:500,description:'仍影响任务目标的一个待解决问题；超出本意图时只反馈'},
 blocker:{type:'string',enum:['method','environment','prerequisite','authorization','none']},
},required:['positive','question','blocker']};
export function normalizeFollowUp(value:FollowUp|undefined):FollowUp|undefined{
 if(value===undefined)return;
 if(!value||Object.keys(value).some(k=>!['positive','question','blocker'].includes(k))||
 !['method','environment','prerequisite','authorization','none'].includes(value.blocker))throw new Error('follow_up 格式无效');
 for(const key of ['positive','question'] as const)if(typeof value[key]!=='string'||!value[key].trim()||Array.from(value[key]).length>500)throw new Error(`follow_up.${key} 需要 1–500 字符`);
 return {positive:value.positive.trim(),question:value.question.trim(),blocker:value.blocker};
}
export interface DirectionReview {state:'continue'|'deferred'|'closed';basis:EvidenceRef[];scope:string;reason:string;recovery?:string;}
export const directionReviewSchema={type:'object',additionalProperties:false,properties:{
 state:{type:'string',enum:['continue','deferred','closed']},
 basis:{type:'array',minItems:1,maxItems:10,items:{type:'object',additionalProperties:false,properties:{node_id:{type:'integer',minimum:1},version:{type:'integer',minimum:0}},required:['node_id','version']}},
 scope:{type:'string',minLength:1,maxLength:1000,description:'决策适用的具体问题、方法和条件'},
 reason:{type:'string',minLength:1,maxLength:1000,description:'引用实测证据说明继续、暂缓或关闭的原因；关闭不代表目标达成'},
 recovery:{type:'string',maxLength:1000,description:'暂缓时必填，说明恢复所需条件'},
},required:['state','basis','scope','reason']};
export function hasDirectionEvidenceRead(reads:ReadCoverage[],ref:EvidenceRef){
 const current=reads.filter(r=>r.ref===`node:${ref.node_id}`&&r.version===ref.version&&r.view==='detail'&&r.fully_delivered);
 return current.some(r=>r.field===''||r.field==='/payload')||
 ['/payload/evidence','/payload/scope'].every(field=>current.some(r=>r.field===field));
}
export async function validateDirectionReviews(ctx:ToolRunContext,todos:TodoItem[]){
 const reviews=todos.filter(t=>t.review).map(t=>t.review!);
 if(!reviews.length)return;
 // Whole-list edits preserve prior checked reviews without forcing old evidence rereads.
 const saved=(await ctx.db.query('SELECT planner_todos FROM explorations WHERE id=$1 FOR UPDATE',[ctx.expID])).rows[0]?.planner_todos as TodoItem[]|undefined;
 const unchanged=new Set((saved??[]).filter(t=>t.review).map(t=>stableJSON(t.review)));
 const changed=reviews.filter(r=>!unchanged.has(stableJSON(r)));
 if(!changed.length)return;
 const grounding=changed.some(r=>r.state==='closed')?await plannerGrounding(ctx,ctx.sessionEntries?.()??[]):undefined;
 for(const r of changed){
  if(!['continue','deferred','closed'].includes(r.state)||!Array.isArray(r.basis)||!r.basis.length||r.basis.length>10)throw new Error('方向复核需要状态和 1–10 个事实引用');
  for(const key of ['scope','reason',...(r.state==='deferred'?['recovery'] as const:[])] as const){
   if(typeof r[key]!=='string'||!r[key]!.trim()||Array.from(r[key]!).length>1000)throw new Error(`review.${key} 需要 1–1000 字符`);
  }
  for(const ref of r.basis){
   if(!Number.isSafeInteger(ref.node_id)||ref.node_id<=0||!Number.isSafeInteger(ref.version)||ref.version<0)throw new Error('方向依据需要节点 ID 和内容版本');
   const {node}=await resolveGraphNode(ctx.db,ctx.taskID,ctx.expID,ref.node_id);
   if(!['fact','finding'].includes(node.kind)||node.content_version!==ref.version)throw new Error('方向依据已变化或不是事实/漏洞，请重新读取');
   if(r.state==='closed'){
    if(!node.payload.evidence||!node.payload.scope)throw new Error('关闭方向需要带 evidence 和 scope 的证据；条件不足请暂缓并说明恢复条件');
    if(!hasDirectionEvidenceRead(grounding!.reads,ref))throw new Error(`关闭前请用 context_get 读完 node:${ref.node_id} 当前版本的 /payload/evidence 与 /payload/scope`);
   }
  }
 }
}

/** Unresolved positive observations survive recent-work windows and compaction. */
export async function directionFollowUps(ctx:Pick<ToolRunContext,'db'|'taskID'|'expID'>){
 const rows=(await ctx.db.query(`SELECT n.id,n.content_version version,n.payload ? 'scope' has_scope,n.payload ? 'detail' has_detail,
  left(n.payload->'follow_up'->>'positive',240) positive,
  left(n.payload->'follow_up'->>'question',240) question,
  left(n.payload->'follow_up'->>'blocker',40) blocker,CASE WHEN decision.review IS NOT NULL THEN jsonb_build_object('state',decision.review->>'state','scope',left(decision.review->>'scope',240),'reason',left(decision.review->>'reason',240),'recovery',left(decision.review->>'recovery',160),'preview',true) END review,count(*) OVER() total
  FROM exploration_nodes n JOIN explorations e ON e.id=n.exploration_id
  JOIN tasks t ON t.exploration_id=e.id AND t.id=$1 AND t.deleted_at IS NULL
  LEFT JOIN LATERAL (SELECT todo->'review' review FROM jsonb_array_elements(COALESCE(e.planner_todos,'[]'::jsonb)) todo,
   jsonb_array_elements(CASE WHEN jsonb_typeof(todo->'review'->'basis')='array' THEN todo->'review'->'basis' ELSE '[]'::jsonb END) b
   WHERE b->>'node_id'=n.id::text AND b->>'version'=n.content_version::text LIMIT 1) decision ON true
  WHERE n.exploration_id=$2 AND n.kind='fact' AND n.state='confirmed' AND n.payload ? 'follow_up'
  AND exploration_node_readable($2,n.id)
  ORDER BY (decision.review->>'state'='closed') ASC NULLS FIRST,n.id LIMIT 8`,[ctx.taskID,ctx.expID])).rows;
 return {items:rows.map(({total,has_scope,has_detail,...r})=>({...r,scope_status:has_scope?'reported':'unspecified',ref:`node:${r.id}`,read_options:['/payload/evidence',...(has_scope?['/payload/scope']:[]),...(has_detail?['/payload/detail']:[])].map(field=>({ref:`node:${r.id}`,view:'detail',field,version:Number(r.version),offset:0}))})),
  total:Number(rows[0]?.total??0),has_more:Number(rows[0]?.total??0)>rows.length,
  meaning:'重要正向线索的有界摘要，完整内容按 read_options 读取。review 是模型决策且只适用于其 scope。关闭某种方法不会删除正向观察；不自动认定推测影响成立。结合当前待办、授权及活跃意图选择推进或暂缓；有更多时用 context_search 查询 follow_up 字段并读取原文。'};
}
