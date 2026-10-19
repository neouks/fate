// 资产图工具：insert_assets（worker 三通道写回之一）、list_assets、
// list_untested_assets、add_task_scope。

import { domainTool } from "./define.js";
import type { ToolRunContext } from "./context.js";

/** insert_assets 单项的联合形状（按 type 取用相关字段，程序侧归一与去重）。 */
interface AssetItem {
  type: "root_domain" | "subdomain" | "ip" | "service" | "endpoint" | "app";
  // root_domain / subdomain
  domain?: string;
  icp?: string;
  record_type?: string;
  record_value?: string[];
  // ip
  ip?: string;
  bound_domains?: string[];
  open_ports?: { port: number; service: string }[];
  // service
  url?: string;
  service_name?: string;
  technologies?: string[];
  status_code?: number;
  content_length?: number;
  page_title?: string;
  auth?: Record<string, unknown>[];
  // endpoint
  method?: string;
  params?: Record<string, unknown>[];
  // service 端口
  port?: number;
  // app
  name?: string;
  bundle_id?: string;
  category?: string;
  description?: string;
}

interface InsertAssetsArgs { items: AssetItem[]; }

export function insertAssetsTool(ctx: ToolRunContext) {
  return domainTool<InsertAssetsArgs>(
    {
      name: "insert_assets",
      description:
        "把发现的资产写入全局资产图（跨任务共享的真值库）。只提交原始观察：归一化、去重、父子关系、" +
        "公司归属全部由程序处理。探索判断不写这里（用 record_fact）。上限 20 项/次。",
      promptSnippet: "登记发现的资产（域名/IP/服务/端点/应用）",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            maxItems: 20,
            description: "资产列表；每项 type ∈ root_domain|subdomain|ip|service|endpoint|app，字段按类型取用",
            items: { type: "object", additionalProperties: true },
          },
        },
        required: ["items"],
      },
      async run(args, c) {
        const assets = c.db.assets();
        const scope = c.db.taskScope();
        const results: { type: string; key: string; asset_id: number }[] = [];
        for (const item of args.items.slice(0, 20)) {
          let assetID = 0;
          let key = "";
          assetID = await assets.registerAgentAsset(c.taskID, c.workerName ?? c.role, c.intentID, c.toolCallID, async (store) => {
          switch (item.type) {
            case "root_domain":
              key = item.domain ?? "";
              assetID = await store.upsertRootDomain({ domain: key, icp: item.icp, taskID: c.taskID });
              break;
            case "subdomain":
              key = item.domain ?? "";
              assetID = await store.upsertSubdomain({
                domain: key,
                recordType: item.record_type,
                recordValue: item.record_value,
                icp: item.icp,
                taskID: c.taskID,
              });
              break;
            case "ip":
              key = item.ip ?? "";
              assetID = await store.upsertIP({
                ip: key,
                boundDomains: item.bound_domains,
                openPorts: (item.open_ports ?? []).map((p) => ({ port: p.port, service: p.service })),
                taskID: c.taskID,
              });
              break;
            case "service": {
              key = item.url ?? `${item.ip ?? item.domain ?? ""}:${item.port ?? 0}`;
              if (item.url && (!item.service_name || item.service_name.toLowerCase() === "http")) {
                assetID = await store.upsertHTTPService({
                  url: item.url,
                  technologies: item.technologies,
                  statusCode: item.status_code ?? null,
                  contentLength: item.content_length ?? null,
                  pageTitle: item.page_title,
                  auth: item.auth,
                  ip: item.ip,
                  taskID: c.taskID,
                });
              } else {
                assetID = await store.upsertOtherService({
                  domain: item.domain,
                  ip: item.ip,
                  port: item.port ?? 0,
                  serviceName: item.service_name ?? "unknown",
                  auth: item.auth,
                  taskID: c.taskID,
                });
              }
              break;
            }
            case "endpoint":
              key = `${item.method ?? "GET"} ${item.url ?? ""}`;
              assetID = await store.upsertEndpoint({
                url: item.url ?? "",
                method: item.method ?? "GET",
                params: item.params,
                ip: item.ip,
                taskID: c.taskID,
              });
              break;
            case "app":
              key = item.bundle_id || item.name || "";
              assetID = await store.upsertApp({
                name: item.name ?? "",
                bundleID: item.bundle_id,
                category: item.category,
                description: item.description,
                icp: item.icp,
                taskID: c.taskID,
              });
              break;
            default:
              throw new Error(`未知资产类型: ${String(item.type)}`);
          }
          return assetID;
          });
          // 保守范围：worker 显式插入的顶层资产自动纳入覆盖度分母。
          await scope.addAutoScope(c.taskID, item.type, item.domain ?? "", item.url ?? "", item.ip ?? "");
          results.push({ type: item.type, key, asset_id: assetID });
        }
        return { inserted: results.length, assets: results };
      },
    },
    ctx,
  );
}

interface ListAssetsArgs { type?: "root_domain" | "subdomain" | "ip" | "service" | "app" | "endpoint"; limit?: number; offset?: number; }

export function listAssetsTool(ctx: ToolRunContext) {
  return domainTool<ListAssetsArgs>(
    {
      name: "list_assets",
      description: "分页查询本任务或直接来源任务中仍获授权的资产（可按类型过滤）。返回轻量字段；来源任务只读。",
      promptSnippet: "查询本任务已授权资产",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["root_domain", "subdomain", "ip", "service", "app", "endpoint"] },
          limit: { type: "integer", description: "默认 20，上限 50" },
          offset: { type: "integer", description: "默认 0" },
        },
      },
      readOnly: true,
      async run(args, c) {
        const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
        if(c.taskID<=0)return {assets:[],offset:Math.max(0,args.offset??0),count:0};
        const offset=Math.max(0,args.offset??0),pending=['worker','mainagent'].includes(c.role);
        const assets=await c.db.query(`SELECT a.id,a.type,a.domain,a.ip,a.url,a.app_name,a.bundle_id,a.port,a.page_title,a.status_code
          FROM assets a
          WHERE ($2::text='' OR a.type=$2)
            AND EXISTS(SELECT 1 FROM task_asset_links l WHERE l.asset_id=a.id AND
              (l.task_id=$1 OR l.task_id IN (SELECT source_task_id FROM task_relations WHERE task_id=$1)))
            AND (task_asset_effective_approval_state($1,a.id)='approved' OR ($3 AND task_asset_effective_approval_state($1,a.id)='pending'))
          ORDER BY a.last_seen DESC,a.id DESC LIMIT $4 OFFSET $5`,[c.taskID,args.type??'',pending,limit,offset]);
        return {
          assets: assets.rows.map((a) => ({
            id: Number(a.id),
            type: String(a.type),
            host: a.domain || a.ip || a.url || a.app_name || a.bundle_id,
            port: a.port===null?null:Number(a.port),
            title: a.page_title,
            status: a.status_code===null?null:Number(a.status_code),
          })),
          offset,
          count: assets.rows.length,
        };
      },
    },
    ctx,
  );
}

interface ListUntestedArgs { type?: string; limit?: number; offset?: number; }

export function listUntestedAssetsTool(ctx: ToolRunContext) {
  return domainTool<ListUntestedArgs>(
    {
      name: "list_untested_assets",
      description:
        "列出本任务范围内（已授权、覆盖度分母内）尚未测过的资产——planner 发现未覆盖方向的直接输入。",
      promptSnippet: "列出范围内未测资产",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["root_domain", "subdomain", "ip", "service", "app", "endpoint"] },
          limit: { type: "integer", description: "默认 10，上限 30" },
          offset: { type: "integer" },
        },
      },
      readOnly: true,
      async run(args, c) {
        const limit = Math.min(Math.max(args.limit ?? 10, 1), 30);
        const { page, total } = await c.db.taskScope().listUntestedAssets(c.taskID, c.expID, args.type ?? "", limit, args.offset ?? 0);
        return { assets: page, total };
      },
    },
    ctx,
  );
}

interface AddTaskScopeArgs { kind: "root_domain" | "subdomain" | "ip" | "cidr" | "keyword"; value: string; reason?: string; }

export function addTaskScopeTool(ctx: ToolRunContext) {
  return domainTool<AddTaskScopeArgs>(
    {
      name: "add_task_scope",
      description:
        "把资产纳入本任务测试范围（覆盖度分母）。planner 判定某类资产该测但不在范围内时使用；" +
        "注意这只扩范围，不构成授权——资产授权由审批流程控制。",
      promptSnippet: "扩展任务测试范围",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["root_domain", "subdomain", "ip", "cidr", "keyword"] },
          value: { type: "string", description: "域名/IP/CIDR/关键词" },
          reason: { type: "string", description: "为什么纳入范围（可追溯）" },
        },
        required: ["kind", "value"],
      },
      async run(args, c) {
        await c.db.taskScope().addAgentScope(c.taskID, args.kind, args.value, args.reason ?? "", "agent");
        return { added: true, kind: args.kind, value: args.value };
      },
    },
    ctx,
  );
}
