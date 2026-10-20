import {assertActiveRole} from '../agent/retired-roles.js';
import {WorkerOperationJournal} from '../db/operation-journal.js';
import {journalTools} from '../pi/operation-tools.js';
import {contextNeedBoundary,CONTEXT_RETENTION_RULES} from './context-needs.js';
import {terminalExtension,TERMINAL_TOOLS} from '../pi/terminal.js';
import {interceptGate} from '../intercept/gate.js';
import { applyToolBindings, disabledBuiltinTools } from './tool-bindings.js';
export { applyToolBindings, disabledBuiltinTools } from './tool-bindings.js';
import { compactPlannerChanges, plannerRoundMessage, CONTEXT_LAYOUT_VERSION } from './prompt-context.js';
import {createTrackedRunner} from '../engine/runtime-config.js';
import {normalizeContract} from './intent-contract.js';
import {workerLaunchContext} from '../tools/context-read.js';
import {randomUUID} from 'node:crypto';
import {resolveGraphNode} from '../db/graph_view.js';
import {clampOutput} from '../tools/define.js';
import { customWorkerTools, shellEnvironmentNotes } from "../tools/custom.js";
import { roleResources } from "./resources.js";
// 四角色装配：把提示词 + 领域工具 + 预算/guard 接到 AgentRunner 上。
// 角色不感知引擎的调度细节，引擎不感知提示词内容——只经由本文件的四个入口函数交互。

import { mkdirSync } from "node:fs";
import path from "node:path";
import { AgentRunner, type RunnerActivity, type ToolGuard } from "../pi/runner.js";
import { createBashToolDefinition, type ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Database } from "../db/index.js";
import type { Node } from "../db/exploration.js";
import { runContext, type EngineHooks, type ToolRunContext, type TodoStore } from "../tools/context.js";
import { workerTools, plannerTools, mainTools, goalsTools } from "../tools/index.js";
import { buildGraphOverview, loadConstraints } from "../tools/index.js";
import { taskCredentials } from "../egress/credentials.js";
import {
  WORKER_WRAPUP, MAIN_WRAPUP, PLANNER_TASK_TIMEOUT_WRAPUP,
  systemRolePrompt, constraintBlock, hostProtocol,
} from "./prompts.js";

/** 技能根目录在启动时配置；角色资源和模型配置在每次会话创建时读取。 */
export interface AgentEnv {
  skillsDir?: string;
  caFile?: string;
}
let agentEnv: AgentEnv = {};
export function configureAgentEnv(env: AgentEnv): void {
  agentEnv = env;
}

/** agents 表的 per-agent 运行配置（pi 同步对接）：轮数/墙钟/专属 profile/收尾词覆盖。 */
export interface AgentRunConfig {
  maxTurns: number | null; // 0=不限；null=配置行缺失，使用调用方默认
  runSeconds: number | null; // 0=不限；null=配置行缺失
  wrapupPrompt: string; // ""=内置默认
  wrapupMaxTurns: number;
  llmProfileID: number; // 0=全局激活
}
export async function agentRunConfig(db: import("../db/index.js").Database, key: string): Promise<AgentRunConfig> {
  assertActiveRole(key);
  try {
    const r = await db.query(
      `SELECT enabled, max_turns, run_seconds, wrapup_prompt, wrapup_max_turns, COALESCE(llm_profile_id,0) llm_profile_id FROM agents WHERE key=$1`,
      [key],
    );
    const row = r.rows[0] as Record<string, unknown> | undefined;
    if (row?.["enabled"] === false) throw new Error(`角色 ${key} 已禁用`);
    if (!row) return { maxTurns: null, runSeconds: null, wrapupPrompt: "", wrapupMaxTurns: 0, llmProfileID: 0 };
    return {
      maxTurns: Number(row["max_turns"] ?? 0),
      runSeconds: Number(row["run_seconds"] ?? 0),
      wrapupPrompt: String(row["wrapup_prompt"] ?? ""),
      wrapupMaxTurns: Number(row["wrapup_max_turns"] ?? 0),
      llmProfileID: Number(row["llm_profile_id"] ?? 0),
    };
  } catch (error) { throw error; }
}

/** Preserve ARTEX/editor semantics: explicit zero disables that limit, not configuration. */
export function agentBudgets(config: Pick<AgentRunConfig,'maxTurns'|'runSeconds'>,defaults:{maxTurns:number;maxDurationMs:number}) {
  return {maxTurns:config.maxTurns??defaults.maxTurns,maxDurationMs:config.runSeconds===null?defaults.maxDurationMs:config.runSeconds*1000};
}

export interface ModelSource {
  modelPolicy?: Parameters<typeof AgentRunner.create>[0]["modelPolicy"];
  modelRuntime: ModelRuntime;
  model: Parameters<typeof AgentRunner.create>[0]["model"];
  thinkingLevel?: Parameters<typeof AgentRunner.create>[0]["thinkingLevel"];
  /** false buffers user-visible assistant deltas while keeping pi's native stream/tool loop. */
  streaming?: boolean;
}

/** 领域工具豁免 guard 的名单（写工具自行鉴权 / 只读无外联）。 */
const GUARD_SKIP_TOOLS = new Set([
  "tool_search",
  'context_search','context_get','steer_work','kill_work',
  "insert_assets", "record_fact", "report_finding", "add_intent", "dispatch_intents",
  "prove_goal", "set_goals", "set_constraints", "register_user_target", "add_task_scope",
  "graph_overview", "node_detail", "search_worker_traces", "get_worker_trace",
  "list_findings", "list_assets", "list_untested_assets", "todo_write",
]);

/** Closing reads existing evidence; it cannot launch commands, MCP or custom exploration. */
const WORKER_SETTLEMENT_TOOLS = [
  'record_fact','report_finding','insert_assets',
  'context_search','context_get','node_detail','list_facts','list_findings','list_assets',
  'read','read_tool_output','read_attachment','traffic_body','expand_index','expand_digest','shell_read','shell_close','shell_list',
];

/** 从工具参数正向提取 host（绝不解释裸 shell 命令文本——与 Go guard/assets 同一克制）。 */
function collectHosts(args: Record<string, unknown>): string[] {
  const hosts: string[] = [];
  for (const key of ["url", "host", "domain", "ip", "target", "endpoint"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim() !== "") hosts.push(v.trim());
  }
  return hosts;
}

export interface WorkerRunInput {
  signal?: AbortSignal;
  db: Database;
  taskID: number;
  expID: number;
  intent: Node;
  workerName: string;
  model: ModelSource;
  dataDir: string;
  maxTurns: number;
  maxDurationMs: number;
  hooks: EngineHooks;
  /** Drain messages received before the native runner was ready. */
  onActivity: (activity: RunnerActivity, meta: { intentID: number; worker: string }) => void;
  /** 引擎注入的额外 guard（审批门 M5 接入；测试用桩）。 */
  extraGuard?: ToolGuard;
  /**
   * 出口网关地址（host:port，M6）。给出时 worker 的 bash 工具进程注入
   * HTTP_PROXY/HTTPS_PROXY（值为带签名任务凭据的网关 URL）+ NO_PROXY 本机回环，
   * 网关侧做 CONNECT 级 allowlist 授权（网络层兜底，替代已删除的 MITM 录制）。
   */
  egressAddr?: string;
  egressScope?: string;
  wrapupPromptOverride?: string;
  /** Host cancellation only; domain Agents never exchange messages. */
  onRunner?: (runner: { abort(): Promise<void>;steer(message:string):Promise<void> }) => void | Promise<void>;
}

/** worker 会话文件：确定性键，断点续跑身份（Go: WorkerSessionID）。 */
export function workerSessionFile(dataDir: string, expID: number, intentID: number): string {
  return path.join(dataDir, "sessions", `exp${expID}-worker-i${intentID}.jsonl`);
}
export function mainSessionFile(dataDir: string, expID: number, segment = 0): string {
  return path.join(dataDir, "sessions", segment === 0 ? `exp${expID}-main.jsonl` : `exp${expID}-main-${segment}.jsonl`);
}

export interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface WorkerRunResult {
  aborted: boolean;
  stopReason?: "completed" | "aborted" | "budget";
  budgetReason?: 'turn_limit' | 'duration_limit';
  failure?: string;
  lastAssistantText: string | undefined;
  usage: RunUsage;
}
/** 包装 onActivity：累计 usage 事件（每 run 一份）。 */
function withUsageCounter(
  onActivity: (a: import("../pi/runner.js").RunnerActivity, meta: { intentID?: number; worker: string }) => void,
): { wrapped: (a: import("../pi/runner.js").RunnerActivity, meta: { intentID?: number; worker: string }) => void; usage: () => RunUsage } {
  const total: RunUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    usage: () => total,
    wrapped: (a, meta) => {
      if (a.kind === "usage") {
        total.input += a.input;
        total.output += a.output;
        total.cacheRead += a.cacheRead;
        total.cacheWrite += a.cacheWrite;
      }
      onActivity(a, meta);
    },
  };
}

/**
 * 出口网关环境注入（M6）：pi 的 bash 工具支持 spawnHook 改写子进程 env
 * （createBashToolDefinition / BashToolOptions.spawnHook，返回的 {command,cwd,env}
 * 直接作为 spawn env），customTools 里与内置同名的工具会覆盖内置 bash——因此这里
 * 用自定义 bash 实例（名字保持 "bash"）注入：
 *   HTTP_PROXY / HTTPS_PROXY = http://<series-task 凭据>@<egressAddr>/
 *   NO_PROXY = localhost,127.0.0.1
 * 凭据由进程内 HMAC 签名（taskCredentials），网关验签后按任务 scope 授权；
 * shell 能看到凭据但改 taskID/scope 后签名失效，无法借用其他任务的策略。
 * 未配置 egressAddr 时返回 undefined，保持内置 bash 原样。
 */
export function executionEnvironment(egressAddr:string|undefined,taskID:number,scope:string):Record<string,string>{
  const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));
  if(!egressAddr)return env;
  const creds=taskCredentials(taskID,scope);if(!creds)return env;
  const proxy=`http://${encodeURIComponent(creds.username)}:${encodeURIComponent(creds.password)}@${egressAddr}/`;
  return {...env,...(agentEnv.caFile?{NODE_EXTRA_CA_CERTS:agentEnv.caFile,SSL_CERT_FILE:agentEnv.caFile,REQUESTS_CA_BUNDLE:agentEnv.caFile,CURL_CA_BUNDLE:agentEnv.caFile}:{}),HTTP_PROXY:proxy,HTTPS_PROXY:proxy,http_proxy:proxy,https_proxy:proxy,NO_PROXY:'localhost,127.0.0.1',no_proxy:'localhost,127.0.0.1'};
}
export function workerEgressBashTool(runDir:string,egressAddr:string|undefined,taskID:number,intentID:number,scope?:string):ToolDefinition|undefined{
  if(!egressAddr)return undefined;
  return createBashToolDefinition(runDir,{spawnHook:ctx=>({...ctx,env:{...ctx.env,...executionEnvironment(egressAddr,taskID,scope??`worker:${intentID}`)}})}) as unknown as ToolDefinition;
}
async function executionTools(ctx:ToolRunContext,cwd:string,input:{egressAddr?:string;egressScope?:string;signal?:AbortSignal;extraGuard?:ToolGuard}){
  const env=executionEnvironment(input.egressAddr,ctx.taskID,input.egressScope??`${ctx.role}:${ctx.intentID??0}`);
  const bash=createBashToolDefinition(cwd,{spawnHook:spawn=>({...spawn,env:{...spawn.env,...env}})}) as unknown as ToolDefinition;
  const notes=await shellEnvironmentNotes(ctx);if(notes)bash.description+=`\n可用命令环境：\n${notes}`;
  const interactive=(await ctx.db.platform().getAgentByKey(ctx.role))?.interactiveShell===true;
  if(interactive)bash.description+='\n需要持续交互时用 shell_open，后续 shell_send/read/close/list；句柄仅属于当前执行会话。';
  return {tools:[bash,...await customWorkerTools(ctx,cwd,bash,input.extraGuard??interceptGate(ctx.db,{taskID:ctx.taskID,agentName:ctx.role}))],
    names:interactive?TERMINAL_TOOLS:[],extensions:interactive?[terminalExtension(cwd,env,input.signal)]:[]};
}
/** Main and Planner use the same authorization/approval boundary as Worker. */
function roleExecutionGuard(ctx:ToolRunContext,extra?:ToolGuard):ToolGuard{
  let probes=0;
  return async g=>{
    await ctx.hooks.assertOwnership?.(ctx.db);
    const decision=await (extra??interceptGate(ctx.db,{taskID:ctx.taskID,agentName:ctx.role}))(g);if(decision?.block)return decision;
    if(GUARD_SKIP_TOOLS.has(g.toolName)||['read','read_tool_output','read_attachment','traffic_body','shell_read','shell_list','shell_close'].includes(g.toolName))return;
    const task=await ctx.db.tasks().getTask(ctx.taskID);
    if(!task||task.paused||task.queued||['done','failed','timeout','stopped'].includes(task.status))return {block:true,reason:'任务已暂停或结束，不能执行新操作'};
    if(ctx.role==='planner'){
      if(probes>=3)return {block:true,reason:'Planner 每轮最多三次开局探测；实际测试请派给 Worker'};
      probes++;
      if((await ctx.db.query("SELECT 1 FROM exploration_nodes WHERE exploration_id=$1 AND kind IN ('fact','finding') AND payload ? 'from_intent' AND state='confirmed' LIMIT 1",[ctx.expID])).rowCount)return {block:true,reason:'Planner 开局探测已结束；实际测试请通过 add_intent 派给 Worker'};
    }
    try{
      for(const host of collectHosts(g.args)){
        const url=new URL(host.includes('://')?host:`http://${host}`),port=Number(g.args.port)||Number(url.port)||(url.protocol==='https:'?443:80);
        if(ctx.role==='mainagent')await ctx.db.taskScope().validateWorkerHostPort(ctx.taskID,url.hostname,port);
        else await ctx.db.taskScope().validateTaskHostPort(ctx.taskID,url.hostname,port);
      }
    }catch(e){return {block:true,reason:`任务资产策略：${e instanceof Error?e.message:String(e)}`};}
  };
}

export async function runWorkerIntent(input: WorkerRunInput): Promise<WorkerRunResult> {
  const { db, taskID, expID, workerName, model, dataDir } = input;
  const intent = await db.exploration(expID).getNode(input.intent.id);
  if(!intent||intent.state!=='running'||intent.owner!==workerName||intent.payload.cancelled_by_user)throw new Error('当前 Worker 不再持有运行中的意图');
  if (intent.payload.execution_result) return {aborted:false,stopReason:'completed',lastAssistantText:String((intent.payload.execution_result as Record<string,unknown>).summary??''),usage:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const contract = normalizeContract(intent.payload.contract,String(intent.payload.summary??''));
  const runDir = path.join(dataDir, "tasks", String(taskID), `i${intent.id}`);
  mkdirSync(runDir, { recursive: true });

  const ctx: ToolRunContext = runContext(db, taskID, expID, "worker", {
    workerName,
    intentID: intent.id,
    hooks: input.hooks,
  });
  const tools = await applyToolBindings(db, "worker", workerTools(ctx));
  const disabledBuiltin = await disabledBuiltinTools(db);
  const rc = await agentRunConfig(db, "worker");

  // Keep role/Skill/tool prefixes stable. The host supplies the immutable mandate
  // at every request boundary, including after compaction and session recovery.
  const anchored = await db.exploration(expID).anchorAssetIDs(intent.id);
  const assets = anchored.length > 0 ? await db.assets().getByIDs(anchored) : [];
  const assetsJSON=clampOutput(JSON.stringify({total:assets.length,items:assets.slice(0,20).map(a=>({id:a.id,type:a.type,host:a.domain||a.ip||a.url||a.app_name})),detail_tool:'list_assets'}));
  const system = await systemRolePrompt(db, "worker");
  const taskContext =
    `\n\n【当前意图 #${intent.id} 执行约定】\n${JSON.stringify(contract)}` +
    `\n\n【锚定资产索引；访问仍须当前授权】\n${assetsJSON}`;

  // 首条 user：全局态势（可降级，刻意不含 coverage）。
  const overview = await workerLaunchContext(ctx,intent.id);
  const firstUser =
    `【意图相关上下文摘要（完整节点按引用查询）】\n${clampOutput(JSON.stringify(overview))}\n\n` +
    `开始执行你的意图 #${intent.id}。`;

  // The native session owns progress persistence; writes go straight to the graph.
  const counter = withUsageCounter(input.onActivity as (a: RunnerActivity, meta: { intentID?: number; worker: string }) => void);
  const {maxTurns,maxDurationMs} = agentBudgets(rc,{maxTurns:input.maxTurns,maxDurationMs:input.maxDurationMs});
  const sessionPath = workerSessionFile(dataDir, expID, intent.id);
  // 出口网关注入的 bash（名字保持 "bash"，customTools 同名覆盖内置；allowlist 不变）。
  const execution=await executionTools(ctx,runDir,input);
  tools.push(...execution.tools);
  const journal=new WorkerOperationJournal(ctx);
  await journal.start();
  const runner = await createTrackedRunner(db,taskID,"worker",{
    wrapExecutionTool:journalTools(journal,ctx,new Set(['bash','write','edit','http_request','shell_open','shell_send',...execution.tools.map(t=>t.name)])),
    stopOnRecoveryBlock:()=>journal.recoveryBlocked,
    contextLayout: CONTEXT_LAYOUT_VERSION,
    taskContext,
    reserveSettlementTurns: 2,
    boundaryContext: async()=>constraintBlock(await loadConstraints(db,expID))+'\n'+await contextNeedBoundary(ctx),
    compactionInstructions:CONTEXT_RETENTION_RULES,
    loadDomainState:async()=>({context_needs:await contextNeedBoundary(ctx)}),
    intentID:intent.id,
    cwd: runDir,
    agentDir: path.join(dataDir, "pi-agent"),
    modelRuntime: model.modelRuntime,
    modelPolicy: model.modelPolicy,
    model: model.model,
    thinkingLevel: model.thinkingLevel,
    streaming: model.streaming,
    systemPrompt: system+'\n\n'+CONTEXT_RETENTION_RULES,
    customTools: tools,
    extensionFactories:execution.extensions,
    ...await roleResources(db, "worker", agentEnv.skillsDir),
    signal: input.signal, maxTurns, maxDurationMs,
    toolAllowlist: ["read", "write", "edit", "bash", "mcp__*",...execution.names, ...tools.map((t) => t.name)].filter((n) => !disabledBuiltin.has(n)),
    resumeSessionPath: sessionPath,
    wrapup: async ({reason}) => {
      // Natural completion ends immediately, including runs with no new observations.
      if (reason === 'settled') return undefined;
      return { prompt: input.wrapupPromptOverride ?? (rc.wrapupPrompt || WORKER_WRAPUP) };
    },
    maxWrapupTurns: rc.wrapupMaxTurns || 2,
    settlementTools: WORKER_SETTLEMENT_TOOLS,
    guard: async (g) => {
      const current = await db.exploration(expID).getNode(intent.id);
      if (!current || current.state !== 'running' || current.owner!==workerName || current.payload.cancelled_by_user) return {block:true,reason:'当前意图已停止或归属已改变，禁止继续执行'};
      if (current.payload.execution_result) return {block:true,reason:'结果已提交，请结束当前会话'};
      if (contract.allowed_tools && !GUARD_SKIP_TOOLS.has(g.toolName) && !['read_tool_output','read_attachment','traffic_body','expand_index','expand_digest','list_facts'].includes(g.toolName) && !contract.allowed_tools.includes(g.toolName)) return {block:true,reason:'工具不在当前意图 allowed_tools 内'};
      // 2) 审批门（M5 接 intercept；extraGuard 优先）。
      if (input.extraGuard) {
        const d = await input.extraGuard(g);
        if (d?.block) return d;
      }
      // 3) 资产策略：领域工具豁免（自行鉴权/只读）；其余按参数 host 校验。
      if (GUARD_SKIP_TOOLS.has(g.toolName)) return undefined;
      for(const ref of contract.basis){
        try{
          const source=await resolveGraphNode(db,taskID,expID,ref.node_id,true);
          if(source.node.content_version!==ref.version)return {block:true,reason:'当前意图依据已变化，停止新探测，写回已有观察并总结未完成原因，交 Planner 重新评估'};
        }catch{return {block:true,reason:'当前意图依据不再授权，停止访问相关资源并总结阻塞原因，交 Planner 重新评估'};}
      }
      const hosts = collectHosts(g.args);
      if (hosts.length === 0) return undefined;
      try {
        const liveIntent=await db.exploration(expID).getNode(intent.id);
        await db.taskScope().validateIntentHosts(taskID, liveIntent, hosts);
        for(const target of hosts){
          let parsed:URL;try{parsed=new URL(target.includes('://')?target:`http://${target}`);}catch{continue;}
          const port=Number(g.args.port)||Number(parsed.port)||(parsed.protocol==='https:'?443:80);
          if(target.includes('://')||parsed.port||g.args.port)await db.taskScope().validateIntentHostPort(taskID,liveIntent,parsed.hostname,port);
        }
        return undefined;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await db.taskScope().rememberTaskAssetDenials(taskID, hosts, []).catch(() => undefined);
        return {
          block: true,
          reason: `任务资产策略：${msg}。跳过本项资源，继续其他已授权测试，不要重试该地址。`,
        };
      }
    },
    onActivity: (a) => counter.wrapped(a, { intentID: intent.id, worker: workerName }),
  });
  try {
    ctx.sessionEntries=()=>runner.sessionEntries;
    await input.onRunner?.({ abort: () => runner.abort(),steer:async message=>{await runner.steer(message);} });
    const res = await runner.prompt(firstUser);
    return { ...res, usage: counter.usage() };
  } catch (error) {
    // Preserve already-metered usage and domain writes on provider/compaction failures.
    return {aborted:input.signal?.aborted===true,stopReason:input.signal?.aborted?'aborted':undefined,
      lastAssistantText:undefined,failure:error instanceof Error?error.message:String(error),usage:counter.usage()};
  } finally { await runner.dispose(); }
}

export interface PlannerRoundInput {
  egressAddr?:string;egressScope?:string;extraGuard?:ToolGuard;
  dispatchCapacity?: number;
  planningRoundID?:string;
  changes?:unknown[];
  events?:unknown[];
  terminalOnly?: boolean;
  signal?: AbortSignal;
  db: Database;
  taskID: number;
  expID: number;
  goal: string;
  model: ModelSource;
  dataDir: string;
  todos: TodoStore;
  hooks: EngineHooks;
  /** 本轮触发事件的可读渲染（worker 完成/报洞/目标变更…）。 */
  triggersText: string;
  maxTurns: number;
  wrapupPromptOverride?: string;
  onActivity: (activity: RunnerActivity, meta: { worker: string }) => void;
}

export interface PlannerRoundResult {
  aborted: boolean;
  stopReason?: "completed" | "aborted" | "budget";
  lastAssistantText: string | undefined;
  usage: RunUsage;
}

/** planner 每轮全新内存会话（无状态），todolist 由 TodoStore 跨轮共享。 */
export async function runPlannerRound(input: PlannerRoundInput): Promise<PlannerRoundResult> {
  const { db, taskID, expID, goal, model, dataDir, todos } = input;
  const planningRoundID=input.planningRoundID??randomUUID();
  const ctx: ToolRunContext = runContext(db, taskID, expID, "planner", { todos, hooks: input.hooks,planningRoundID });
  const tools = await applyToolBindings(db, "planner", plannerTools(ctx).filter((t) => !input.terminalOnly || !["add_intent", "add_task_scope", "steer_work", "kill_work"].includes(t.name)));
  const disabled = await disabledBuiltinTools(db, "planner");
  const prc = await agentRunConfig(db, "planner");
  const plannerBudget = agentBudgets(prc,{maxTurns:input.maxTurns,maxDurationMs:120_000});
  // A task already past its deadline only permits the host's bounded final review.
  if(input.terminalOnly){
    plannerBudget.maxTurns=plannerBudget.maxTurns>0?Math.min(plannerBudget.maxTurns,input.maxTurns):input.maxTurns;
    plannerBudget.maxDurationMs=plannerBudget.maxDurationMs>0?Math.min(plannerBudget.maxDurationMs,120_000):120_000;
  }
  const system = await systemRolePrompt(db, "planner", { Goal: goal }, input.terminalOnly, input.terminalOnly ? input.wrapupPromptOverride : undefined);

  const overview = await buildGraphOverview(ctx);
  // Todos are included once in their complete bounded block below.
  delete overview.todos;
  const changes = compactPlannerChanges(input.changes ?? [], overview, taskID);
  const firstUser = plannerRoundMessage(overview,todos.get(expID),changes,input.events??[],input.triggersText);

  const workDir = path.join(dataDir, "tasks", String(taskID));
  mkdirSync(workDir, { recursive: true });
  const execution=await executionTools(ctx,workDir,input);
  if(!input.terminalOnly)tools.push(...execution.tools);
  let turns = 0;
  const plannerCounter = withUsageCounter(input.onActivity);
  const runner = await createTrackedRunner(db,taskID,"planner",{
    contextLayout: CONTEXT_LAYOUT_VERSION,
    cwd: workDir,
    extensionFactories:input.terminalOnly?[]:execution.extensions,
    guard:roleExecutionGuard(ctx,input.extraGuard),
    settlementTools:[...GUARD_SKIP_TOOLS,"read","read_tool_output","read_attachment","traffic_body","shell_read","shell_list","shell_close"],
    boundaryContext:async()=>constraintBlock(await loadConstraints(db,expID))+'\n'+await contextNeedBoundary(ctx),
    agentDir: path.join(dataDir, "pi-agent"),
    modelRuntime: model.modelRuntime,
    modelPolicy: model.modelPolicy,
    model: model.model,
    thinkingLevel: model.thinkingLevel,
    streaming: model.streaming,
    systemPrompt: system+'\n\n'+CONTEXT_RETENTION_RULES,
    customTools: tools,
    ...await roleResources(db, "planner", agentEnv.skillsDir),
    signal: input.signal, ...plannerBudget,
    toolAllowlist: ["read",...(!input.terminalOnly?["write","edit","bash","mcp__*",...execution.names]:[]), ...tools.map((t) => t.name)].filter((name) => !disabled.has(name)),
    inMemory: true,
    compactionInstructions:CONTEXT_RETENTION_RULES,
    wrapup: ({reason}) => reason==='settled'?undefined:{prompt:input.wrapupPromptOverride??(input.terminalOnly?PLANNER_TASK_TIMEOUT_WRAPUP:prc.wrapupPrompt||'预算将尽，停止新探测，保存已确定的规划并简述结果。')},
    maxWrapupTurns: prc.wrapupMaxTurns || 1,
    onRawEvent: (ev) => {
      if (ev.type === "turn_end") turns++;
    },
    onActivity: (a) => plannerCounter.wrapped(a, { worker: "planner" }),
  });
  try {
    ctx.sessionEntries=()=>runner.sessionEntries;
    const res = await runner.prompt(firstUser);
    return { ...res, usage: plannerCounter.usage() };
  } finally { await runner.dispose(); }
}

export interface MainChatInput {
  egressAddr?:string;egressScope?:string;extraGuard?:ToolGuard;
  images?: import("../evidence/attachments.js").ChatImage[];
  signal?: AbortSignal;
  segment?: number;
  db: Database;
  taskID: number;
  expID: number;
  goal: string;
  model: ModelSource;
  dataDir: string;
  hooks: EngineHooks;
  message: string;
  maxTurns: number;
  onActivity: (activity: RunnerActivity, meta: { worker: string }) => void;
}

/** mainagent：可恢复文件会话（exp<id>-main），人的每条消息驱动一轮。 */
export async function runMainChat(input: MainChatInput): Promise<WorkerRunResult> {
  const { db, taskID, expID, goal, model, dataDir } = input;
  const receipts:unknown[]=[];
  const hooks:EngineHooks={...input.hooks,dispatchIntent:input.hooks.dispatchIntent?async(exp,id)=>{const receipt=await input.hooks.dispatchIntent!(exp,id);receipts.push(receipt??{intent_id:id,status:'submitted'});return receipt;}:undefined};
  const ctx: ToolRunContext = runContext(db, taskID, expID, "mainagent", { hooks,mainSegment:input.segment??0,userMessage:input.message });
  const tools = await applyToolBindings(db, "mainagent", mainTools(ctx));
  const disabled = await disabledBuiltinTools(db, "mainagent");
  const system = await systemRolePrompt(db, "mainagent", { Goal: goal });
  const workDir = path.join(dataDir, "tasks", String(taskID));
  mkdirSync(workDir, { recursive: true });
  const sessionPath = mainSessionFile(dataDir, expID, input.segment);
  const mainCounter = withUsageCounter(input.onActivity);
  const rc = await agentRunConfig(db, "mainagent");
  const execution=await executionTools(ctx,workDir,input);
  tools.push(...execution.tools);
  const runner = await createTrackedRunner(db,taskID,"mainagent",{
    stopWhen:async()=>receipts.length>0,
    guard:roleExecutionGuard(ctx,input.extraGuard),
    extensionFactories:execution.extensions,
    boundaryContext:async()=>hostProtocol("mainagent")+constraintBlock(await loadConstraints(db,expID)),
    settlementTools:[...GUARD_SKIP_TOOLS,"read","read_tool_output","read_attachment","traffic_body","shell_read","shell_list","shell_close"],
    cwd: workDir,
    agentDir: path.join(dataDir, "pi-agent"),
    modelRuntime: model.modelRuntime,
    modelPolicy: model.modelPolicy,
    model: model.model,
    thinkingLevel: model.thinkingLevel,
    streaming: model.streaming,
    systemPrompt: system,
    customTools: tools,
    ...await roleResources(db, "mainagent", agentEnv.skillsDir),
    signal: input.signal, ...agentBudgets(rc,{maxTurns:input.maxTurns,maxDurationMs:120_000}),
    toolAllowlist: ["read","write","edit","bash","mcp__*",...execution.names, ...tools.map((t) => t.name)].filter((name) => !disabled.has(name)),
    resumeSessionPath: sessionPath,
    sessionDir: path.join(dataDir, "sessions"),
    wrapup: ({reason}) => (reason !== 'settled' ? { prompt: rc.wrapupPrompt || MAIN_WRAPUP } : undefined),
    maxWrapupTurns: rc.wrapupMaxTurns || 1,
    onActivity: (a) => mainCounter.wrapped(a, { worker: "main" }),
  });
  try {
    const feedback=(await db.query("SELECT a.id,a.node_id,a.detail,a.summary,a.metadata FROM activity a WHERE a.exploration_id=$1 AND a.main_seg=$2 AND a.metadata ? 'worker_feedback' AND CASE WHEN a.node_id IS NOT NULL THEN exploration_node_readable(a.exploration_id,a.node_id,true) WHEN (a.metadata->'worker_feedback'->>'intent_id') ~ '^[0-9]+$' THEN exploration_node_readable(a.exploration_id,(a.metadata->'worker_feedback'->>'intent_id')::bigint,true) ELSE false END ORDER BY a.id DESC LIMIT 20",[expID,input.segment??0])).rows.reverse();
    for(const entry of feedback)await runner.appendContextOnce(`worker-feedback:${entry.id}`,`【Worker 回传摘要，完整结果按 node:${entry.node_id??(entry.metadata as {worker_feedback?:{intent_id?:number}})?.worker_feedback?.intent_id??"未知"} 的 output 视图续读】\n${Array.from(String(entry.detail??entry.summary)).slice(0,180).join('')}`);
    const res = await runner.prompt(input.message,input.images);
    if(receipts.length){
      const text=`已提交工作：${JSON.stringify(receipts)}。后续结果将回传本会话。`;
      await runner.appendContextOnce(`dispatch-receipt:${randomUUID()}`,text);
      input.onActivity({kind:'assistant_message_end',text,final:true},{worker:'main'});
      return {...res,aborted:false,stopReason:'completed',lastAssistantText:text,usage:mainCounter.usage()};
    }
    return { ...res, usage: mainCounter.usage() };
  } finally { await runner.dispose(); }
}

export interface GoalsRunInput {
  hooks?: EngineHooks;
  onActivity?: (activity: RunnerActivity, meta: {worker:string})=>void;
  signal?: AbortSignal;
  db: Database;
  taskID: number;
  expID: number;
  model: ModelSource;
  dataDir: string;
  description: string;
  maxTurns?: number;
}

/** goals：任务创建时的一次性目标分解；内存会话，仅缺少目标提交时提醒保存。 */
export async function runGoalsDecompose(input: GoalsRunInput): Promise<WorkerRunResult> {
  const { db, taskID, expID, model, dataDir } = input;
  const goalCounter=withUsageCounter(input.onActivity??(()=>{}));
  const gc=await agentRunConfig(db, "goals"),disabled=await disabledBuiltinTools(db,"goals");
  const ctx: ToolRunContext = runContext(db, taskID, expID, "goals", {hooks:input.hooks??{}});
  const tools = await applyToolBindings(db, "goals", goalsTools(ctx));
  if(!tools.some(t=>t.name==='set_goals'))throw new Error('Goals 的 set_goals 已禁用，无法提交目标');
  const system = await systemRolePrompt(db, "goals");
  const workDir = path.join(dataDir, "tasks", String(taskID));
  mkdirSync(workDir, { recursive: true });
  let turns = 0;
  let goalsSaved = false;
  const runner = await createTrackedRunner(db,taskID,"goals",{
    stopWhen:async()=>goalsSaved,
    cwd: workDir,
    agentDir: path.join(dataDir, "pi-agent"),
    modelRuntime: model.modelRuntime,
    modelPolicy: model.modelPolicy,
    model: model.model,
    thinkingLevel: model.thinkingLevel,
    streaming: model.streaming,
    systemPrompt: system,
    customTools: tools,
    ...await roleResources(db,"goals",agentEnv.skillsDir),
    toolAllowlist: ['read',...tools.map((t) => t.name)].filter(name=>!disabled.has(name)),
    signal: input.signal, ...agentBudgets(gc,{maxTurns:input.maxTurns??8,maxDurationMs:120_000}),
    inMemory: true,
    wrapup: () => goalsSaved ? undefined : {prompt:gc.wrapupPrompt||hostProtocol('goals')},
    maxWrapupTurns: gc.wrapupMaxTurns||1,
    onActivity:a=>{if(a.kind==='tool_end'&&a.toolName==='set_goals'&&!a.isError)goalsSaved=true;goalCounter.wrapped(a,{worker:"goals"});},
    onRawEvent: (ev) => {
      if (ev.type === "turn_end") turns++;
    },
  });
  try {
  const taskGoal = (await db.tasks().getTask(taskID))?.goal ?? input.description;
  const res = await runner.prompt(`【任务目标】\n${taskGoal}\n\n【任务描述】\n${input.description}\n\n请先抽取操作约束（如有），再分解目标并调用 set_goals 提交。`);
  if(!res.aborted&&!goalsSaved)throw new Error('Goals 未保存可验收目标');
  return { ...res, usage: goalCounter.usage() };
  } finally { await runner.dispose(); }
}
