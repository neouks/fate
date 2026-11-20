import {directionReviewSchema,validateDirectionReviews} from '../agent/direction-review.js';
import {INTENT_RETRY_GUIDANCE,intentRetryArgumentError} from './input-contracts.js';
import type {WorkerCorrection} from '../agent/worker-correction.js';
import {CONVERGENCE_ADD_INTENT_HINT} from '../agent/planner-convergence.js';
// 意图工具：add_intent（唯一意图生成入口，含去重与 mainagent 直投下发）、
// dispatch_intents、kill_work / steer_work（引擎回调）、todo_write（planner 跨轮共享）。

import { domainTool } from "./define.js";
import type { ToolRunContext, TodoItem } from "./context.js";
import { KindIntent, RelDerivedFrom, nodeCancelledByUser } from "../db/exploration.js";
import { normalizeContract, type IntentContract } from '../agent/intent-contract.js';
import {workerCapabilities, validateWorkerToolNames} from '../agent/worker-capabilities.js';
import {priorPlannerDispatch,savePlannerDispatch,type SubmittedIntent} from '../db/planner-dispatch.js';

interface IntentItem { summary: string; parent_id?: number|string; parent_ids?: (number|string)[]; asset_ids?: (number|string)[]; priority?: number; contract?:IntentContract; retry_of?:number;retry_kind?:string;retry_reason?:string; replaces_intent_id?:number }
interface AddIntentArgs extends Partial<IntentItem> { intents?: IntentItem[]; }
function intentIDs(values:unknown,field:string):number[]{
  if(!Array.isArray(values))throw new Error(`${field} 必须为 ID 数组`);
  return [...new Set(values.map(v=>{
    const id=typeof v==='string'&&/^[0-9]+$/.test(v)?Number(v):v;
    if(typeof id!=='number'||!Number.isSafeInteger(id)||id<=0)throw new Error(`${field} 需要有效正整数 ID`);
    return id;
  }))];
}


const intentFields = {
                replaces_intent_id: {type:'integer',minimum:1,description:'目标变化时填写被替换的旧意图 ID。先 kill_work 并确认结束，再提交本项；宿主拒绝仍在执行、用户暂停或取消的旧意图。新意图使用独立会话，仅通过 parent_ids/contract.basis 传递必要事实，不复制旧会话。与 retry_of 互斥。'},
                summary: { type: "string", minLength: 1, maxLength: 2000, pattern: "\\S", description: "说明本项工作及目的，可明确接口、参数、步骤和验收要求" },
                parent_ids: {type:"array",maxItems:20,items:{anyOf:[{type:"integer",minimum:1},{type:"string",pattern:"^[0-9]+$"}]},description:"仅当前任务的事实或漏洞节点；来源任务证据用 contract.basis"},
                parent_id: { anyOf:[{type:"integer",minimum:1},{type:"string",pattern:"^[0-9]+$"}], description: "当前任务单个 fact/finding ID；与 parent_ids 二选一，省略则连任务根" },
                asset_ids: { type: "array", items: { anyOf:[{type:"integer",minimum:1},{type:"string",pattern:"^[0-9]+$"}] }, description: "业务范围或入口资产 ID，不要求预先枚举所有待发现接口；写回时再精确关联实际资产" },
                priority: { type: "integer", minimum: 0, maximum: 10, description: "省略或 0 按 5 处理" },
                contract: {type:'object',description:'可选执行要求，可补充目标、步骤、验收条件及边界。objective/acceptance 省略时沿用 summary；work 仅在已有稳定方向标识时使用。',properties:{
                  objective:{type:'string',description:'需要完成的工作，可明确执行步骤；后续补全须说明哪项用户要求仍缺数据或哪些已读证据矛盾，充分结论不重复核验'},acceptance:{type:'array',description:'可省略；仅描述结果所需结论、证据和覆盖说明，可明确接口与步骤，不预设成败结论。补全仅覆盖实际受影响对象与缺口及停止条件，明确沿用未受影响结论；不附加顺便复核其他对象的可选项，不追加用户未要求的全集/隐藏入口证明。',minItems:1,maxItems:10,items:{type:'string'}},out_of_scope:{type:'array',maxItems:20,items:{type:'string'}},
                  basis:{type:'array',description:'直接来源任务的证据放在此处，不放 parent_ids。填写已读取 fact/finding 的顶层 version/content_version，可为 0；read_receipt.version、writeback.version 是格式版本，不能作为依据版本。goal、intent 不是事实依据。',maxItems:20,items:{type:'object',properties:{node_id:{type:'integer',minimum:1},version:{type:'integer',minimum:0,description:'节点内容版本，不是读取回执或写回格式版本'}},required:['node_id','version']}},
                  work:{type:'object',description:'稳定工作身份，四项与派单资产范围共同参与匹配；重试沿用原值。旧意图没有 work 时，按原 summary 和资产范围核对，不要补造身份。',properties:{
                    resource:{type:'string',minLength:1,maxLength:2000,pattern:'\\S',description:'原工作资源标识，URL 或 asset:ID；重试保持资源一致'},
                    question_key:{type:'string',minLength:1,maxLength:200,pattern:'\\S',description:'稳定问题类别；匹配时忽略大小写和连续空白'},
                    method_class:{type:'string',minLength:1,maxLength:200,pattern:'\\S',description:'稳定方法类别；匹配时忽略大小写和连续空白'},
                    identity:{type:'string',minLength:1,maxLength:200,pattern:'\\S',description:'稳定区分标识；去除首尾空白后精确匹配，大小写敏感'},
                  },required:['resource','question_key','method_class','identity']},
                  allowed_tools:{type:'array',items:{type:'string'},maxItems:50,description:'默认省略，不要复制能力目录生成白名单，也不要仅因只读要求填写；让 Worker 自选已绑定且获授权的工具。仅明确需要限制时填写精确工具名，见 graph_overview.worker_capabilities；HTTP GET 使用 http_request，不能编造 http_get 等别名。内部写回和已绑定 Skill 文档的读取不受此清单限制。'},
                }},
                retry_of:{type:'integer',minimum:1,description:INTENT_RETRY_GUIDANCE},retry_kind:{type:'string',enum:['new_evidence','transient_failure'],description:'new_evidence 需要新的有效 contract.basis；transient_failure 仅重试 blocked/exhausted/stopped 的可恢复故障。与 retry_of、retry_reason 一起提供。'},retry_reason:{type:'string',minLength:1,maxLength:2000,pattern:'\\S',description:'非空重试原因，说明故障恢复条件或新增依据；与 retry_of、retry_kind 一起提供。'},
              };

function readIntentItems(args: AddIntentArgs): IntentItem[] {
  if (!args || typeof args !== 'object' || Array.isArray(args) || !Object.keys(args).length)
    throw new Error('Invalid arguments for tool "add_intent": 未收到意图参数。请按 {"intents":[{"summary":"具体方向与终点"}]} 提交；没有可派方向时结束本轮。');
  const batch = Object.hasOwn(args, 'intents');
  if (batch && (!Array.isArray(args.intents) || args.intents.length < 1 || args.intents.length > 4))
    throw new Error('Invalid arguments for tool "add_intent": intents 必须包含 1–4 项');
  if (batch && Object.keys(args).some(key => key !== 'intents'))
    throw new Error('Invalid arguments for tool "add_intent": 批量只允许顶层 intents，其他字段放入各项');
  const items = batch ? args.intents! : [args as IntentItem];
  for (const [index, item] of items.entries()) {
    const path = batch ? 'intents[' + index + '].' : '';
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.summary !== 'string' || !item.summary.trim() || item.summary.length > 2000) {
      throw new Error('Invalid arguments for tool "add_intent": ' + path + 'summary 必须是 1–2000 字符的非空方向说明');
    }
    const retryError=intentRetryArgumentError(item as unknown as Record<string,unknown>,path);
    if(retryError)throw new Error('Invalid arguments for tool "add_intent": '+retryError);
    if (Object.hasOwn(item, 'basis'))
      throw new Error('Invalid arguments for tool "add_intent": ' + path + 'basis 只能放在 contract.basis 中');
    if (item.parent_ids !== undefined && item.parent_id !== undefined)
      throw new Error('Invalid arguments for tool "add_intent": ' + path + 'parent_id 与 parent_ids 只能传一种');
    if (item.replaces_intent_id !== undefined && (!Number.isSafeInteger(item.replaces_intent_id) || item.replaces_intent_id <= 0 || item.retry_of !== undefined))
      throw new Error('replaces_intent_id 必须为正整数，不能与 retry_of 同时使用');
  }
  return items;
}

export function addIntentTool(ctx: ToolRunContext) {
  return domainTool<AddIntentArgs>(
    {
      name: "add_intent",
      description:
        "提交 1~4 条探索意图进 frontier，worker 将按优先级领取执行。提交前逐一与 open/running 意图及" +
        "近期已完成意图比对。每条意图只解决一个可独立验收的问题，说明必要证据和停止条件；依赖结果的后续工作待事实返回后另派。contract.work 可选，legacy_text 仅做文本去重；dedup.related_intent_ids 表示局部交叉，需读取已有工作协调职责，同一问题的必要步骤保留在一起。parent 必须是产出了证据的 fact/finding 节点" +
        "（发现驱动规划）。串行依赖链用 todo_write 记录，只派前置已满足的那一步。统一传 intents 数组；单条也放入数组，每项必填非空 summary。"+CONVERGENCE_ADD_INTENT_HINT,
      promptSnippet: "派发探索意图（先查重）",
      parameters: {
        type: "object", additionalProperties:false,
        properties: {
          intents: {
            type: "array", minItems: 1, maxItems: 4,
            description: "1–4 个前置已满足、可独立验收的问题；每个问题只放一个元素，依赖结果的后续工作本轮不创建。每个元素都会创建真实工作，不要把说明、备注、重复概述或对上一项的引用作为额外元素。每项必填独立完整的 summary，任一项无效整批不提交",
            items: { type: "object", properties: intentFields, required: ["summary"], additionalProperties: false,
              allOf:[
                {anyOf:[{required:['retry_of','retry_kind','retry_reason']},{not:{anyOf:[{required:['retry_of']},{required:['retry_kind']},{required:['retry_reason']}]}}]},
                {not:{required:['retry_of','replaces_intent_id']}},
              ] },
          },
        },
        required: ["intents"],
      },
      prepareArguments(input) {
        const args = input as AddIntentArgs;
        return {intents:readIntentItems(args)};
      },
      // Main's direct-intent grant must run after the intent transaction commits;
      // otherwise the host admission transaction cannot see the uncommitted node.
      transactional: false,
      async run(args, c) {
        const items = readIntentItems(args);
        const committed = await c.db.transaction(async db => {
          await c.hooks.assertOwnership?.(db);
          const receipt=await priorPlannerDispatch(db,c,{intents:items},items.length===1?items[0]:undefined);
          if(receipt?.prior)return {results:receipt.prior,replayed:true};
          const capabilities = await workerCapabilities({...c, db});
          const s = db.exploration(c.expID), originFact = await s.originFactID();
          const submitted: SubmittedIntent[] = [];
          for (const item of items) {
            const explicitParents=item.parent_ids??(item.parent_id!==undefined?[item.parent_id]:[]);
            const parentIDs=intentIDs(explicitParents,'parent_ids');
            if(!parentIDs.length&&originFact>0)parentIDs.push(originFact);
            const assetIDs=intentIDs(item.asset_ids??[],'asset_ids');
            const contract=normalizeContract(item.contract,item.summary);
            validateWorkerToolNames(contract.allowed_tools, capabilities);
            for(const parentID of parentIDs){
              const parent=await s.getNode(parentID);
              if(!parent||!['fact','finding'].includes(parent.kind)||!['confirmed','origin'].includes(parent.state))throw new Error(`parent #${parentID} 必须是当前任务已提交的事实或漏洞；直接来源任务的证据请使用 contract.basis（node_id 和内容 version）`);
              const ref=contract.basis.find(ref=>ref.node_id===parentID);
              if(!ref)contract.basis.push({node_id:parentID,version:parent.content_version??0});
            }
            const payload: Record<string, unknown> = { summary: item.summary,contract,
              ...(item.replaces_intent_id?{replaces_intent_id:item.replaces_intent_id}:{}),
              ...(item.retry_of?{retry_of:item.retry_of,retry_kind:item.retry_kind,retry_reason:item.retry_reason}:{}) };
            payload.parent_ids=parentIDs;
            if(parentIDs.length)payload.parent_id=parentIDs[0];
            if(c.role==='planner')payload.dispatch_requested=true;
            if(c.role==='mainagent'&&c.mainSegment!==undefined&&c.hooks.assertOwnership)payload.dispatch_source='mainagent';
            const res = c.role === "planner"
              ? await s.addPlannerIntentDeduplicated(payload, item.priority || 5, assetIDs, "planner")
              : await s.addIntentDeduplicated(payload, item.priority || 5, assetIDs, c.role === "worker" ? "worker" : "user");
            if(res.created)for(const ref of contract.basis)if(await s.getNode(ref.node_id))await s.link(ref.node_id,RelDerivedFrom,res.id);
            // Historical inactive proposals must pass the same fresh basis check before requeue.
            if(!res.created && c.role==='planner'){
              const previous=await s.getNode(res.id);
              const oldWork=(previous?.payload.contract as IntentContract|undefined)?.work;
              if(oldWork&&!contract.work)contract.work=oldWork;
              await db.query("UPDATE exploration_nodes SET payload=payload||$2::jsonb WHERE id=$1 AND state='open' AND payload->>'needs_replanning'='true'",[res.id,JSON.stringify({...payload,needs_replanning:false})]);
            }
            submitted.push({summary:item.summary,intent_id:res.id,created:res.created,dedup:res.dedup,...(!res.created?{duplicate_of:res.id}:{})});
          }
          if(receipt)await savePlannerDispatch(db,c.expID,receipt,submitted);
          return {results:submitted,replayed:false};
        });
        const results=committed.results;
        for (const result of results) if (result.created&&!committed.replayed) {
          c.hooks.notifyIntent?.(c.expID,result.intent_id);
          // The host signs a one-intent grant after the node is committed.
          if (c.role === "mainagent") await c.hooks.dispatchIntent?.(c.expID,result.intent_id);
        }
        return { submitted: results.filter((r) => r.created).length, intents: results, ids:results.map(r=>r.intent_id), errors:{}, duplicates:Object.fromEntries(results.flatMap((r,i)=>r.duplicate_of?[[i,r.duplicate_of]]:[])) };
      },
    },
    ctx,
  );
}

interface DispatchIntentsArgs { intent_ids?: number[]; all_open?: true; }

function validateDispatchArgs(args: DispatchIntentsArgs): void {
  if (args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 1) {
    if (args.all_open === true && !Object.hasOwn(args, 'intent_ids')) return;
    if (!Object.hasOwn(args, 'all_open') && Array.isArray(args.intent_ids) &&
        args.intent_ids.length >= 1 && args.intent_ids.length <= 10 &&
        args.intent_ids.every(id => Number.isSafeInteger(id) && id > 0)) return;
  }
  throw new Error('请提供 1–10 个正整数 intent_ids，或在用户明确要求批量下发时仅传 all_open: true');
}

export function dispatchIntentsTool(ctx: ToolRunContext) {
  return domainTool<DispatchIntentsArgs>(
    {
      name: "dispatch_intents",
      description:
        "把本任务待执行意图下发给 Worker；也可选择正在执行的意图订阅结果，不重复执行。仅任务主 Agent 可用；" +
        "手工执行模式下意图只有经此下发才会被执行。",
      promptSnippet: "下发待执行意图",
      parameters: {
        type: "object",
        properties: {
          intent_ids: {
            type: "array",
            items: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            minItems: 1, maxItems: 10,
            description: "要下发或订阅的 1–10 个意图 ID；与 all_open 二选一",
          },
          all_open: { type: "boolean", const: true, description: "仅在用户明确要求批量下发时传 true；最多取 50 条可下发的 open 意图" },
        },
        additionalProperties: false,
        oneOf: [{ required: ["intent_ids"] }, { required: ["all_open"] }],
      },
      prepareArguments(input) {
        // Check before PI can coerce booleans/numbers or drop optional null fields.
        const args = input as DispatchIntentsArgs;
        validateDispatchArgs(args);
        return args;
      },
      transactional:false,
      async run(args, c) {
        validateDispatchArgs(args);
        const s = c.db.exploration(c.expID);
        const ids = args.all_open
          ? (await s.frontier(50)).map(node => node.id)
          : [...new Set(args.intent_ids!)];
        let dispatched = 0;
        for (const id of ids) {
          const n = await s.getNode(id);
          if (!n || n.kind !== KindIntent || !["open", "running"].includes(n.state) || nodeCancelledByUser(n)) continue;
          if (!c.hooks.dispatchIntent) throw new Error("当前运行环境不支持下发意图");
          await c.hooks.dispatchIntent(c.expID, id);
          dispatched++;
        }
        return { dispatched };
      },
    },
    ctx,
  );
}

interface KillWorkArgs { intent_id: number; reason: string; }

export function killWorkTool(ctx: ToolRunContext) {
  return domainTool<KillWorkArgs>(
    {
      name: "kill_work",
      description:
        "确认当前方向明确无意义、重复、越界或被取消时直接终止，不反复纠偏或追加替代工作；保留已经写回的事实和 findings。已完成的意图应正常结束，不以 kill 代替完成。必要时用 get_worker_trace 核对实际进度。",
      promptSnippet: "终止在跑意图",
      parameters: {
        type: "object",
        properties: {
          intent_id: { type: "integer", minimum: 1 },
          reason: { type: "string", description: "终止原因（审计留痕）" },
        },
        required: ["intent_id", "reason"],
      },
      transactional:false,
      async run(args, c) {
        if (!c.hooks.killWork) throw new Error("当前运行环境不支持 kill_work");
        await c.hooks.killWork(c.expID, args.intent_id, args.reason,c.role);
        const node = await c.db.exploration(c.expID).getNode(args.intent_id);
        if (!node || !['stopped','done','blocked','exhausted'].includes(node.state) || nodeCancelledByUser(node))
          throw new Error('旧意图尚未确认结束；不得下发替代意图');
        return { killed: args.intent_id, state: node.state };
      },
    },
    ctx,
  );
}

interface SteerWorkArgs { intent_id: number; correction: WorkerCorrection; }

export function steerWorkTool(ctx: ToolRunContext) {
  return domainTool<SteerWorkArgs>(
    {
      name: "steer_work",
      description:
        "通过 PI steering 调整原验收项的方法、缩减范围或引用已有事实；方法调整仅用于原目标、原授权内，不新增目标、验收项或前置工作。" +
        "进入收尾或已完成时禁止纠偏；已完成正常结束，明确无意义或重复的直接 kill_work，保留已写回数据。",
      promptSnippet: "运行中纠偏（不打断）",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          intent_id: { type: "integer", minimum: 1 },
          correction: {type:'object',additionalProperties:false,properties:{
            kind:{type:'string',enum:['stop_criteria','reuse_evidence','adjust_method']},
            criterion_indices:{type:'array',minItems:1,maxItems:10,items:{type:'integer',minimum:0},description:'原意图 acceptance 的从 0 开始索引；stop_criteria 停止这些项，reuse_evidence 引用证据，adjust_method 调整这些项的实现方法'},
            fact_ids:{type:'array',minItems:1,maxItems:20,items:{type:'integer',minimum:1},description:'仅 reuse_evidence 使用：当前任务已有有效 fact/finding 节点 ID'},
            method:{type:'string',minLength:1,maxLength:2000,description:'仅 adjust_method：具体方法建议，例如纠正参数或更换无效方法；不得扩大原目标、验收项、资产范围或工具授权'},
            reason:{type:'string',minLength:1,maxLength:1000,description:'仅 adjust_method：已观察到的失败、重复尝试或方法不适配及调整依据'},
          },required:['kind','criterion_indices'],oneOf:[
            {properties:{kind:{const:'stop_criteria'}},not:{anyOf:[{required:['fact_ids']},{required:['method']},{required:['reason']}]}},
            {properties:{kind:{const:'reuse_evidence'}},required:['fact_ids'],not:{anyOf:[{required:['method']},{required:['reason']}]}},
            {properties:{kind:{const:'adjust_method'}},required:['method','reason'],not:{required:['fact_ids']}},
          ]},
        },
        required: ["intent_id", "correction"],
      },
      transactional:false,
      async run(args, c) {
        if (!c.hooks.steerWork) throw new Error("当前运行环境不支持 steer_work");
        await c.hooks.steerWork(c.expID, args.intent_id, args.correction,c.role);
        return { steered: args.intent_id };
      },
    },
    ctx,
  );
}

interface TodoWriteArgs { todos: TodoItem[]; }

export function todoWriteTool(ctx: ToolRunContext) {
  return domainTool<TodoWriteArgs>(
    {
      name: "todo_write",
      description:
        "维护本任务的待办与重要线索复核（跨规划轮保留）；review 记录证据范围、继续/暂缓/关闭及恢复条件。规则：串行利用链逐条记录；每轮只对【前置已完成、" +
        "依赖的 fact 已存在】的下一步派意图；已由 fact 满足的步骤标记 completed；不要重复派 pending/" +
        "in_progress 的步骤。",
      promptSnippet: "更新攻击链待办（跨轮共享）",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            maxItems: 50,
            description: "完整待办列表（整体替换）",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                review: {...directionReviewSchema,description:"重要线索的方向复核。关闭前读取引用证据与范围；暂缓填写恢复条件。普通待办可省略。"},
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
      transactional:false,
      async run(args, c) {
        const reviews=args.todos.filter(t=>t.review).map(t=>({content:t.content,review:t.review}));
        await c.db.transaction(async db=>{
          await c.hooks.assertOwnership?.(db);
          await validateDirectionReviews({...c,db},args.todos);
          await db.query("UPDATE explorations SET planner_todos=$2::jsonb WHERE id=$1",[c.expID,JSON.stringify(args.todos)]);
          if(reviews.length)await db.exploration(c.expID).appendActivity({worker:c.role,kind:'status',summary:'已记录方向复核 '+reviews.length+' 项',detail:JSON.stringify(reviews),metadata:{event_type:'direction_review',semantic_verification:false}});
        });
        c.todos?.cache(c.expID,args.todos);
        return { saved: args.todos.length,reviewed:reviews.length,meaning:'已校验引用与关闭所需读取记录；不代表宿主验证了结论语义' };
      },
    },
    ctx,
  );
}
