// 目标与约束工具：set_goals（目标分解/mainagent 追加）、set_constraints（操作边界）、
// register_user_target（显式授权登记）。

import { domainTool } from "./define.js";
import type { ToolRunContext } from "./context.js";
import { RelSpawns } from "../db/exploration.js";

interface SetGoalsArgs { goals: { text: string; vulnclass?: string }[]; }

export function setGoalsTool(ctx: ToolRunContext) {
  return domainTool<SetGoalsArgs>(
    {
      name: "set_goals",
      description:
        "登记任务的可验证最终目标（主 Agent 追加；初始分解阶段替换）。目标 = 可独立核验的交付物（拿到什么权限/证明什么漏洞/" +
        "覆盖什么范围）；信息收集、漏洞验证过程、攻击步骤都不是目标。每个目标给漏洞类别便于归类。",
      promptSnippet: "设定/替换任务目标",
      parameters: {
        type: "object",
        properties: {
          goals: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: {
              type: "object",
              properties: {
                text: { type: "string", description: "目标描述（自包含、可验证）" },
                vulnclass: { type: "string", description: "关联漏洞类别（可选）" },
              },
              required: ["text"],
            },
          },
        },
        required: ["goals"],
      },
      // Notify the running scheduler only after the replacement/append is committed.
      transactional: false,
      async run(args, c) {
        const ids = await c.db.transaction(async db=>{
          await c.hooks.assertOwnership?.(db);
          const s=db.exploration(c.expID),originFact=await s.originFactID();
          if(c.role==='goals')for(const g of await s.listByKind('goal',100))await s.deleteGoal(g.id);
          const created:number[]=[];
          for(const g of args.goals){
            const id=await s.addGoal({text:g.text,...(g.vulnclass?{vulnclass:g.vulnclass}:{})},c.role==='goals'?'goals':'user');
            if(originFact>0)await s.link(originFact,RelSpawns,id);created.push(id);
          }
          return created;
        });
        if (c.role === "mainagent") await c.hooks.goalsChanged?.(c.expID);
        return { goals: ids };
      },
    },
    ctx,
  );
}

interface SetConstraintsArgs { replace?: boolean; constraints: { kind: "allow" | "deny"; text: string }[]; }

export function setConstraintsTool(ctx: ToolRunContext) {
  return domainTool<SetConstraintsArgs>(
    {
      name: "set_constraints",
      description:
        "登记任务操作约束（allow/deny 边界），注入 planner 与 worker 的最高优先级指令。" +
        "约束必须自包含：把'当前目标'、'该端口'等指代替换成具体值。禁止臆造用户没说的约束。",
      promptSnippet: "登记操作约束（allow/deny）",
      parameters: {
        type: "object",
        properties: {
          replace: { type: "boolean", description: "默认追加。仅当用户明确要求整体替换现有约束时设为 true。" },
          constraints: {
            type: "array",
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["allow", "deny"] },
                text: { type: "string" },
              },
              required: ["kind", "text"],
            },
          },
        },
        required: ["constraints"],
      },
      transactional: false,
      async run(args, c) {
        await c.db.transaction(async tx=>{
          await c.hooks.assertOwnership?.(tx);
          await tx.query("SELECT pg_advisory_xact_lock($1)", [c.expID]);
          if (args.replace) await tx.query(`DELETE FROM task_constraints WHERE exploration_id=$1`, [c.expID]);
          for (const k of args.constraints) {
            await tx.query(`INSERT INTO task_constraints(exploration_id,kind,text,origin)
              SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM task_constraints WHERE exploration_id=$1 AND kind=$2 AND text=$3)`,
              [c.expID,k.kind,k.text,c.role]);
          }
        });
        c.hooks.constraintsChanged?.(c.expID);
        return { saved: args.constraints.length };
      },
    },
    ctx,
  );
}

export async function loadConstraints(db: ToolRunContext["db"], expID: number): Promise<{ kind: string; text: string }[]> {
  const res = await db.query<{ kind: string; text: string }>(
    `SELECT kind, text FROM task_constraints WHERE exploration_id=$1 ORDER BY id`,
    [expID],
  );
  return res.rows;
}

interface RegisterTargetArgs { kind: "root_domain" | "subdomain" | "ip" | "cidr"; value: string; evidence: string; }

export function registerUserTargetTool(ctx: ToolRunContext) {
  return domainTool<RegisterTargetArgs>(
    {
      name: "register_user_target",
      description:
        "登记用户明确授权的测试目标（显式授权边界）。只登记原文明确授权的资产：要求任务描述中有完整授权语句" +
        "作为 evidence；只登记精确主机或原文明示的通配域/CIDR；不把子域缩成根域；示例/参考/禁止目标一律不登记。",
      promptSnippet: "登记用户明确授权的目标",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["root_domain", "subdomain", "ip", "cidr"], description: "目标类型" },
          value: { type: "string", description: "授权的目标值（原文出现的形式）" },
          evidence: { type: "string", description: "任务描述中的完整授权语句原文" },
        },
        required: ["kind", "value", "evidence"],
      },
      async run(args, c) {
        if (!args.evidence.trim()) throw new Error("必须提供任务描述中的授权语句原文");
        await c.db.taskScope().addAgentScope(c.taskID, args.kind, args.value, args.evidence, "manual");
        return { registered: true, kind: args.kind, value: args.value };
      },
    },
    ctx,
  );
}
