import { randomUUID } from "node:crypto";
import { mkdirSync } from 'node:fs';
import path from 'node:path';
/**
 * pi SDK 适配层骨架（M2 spike 结论的落地形态）。
 *
 * 基于 @earendil-works/pi-coding-agent 1.3.0 的真实 API 面（详见 src/pi/spike.ts 的验证结论）：
 * - 会话：createAgentSession({ model, modelRuntime, sessionManager, settingsManager, resourceLoader,
 *   tools, customTools, cwd, agentDir })
 * - guard：注入 InlineExtension，监听扩展事件 `tool_call`，返回 { block, reason } 阻断（等价于
 *   pi-agent-core Agent.beforeToolCall，但带会话/扩展上下文，spike T4 已验证）
 * - wrapup：InlineExtension 监听 `agent_before_settle`，返回 { continue: true, entries: [...] }
 *   注入收尾提示并续跑一轮（spike T5 已验证；预算封顶由本层计数保证）
 * - resume：SessionManager.open(path) 恢复 JSONL 会话继续对话（spike T6 已验证）
 * - steer/abort：session.steer() / session.abort()（spike T7/T7b 已验证）
 *
 * 注意：pi-ai 是 pi-coding-agent 的传递依赖（pnpm 严格模式不可直接 import），因此模型对象
 * 类型从 pi-coding-agent 的导出反向推导。生产化时建议将 @earendil-works/pi-ai 提为直接依赖。
 */

import {
	createAgentSession,
	createMcpExtension,
	DefaultResourceLoader,
	loadSkillsFromDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentBeforeSettleEventResult,
	type AgentSession,
	type AgentSessionEvent,
	type CreateAgentSessionOptions,
	type ExtensionFactory,
	type ToolCallEventResult,
	type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

/** 会话模型对象（等价 pi-ai 的 Model<Api>） */
export type PiModel = NonNullable<CreateAgentSessionOptions['model']>;
/** 思考级别（等价 pi-agent-core 的 ThinkingLevel） */
export type PiThinkingLevel = Extract<AgentSessionEvent, { type: 'thinking_level_changed' }>['level'];

/** 工具门控决定：block=true 时工具不执行，reason 会作为错误工具结果返回给模型 */
export interface ToolGuardDecision {
	block: boolean;
	reason?: string;
}

/** 一次工具调用的门控上下文 */
export interface ToolGuardContext {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
}

/** 外部 guard：每次工具调用前询问（同步或异步） */
export type ToolGuard = (ctx: ToolGuardContext) => ToolGuardDecision | undefined | Promise<ToolGuardDecision | undefined>;

/** wrapup 决定：预算到点时给出收尾提示，本层注入并只允许有限轮收尾 */
export interface WrapupDecision {
	/** 注入给模型的收尾提示（作为 custom_message 进入上下文） */
	prompt: string;
}

/** 外部预算函数：每次 agent 即将 settle 时询问。返回 undefined 表示正常运行结束 */
export type WrapupBudget = () => WrapupDecision | undefined | Promise<WrapupDecision | undefined>;

/** 归一化后的 activity 事件（对接 Go/norma 的 activity 流） */
export type RunnerActivity =
	| { kind: 'assistant_delta'; text: string; streamID: string; isThinking?: boolean }
	| { kind: 'assistant_message_end'; text: string; streamID?: string; isThinking?: boolean }
	| { kind: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
	| { kind: 'tool_end'; toolCallId: string; toolName: string; isError: boolean; durationMs?: number; text?: string }
	| { kind: 'settled'; aborted: boolean }
	| { kind: 'usage'; input: number; output: number; cacheRead: number; cacheWrite: number }
	| { kind: 'queue_update'; steering: readonly string[]; followUp: readonly string[] };

export interface AgentRunnerOptions {
	signal?: AbortSignal;
	maxTurns?: number;
	maxDurationMs?: number;
	allowedSkills?: string[];
	/** 工作目录（项目本地发现 + 会话默认目录基准） */
	cwd: string;
	/** pi 全局配置目录（auth.json / models.json 所在；建议每实例独立临时目录或服务级共享目录） */
	agentDir: string;
	/** 会话目录（文件会话存放处；缺省用 pi 默认） */
	sessionDir?: string;
	/** 已注入 provider 的模型运行时（服务启动时构造一次，多个 runner 复用） */
	modelRuntime: ModelRuntime;
	/** 模型对象 */
	model: PiModel;
	thinkingLevel?: PiThinkingLevel;
	/** 系统 prompt（服务端全权控制） */
	systemPrompt?: string;
	/** 允许启用的工具名（内置 + customTools；缺省 ['read','bash','edit','write']） */
	toolAllowlist?: string[];
	/** 服务端自定义工具 */
	customTools?: ToolDefinition[];
	/** 工具门控（等价 norma 的 guard） */
	guard?: ToolGuard;
	/** 收尾预算（等价 norma 的 settlement wrapup） */
	wrapup?: WrapupBudget;
	/** wrapup 最大续跑轮数（防止预算函数一直返回续跑导致死循环） */
	maxWrapupTurns?: number;
	/** 恢复既有会话文件（JSONL 路径）；给出时忽略 sessionDir 的新建语义 */
	resumeSessionPath?: string;
	/** 内存会话（不落盘）：planner 每轮无状态、goals 一次性 run 用 */
	inMemory?: boolean;
	/** skills 根目录（SKILL.md 发现目录）；给出时注入会话技能（agentskills 渐进披露） */
	skillsDir?: string;
	/** MCP 服务器配置（DB mcp_servers 映射）；非空时挂 pi 的 MCP 扩展 */
	mcpEntries?: Array<{ name: string; config: Record<string, unknown> }>;
	/** 原始 AgentSessionEvent 透传（调试 / 持久化用） */
	onRawEvent?: (event: AgentSessionEvent) => void;
	/** 归一化 activity 流（对接 Go 侧 activity 映射） */
	onActivity?: (activity: RunnerActivity) => void;
}

export interface RunResult {
	/** settled 时是否被 abort */
	aborted: boolean;
	/** 最后一条助手文本（若有） */
	lastAssistantText: string | undefined;
	stopReason?: "completed" | "aborted" | "budget";
}

/**
 * 单个 agent 运行器：封装「构造 session → 订阅事件 → guard/wrapup 门控 → resume/abort」。
 * 一个 runner 对应一个会话（内存或文件），不可跨会话复用；多会话由上层池化管理。
 */
export class AgentRunner {
	private readonly session: AgentSession;
	private readonly opts: AgentRunnerOptions;
	private turns = 0;
	private streamID = randomUUID();
	private budgetExceeded = false;
	private modelError: string | undefined;
	private settled!: (result: RunResult) => void;
	private settledPromise!: Promise<RunResult>;

	private constructor(session: AgentSession, opts: AgentRunnerOptions) {
		this.session = session;
		this.opts = opts;
		this.resetSettled();
		this.session.subscribe((event) => this.handleEvent(event));
	}

	private resetSettled(): void {
		this.settledPromise = new Promise<RunResult>((resolve) => {
			this.settled = resolve;
		});
	}

	// -------------------------------------------------------------------------
	// 构造
	// -------------------------------------------------------------------------

	static async create(opts: AgentRunnerOptions): Promise<AgentRunner> {
		const settings = SettingsManager.inMemory({
			// 服务端自管重试/压缩策略：先关闭，避免与 Go 侧调度冲突
			retry: { enabled: false },
			compaction: { enabled: true },
		});

		const guardExtension: ExtensionFactory | undefined = opts.guard
			? (pi) => {
					pi.on('tool_call', async (event): Promise<ToolCallEventResult | undefined> => {
						const decision = await opts.guard?.({
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: event.input as Record<string, unknown>,
						});
						if (!decision?.block) return undefined;
						return { block: true, reason: decision.reason ?? 'blocked by server guard', terminate: false };
					});
				}
			: undefined;

		const wrapupExtension: ExtensionFactory | undefined = opts.wrapup
			? (pi) => {
					pi.on('agent_before_settle', async (event): Promise<AgentBeforeSettleEventResult | undefined> => {
						if (event.outcome !== 'completed' || (opts.maxTurns && turns >= opts.maxTurns)) return undefined;
						const maxTurns = opts.maxWrapupTurns ?? 1;
						if (this_wrapupUsed(opts) >= maxTurns) return undefined;
						const decision = await opts.wrapup?.();
						if (!decision) return undefined;
						incWrapup(opts);
						return {
							continue: true,
							entries: [
								{
									type: 'custom_message' as const,
									customType: 'server_wrapup',
									content: decision.prompt,
									display: true,
								},
							],
						};
					});
				}
			: undefined;

		let turns = 0;
		const budgetExtension: ExtensionFactory = (pi) => {
			pi.on('turn_end', async (_event, context) => {
				turns++;
				if (!opts.maxTurns) return;
				const grace = opts.wrapup ? (opts.maxWrapupTurns ?? 1) : 0;
				if (turns >= opts.maxTurns + grace) { context.abort(); return; }
				if (turns === opts.maxTurns) {
					const decision = await opts.wrapup?.();
					return { continue: true, entries: [{ type: 'custom_message' as const, customType: 'server_budget',
						content: decision?.prompt ?? '本轮预算已用尽。停止发起新操作，保存已有结果并简洁总结。', display: true }] };
				}
			});
		};

		const mcpFactory: ExtensionFactory | undefined =
			opts.mcpEntries && opts.mcpEntries.length > 0
				? createMcpExtension({
						loadConfig: () => ({
							servers: opts.mcpEntries!.map((e) => ({
								name: e.name,
								config: e.config as never,
								source: 'series-db',
								scope: 'extension' as const,
							})),
							errors: [],
						}),
					})
				: undefined;
		const loader = new DefaultResourceLoader({
			cwd: opts.cwd,
			agentDir: opts.agentDir,
			settingsManager: settings,
			noExtensions: true,
			extensionFactories: [guardExtension, wrapupExtension, budgetExtension, mcpFactory].filter(
				(e): e is ExtensionFactory => typeof e === 'function',
			),
			noSkills: !opts.skillsDir,
			skillsOverride: opts.skillsDir
				? (base) => {
						const loaded = loadSkillsFromDir({ dir: opts.skillsDir!, source: 'series' });
						return { skills: loaded.skills.filter((skill) => !opts.allowedSkills || opts.allowedSkills.includes(skill.name)), diagnostics: [...base.diagnostics, ...loaded.diagnostics] };
					}
				: undefined,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: opts.systemPrompt,
		});
		await loader.reload();

		if (opts.resumeSessionPath) mkdirSync(path.dirname(opts.resumeSessionPath), { recursive: true });
		const sessionManager = opts.resumeSessionPath
			? SessionManager.open(opts.resumeSessionPath, opts.sessionDir, opts.cwd)
			: opts.inMemory
				? SessionManager.inMemory(opts.cwd)
				: SessionManager.create(opts.cwd, opts.sessionDir);

		const { session } = await createAgentSession({
			cwd: opts.cwd,
			agentDir: opts.agentDir,
			model: opts.model,
			thinkingLevel: opts.thinkingLevel,
			modelRuntime: opts.modelRuntime,
			settingsManager: settings,
			sessionManager,
			resourceLoader: loader,
			tools: opts.toolAllowlist,
			customTools: opts.customTools,
		});

		return new AgentRunner(session, opts);
	}

	// -------------------------------------------------------------------------
	// 事件 → activity 映射（spike T3 顺序：… → tool_execution_start → tool_execution_end
	// → … → agent_end → agent_settled）
	// -------------------------------------------------------------------------

	private handleEvent(event: AgentSessionEvent): void {
		this.opts.onRawEvent?.(event);
		switch (event.type) {
			case 'turn_end':
				this.turns++;
				if (this.opts.maxTurns && this.turns >= this.opts.maxTurns) this.budgetExceeded = true;
				break;
			case 'message_start':
				if (event.message.role === 'assistant') this.streamID = randomUUID();
				break;
			case 'message_update': {
				const update = event.assistantMessageEvent;
				if (update.type === 'text_delta' || update.type === 'thinking_delta') {
					this.opts.onActivity?.({ kind: 'assistant_delta', text: update.delta, streamID: this.streamID, isThinking: update.type === 'thinking_delta' });
				}
				break;
			}
			case 'message_end':
				if (event.message.role === 'assistant') {
					if (event.message.stopReason === 'error') this.modelError = event.message.errorMessage ?? '模型调用失败';
					const thinking = assistantThinking(event.message);
					if (thinking) {
						this.opts.onActivity?.({ kind: 'assistant_message_end', text: thinking, isThinking: true });
					}
					this.opts.onActivity?.({ kind: 'assistant_message_end', text: assistantText(event.message), streamID: this.streamID });
					const u = (event.message as { usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } }).usage;
					if (u) {
						this.opts.onActivity?.({ kind: 'usage', input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite });
					}
				}
				break;
			case 'tool_execution_start':
				this.opts.onActivity?.({
					kind: 'tool_start',
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
				});
				break;
			case 'tool_execution_end':
				this.opts.onActivity?.({
					kind: 'tool_end',
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError,
					durationMs: event.durationMs,
					text: toolResultText(event.result),
				});
				break;
			case 'queue_update':
				this.opts.onActivity?.({ kind: 'queue_update', steering: event.steering, followUp: event.followUp });
				break;
			case 'agent_settled':
				this.opts.onActivity?.({ kind: 'settled', aborted: event.aborted });
				this.settled({ aborted: event.aborted, lastAssistantText: this.session.getLastAssistantText(), stopReason: this.budgetExceeded ? "budget" : event.aborted ? "aborted" : "completed" });
				this.resetSettled();
				break;
			default:
				break;
		}
	}

	// -------------------------------------------------------------------------
	// 对话驱动
	// -------------------------------------------------------------------------

	/** 发送一条用户消息并等待本次 run settle（含 wrapup 续跑轮） */
	async prompt(text: string): Promise<RunResult> {
		this.opts.signal?.throwIfAborted();
		const finished = this.settledPromise;
		const abort = () => { void this.abort(); };
		this.opts.signal?.addEventListener('abort', abort, { once: true });
		const timer = this.opts.maxDurationMs ? setTimeout(() => {
			this.budgetExceeded = true;
			void this.abort();
		}, this.opts.maxDurationMs) : undefined;
		try {
			await this.session.prompt(text);
			const result = await finished;
			if (this.modelError && !this.budgetExceeded && !this.opts.signal?.aborted && !result.aborted) throw new Error(this.modelError);
			return result;
		} finally {
			clearTimeout(timer);
			this.opts.signal?.removeEventListener('abort', abort);
		}
	}

	/** 运行中注入 steering 消息（当前回合工具跑完后、下一次 LLM 调用前生效） */
	async steer(text: string): Promise<'queued' | 'handled'> {
		return (await this.session.steer(text)) as 'queued' | 'handled';
	}

	/** 排队 follow-up（本轮彻底结束后再生效） */
	async followUp(text: string): Promise<'queued' | 'handled'> {
		return (await this.session.followUp(text)) as 'queued' | 'handled';
	}

	/** 中止当前运行并等待 idle */
	async abort(): Promise<void> {
		await this.session.abort();
	}

	// -------------------------------------------------------------------------
	// 会话生命周期
	// -------------------------------------------------------------------------

	/** 当前会话文件路径（内存会话为 undefined；首条用户消息落盘后才存在） */
	get sessionFile(): string | undefined {
		return this.session.sessionFile;
	}

	get sessionId(): string {
		return this.session.sessionId;
	}

	/** 当前完整消息列表（含自定义消息） */
	get messages(): readonly unknown[] {
		return this.session.messages;
	}

	/** 在当前 runner 之外按路径恢复一个新 runner（同一 modelRuntime 可复用） */
	async resume(options: Omit<AgentRunnerOptions, 'resumeSessionPath' | 'modelRuntime'> & { modelRuntime?: ModelRuntime }): Promise<AgentRunner> {
		const path = this.sessionFile;
		if (!path) throw new Error('当前会话尚未落盘，无法 resume');
		return AgentRunner.create({
			...options,
			modelRuntime: options.modelRuntime ?? this.opts.modelRuntime,
			resumeSessionPath: path,
		});
	}

	dispose(): void {
		this.session.dispose();
	}
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/** 提取 assistant 消息的 thinking 块文本（pi ThinkingContent）。 */
function assistantThinking(message: unknown): string | undefined {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'thinking') {
			const t = (block as { thinking?: unknown }).thinking;
			if (typeof t === 'string' && t.trim() !== '') parts.push(t);
		}
	}
	return parts.length > 0 ? parts.join('\n') : undefined;
}

/** 提取工具结果里的 text content（AgentToolResult.content[].text）。 */
function toolResultText(result: unknown): string | undefined {
	if (typeof result !== "object" || result === null) return undefined;
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	const texts: string[] = [];
	for (const block of content) {
		if (typeof block === "object" && block !== null && (block as { type?: string }).type === "text") {
			const t = (block as { text?: unknown }).text;
			if (typeof t === "string") texts.push(t);
		}
	}
	return texts.length > 0 ? texts.join("\n") : undefined;
}

/** wrapup 已用轮数的 per-runner 计数（通过闭包挂到 opts 上，避免静态状态串会话） */
const wrapupCounters = new WeakMap<AgentRunnerOptions, number>();
function this_wrapupUsed(opts: AgentRunnerOptions): number {
	return wrapupCounters.get(opts) ?? 0;
}
function incWrapup(opts: AgentRunnerOptions): void {
	wrapupCounters.set(opts, this_wrapupUsed(opts) + 1);
}

function assistantText(message: unknown): string {
	if (typeof message !== 'object' || message === null) return '';
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return '';
	return content
		.filter((c): c is { type: 'text'; text: string } => typeof c === 'object' && c !== null && (c as { type: string }).type === 'text')
		.map((c) => c.text)
		.join('');
}
