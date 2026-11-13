import {FINDING_WRITE_GUIDANCE} from '../agent/finding-write-policy.js';
import {amendFinding,findDuplicate,findingReceipt,readFindingWriteReceipt,saveFindingWriteReceipt,type FindingWriteArgs} from './finding-amendments.js';
import {proposeGoalAcceptance} from '../db/goal-integrity.js';
import {prepareReproduction,attachStepTraffic,reproductionSchema} from '../evidence/reproduction.js';
import {findingPublished} from '../db/worker-drafts.js';
import {writeOrigin,writeAnchors,assertDirectWrite,sourceFields,sameSource} from './write-origin.js';
import {bindEvidence} from "../evidence/store.js";
import { graphSources, resolveGraphNode } from "../db/graph_view.js";
// 漏洞工具：report_finding（worker 三通道写回之一）、list_findings、prove_goal（收官）。

import { domainTool } from "./define.js";
import type { ToolRunContext } from "./context.js";
import { KindFinding, RelYields, RelProves } from "../db/exploration.js";
import { jsonbClean } from "../db/exploration.js";
import {normalizeWritebackScope,writebackReceipt,savedWritebackReceipt,writebackScopeSchema,type WritebackScope} from './writeback-scope.js';

const SEVERITIES = ["critical", "high", "medium", "low"];

type ReportFindingArgs = FindingWriteArgs;

export function reportFindingTool(ctx: ToolRunContext) {
  return domainTool<ReportFindingArgs>(
    {
      name: "report_finding",
      description: FINDING_WRITE_GUIDANCE,
      promptSnippet: "报告确认的漏洞（须可复现）",
      parameters: {
        type: "object",additionalProperties:false,
        properties: {
          finding_id:{type:'integer',minimum:1,description:'补正已有漏洞时填正式 finding_id（不是 node_id）；省略表示创建'},
          evidence_version:{type:'integer',minimum:0,description:'补正必填，从 context_get 的 finding_detail 读取最新证据版本'},
          distinct_from:{type:'array',minItems:1,maxItems:50,uniqueItems:true,items:{type:'integer',minimum:1},description:'疑似重复但确认独立机理时，列已核对的本任务漏洞 ID'},
          distinct_reason:{type:'string',minLength:1,maxLength:1000,description:'与 distinct_from 不同的具体机理或影响；补资产和证据不属于独立问题'},
          reproduction:reproductionSchema,
          traffic_refs:{type:"array",items:{type:"object",properties:{traffic_id:{type:"string"},role:{type:"string",enum:["baseline","proof","verification","supporting"]},note:{type:"string"}},required:["traffic_id"]}},
          vulnclass: { type: "string", description: "漏洞类别，如 SQL注入/XSS/SSRF/未授权访问" },
          name: { type: "string", description: "漏洞标题（可读）" },
          severity: { type: "string", enum: SEVERITIES },
          summary: { type: "string", description: "影响与成因概述" },
          evidence: { type: "string", description: "复现证据（请求/响应/命令输出原文）" },
          asset_ids: { type: "array", items: { type: "integer",minimum:1 }, description: "本漏洞实际受影响的资产 ID；补正时追加并去重，不删除旧关联。缺省不继承意图资产" },
          scope:writebackScopeSchema,
        },
        anyOf:[{required:['finding_id','evidence_version']},{required:['vulnclass','severity','summary','evidence']}],
      },
      // This operation owns its DB transaction and publishes only after commit.
      transactional: false,
      async run(args, c) {
        assertDirectWrite(args);
        if(!['worker','mainagent','pentest'].includes(c.role))throw new Error('当前角色不能创建或补正漏洞；Planner 应由原 Worker 补正');
        if(args.finding_id!==undefined){
          if(!Number.isSafeInteger(args.finding_id)||args.finding_id<=0||!Number.isSafeInteger(args.evidence_version)||args.evidence_version!<0)throw new Error('补正需要有效 finding_id 和 evidence_version');
          if(args.distinct_from!==undefined||args.distinct_reason!==undefined)throw new Error('补正不能同时声明独立漏洞');
          if(!['asset_ids','evidence','scope','reproduction','traffic_refs'].some(k=>k in args))throw new Error('请提供要补充的资产、证据、复现或范围');
        }else{
          if(args.evidence_version!==undefined)throw new Error('evidence_version 需要配合 finding_id，不能重新报洞');
          if (!args.evidence?.trim()) throw new Error('漏洞缺少实际证据');
          if (!args.summary?.trim()) throw new Error('summary 不能为空');
          if(!args.vulnclass?.trim()||!SEVERITIES.includes(args.severity??''))throw new Error('漏洞类别或严重性无效');
        }
        if(args.distinct_from!==undefined&&(!Array.isArray(args.distinct_from)||!args.distinct_from.length||args.distinct_from.length>50||args.distinct_from.some(id=>!Number.isSafeInteger(id)||id<=0)||!args.distinct_reason?.trim()))throw new Error('独立漏洞需提供已核对的 distinct_from 和具体 distinct_reason');
        if(args.distinct_reason!==undefined&&!args.distinct_from?.length)throw new Error('distinct_reason 需要关联 distinct_from');
        let created=false;
        const saved = await c.db.transaction(async db => {
        await c.hooks.assertOwnership?.(db);
        await db.query('SELECT pg_advisory_xact_lock($1)', [-c.expID]);
        const s = db.exploration(c.expID);
        const origin = await writeOrigin({...c,db});
        const replay=await readFindingWriteReceipt(db,c,origin,args);
        if(replay)return replay;
        if(args.finding_id!==undefined){
          const updated=await amendFinding({...c,db},origin,args);
          await saveFindingWriteReceipt(db,c,origin,args,updated);
          created=updated.updated===true;
          return updated;
        }
        const anchors = await writeAnchors({...c,db},origin,args.asset_ids);
        if(c.toolCallID){
          const existing=(await db.query(`SELECT f.id,f.node_id,f.evidence_version,n.payload FROM findings f JOIN exploration_nodes n ON n.id=f.node_id
            WHERE f.task_id=$1 AND f.tool_call_id=$2`,[c.taskID,c.toolCallID])).rows[0];
          if(existing){
            const payload=existing.payload as Record<string,unknown>;
            if(!sameSource(c,origin,payload))throw new Error('工具调用编号已用于其他来源');
            const savedAnchors=await writeAnchors({...c,db},origin,await s.anchorAssetIDs(Number(existing.node_id)));
            return {finding_node_id:Number(existing.node_id),finding_id:Number(existing.id),evidence_version:Number(existing.evidence_version),replayed:true,asset_ids:savedAnchors,writeback:savedWritebackReceipt(payload.writeback)};
          }
        }

        if(args.distinct_from?.length){
          const visible=await db.query('SELECT id FROM findings WHERE task_id=$1 AND id=ANY($2::bigint[]) AND finding_readable(id)',[c.taskID,args.distinct_from]);
          if(visible.rowCount!==new Set(args.distinct_from).size)throw new Error('distinct_from 包含其他任务或不可读漏洞');
        }
        const {duplicate}=await findDuplicate({...c,db},origin,args,anchors);
        if(duplicate){
          const receipt=findingReceipt(duplicate,{created:false,duplicate:true,changes_applied:false,next_action:'已有漏洞，未新增。补资产或证据请读取后带 finding_id 和 evidence_version 再提交。'});
          await saveFindingWriteReceipt(db,c,origin,args,receipt);
          return receipt;
        }
        const reproduction=await prepareReproduction(db,args.reproduction,{taskID:c.taskID,intentID:c.intentID,evidence:args.evidence!});
        const payload: Record<string, unknown> = {
          vulnclass: args.vulnclass,
          name: args.name ?? "",
          severity: args.severity,
          summary: args.summary,
          ...sourceFields(c,origin),
        };
        const scope=normalizeWritebackScope(args.scope);
        if(scope)payload.scope=scope;
        if(args.distinct_from?.length)payload.distinction={finding_ids:args.distinct_from,reason:args.distinct_reason};
        payload.writeback=writebackReceipt(anchors,scope,args.evidence!,'finding');
        const nodeID = await s.addNode(KindFinding, payload, 0, "confirmed", c.workerName ?? c.role, anchors);
        await s.link(origin.id, RelYields, nodeID);

        const ins = await db.query<{ id: string }>(
          `INSERT INTO findings(task_id, node_id, vulnclass, name, severity, summary, evidence, worker, asset_ids, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'pending') RETURNING id`,
          [
            c.taskID,
            nodeID,
            args.vulnclass,
            args.name ?? "",
            args.severity,
            args.summary,
            args.evidence,
            c.workerName ?? c.role,
            jsonbClean(JSON.stringify(anchors)),
          ],
        );
        const findingID=Number(ins.rows[0]!.id);
        await db.query("UPDATE findings SET tool_call_id=$2,reproduction=$3 WHERE id=$1",[findingID,c.toolCallID??null,reproduction]);
        await attachStepTraffic(db,findingID,c.taskID,reproduction);
        if(args.traffic_refs?.length)await bindEvidence(db,findingID,args.traffic_refs,c.taskID);
        await findingPublished(db,c.expID,nodeID);
        created=true;
        const version=Number((await db.query('SELECT evidence_version FROM findings WHERE id=$1',[findingID])).rows[0]!.evidence_version);
        const receipt={finding_node_id:nodeID,finding_id:findingID,evidence_version:version,asset_ids:anchors,writeback:payload.writeback,created:true};
        await saveFindingWriteReceipt(db,c,origin,args,receipt);
        return receipt;
        });
        // Nested callers leave delivery to the durable wakeup after their outer commit.
        if(created&&!c.db.transactionClient)c.hooks.notifyFinding?.(c.expID, Number(saved.finding_node_id));
        return saved;
      },
    },
    ctx,
  );
}

interface ListFindingsArgs { limit?: number; offset?: number; include_inherited?: boolean; }

export function listFindingsTool(ctx: ToolRunContext) {
  return domainTool<ListFindingsArgs>(
    {
      name: "list_findings",
      description: "列出本任务（可选含继承来源任务）已报告的漏洞——报洞前查重、了解已有战果。",
      promptSnippet: "查询已报漏洞",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "默认 20，上限 50" },
          offset: { type: "integer" },
          include_inherited: { type: "boolean", description: "是否含只读继承的来源任务漏洞，默认 false" },
        },
      },
      readOnly: true,
      async run(args, c) {
        const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
        let where = `f.task_id=$1`;
        const params: unknown[] = [c.taskID];
        if (args.include_inherited) {
          where = `f.task_id = ANY($1::bigint[])`;
          const src = await c.db.query<{ source_task_id: string }>(
            `SELECT source_task_id FROM task_relations WHERE task_id=$1`,
            [c.taskID],
          );
          params[0] = [c.taskID, ...src.rows.map((r) => Number(r.source_task_id))];
        }
        const res = await c.db.query(
          `SELECT f.id, f.task_id, f.node_id, f.vulnclass, f.name, f.severity, f.summary, f.status, f.asset_ids, f.evidence_version, f.created_at
           FROM findings f WHERE ${where} ORDER BY f.created_at DESC LIMIT ${limit} OFFSET ${args.offset ?? 0}`,
          params,
        );
        const sources=await graphSources(c.db,c.taskID),sourceByTask=new Map(sources.map(source=>[source.taskID,source]));
        const visible=[] as typeof res.rows;
        for(const row of res.rows){
          const ownerTask=Number(row.task_id),owner=ownerTask===c.taskID?{taskID:c.taskID,expID:c.expID}:sourceByTask.get(ownerTask);
          if(!owner)continue;
          try{
            if(row.node_id!==null){await resolveGraphNode(c.db,c.taskID,c.expID,Number(row.node_id));}
            else{
            }
            visible.push(row);
          }catch{/* Unauthorized evidence is omitted from the role's projection. */}
        }
        return {
          findings: visible.map((r: Record<string, unknown>) => ({
            id: Number(r["id"]),
            node_id: r["node_id"] === null ? null : Number(r["node_id"]),
            vulnclass: r["vulnclass"],
            name: r["name"],
            severity: r["severity"],
            summary: r["summary"],
            status: r["status"],
            asset_ids: r["asset_ids"],
            evidence_version:Number(r['evidence_version']),
          })),
        };
      },
    },
    ctx,
  );
}

interface ProveGoalArgs { goal_id: number; evidence_node_id: number; note?: string; }

export function proveGoalTool(ctx: ToolRunContext) {
  return domainTool<ProveGoalArgs>(
    {
      name: "prove_goal",
      description:
        "提交 goal_id 的证据供验收。明确的资产覆盖度 100% 由宿主核验；其他目标返回 awaiting_confirmation，等待人工确认，不能宣称已达成或重复提交催促。" +
        "调用前必须核对覆盖度与漏洞总数（量化验收），不允许在明显未测完时提前收官。",
      promptSnippet: "提交目标证据供宿主或人工验收",
      parameters: {
        type: "object",
        properties: {
          goal_id: { type: "integer", description: "目标节点 id" },
          evidence_node_id: { type: "integer", description: "支撑证据的节点 id（fact 或 finding）" },
          note: { type: "string", description: "一句话判定依据" },
        },
        required: ["goal_id", "evidence_node_id"],
      },
      transactional: false,
      async run(args, c) {
        const result=await proposeGoalAcceptance(c.db,c.taskID,args.goal_id,args.evidence_node_id,args.note,c.toolCallID,c.hooks.assertOwnership);
        if(result.all_goals_met)c.hooks.notifyGoalMet?.(c.expID,args.goal_id);
        return result;
      },
    },
    ctx,
  );
}
