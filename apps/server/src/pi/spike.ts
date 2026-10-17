/**
 * pi SDK 适配层技术验证 spike（重构计划 M2）。
 *
 * 运行方式：cd apps/server && npx tsx src/pi/spike.ts
 *
 * 说明：
 * - pnpm 严格模式下 apps/server 只能直接 import `@earendil-works/pi-coding-agent`。
 *   pi-ai / pi-agent-core 是它的传递依赖，运行时通过「锚定 pi-coding-agent 的真实路径」
 *   加载（生产适配层应把 @earendil-works/pi-ai 加入直接依赖，本 spike 不改 package.json）。
 * - 全程使用 faux provider（脚本化响应，无网络、无 API key）。唯一触碰网络的是 T1 的
 *   自定义 provider，指向 127.0.0.1:9（保留端口，必然 ECONNREFUSED），只验证请求管线。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
	createAgentSession,
	DefaultResourceLoader,
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
import { AgentRunner, type RunnerActivity } from './runner.js';

// ---------------------------------------------------------------------------
// 0. 运行时加载 pi-ai / pi-agent-core（经由 pi-coding-agent 的依赖上下文）
// ---------------------------------------------------------------------------

const pcaIndexUrl: string = import.meta.resolve('@earendil-works/pi-coding-agent');
// .../@earendil-works/pi-coding-agent/dist/index.js -> .../@earendil-works
const scopeDir = dirname(dirname(dirname(fileURLToPath(pcaIndexUrl))));
const piAiUrl = pathToFileURL(join(scopeDir, 'pi-ai', 'dist', 'index.js')).href;
const piAi = (await import(piAiUrl)) as PiAiModule;

/** pi-ai 运行时面（本 spike 用到的子集，结构化声明而非 any） */
type PiProvider = Parameters<ModelRuntime['registerNativeProvider']>[0];

interface PiAiModule {
	fauxProvider: (options?: {
		provider?: string;
		models?: Array<{ id: string; name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number }>;
	}) => FauxHandle;
	fauxAssistantMessage: (
		content: string | unknown,
		options?: { stopReason?: string },
	) => Record<string, unknown>;
	fauxToolCall: (name: string, args: Record<string, unknown>, options?: { id?: string }) => unknown;
	createProvider: (input: Record<string, unknown>) => PiProvider;
	createModels: () => {
		setProvider: (p: PiProvider) => void;
		streamSimple: (model: unknown, context: unknown, options?: unknown) => {
			result: () => Promise<Record<string, unknown>>;
		};
	};
}

interface FauxHandle {
	provider: PiProvider;
	state: { callCount: number };
	getModel: () => unknown;
	setResponses: (responses: unknown[]) => void;
	appendResponses: (responses: unknown[]) => void;
}

// ---------------------------------------------------------------------------
// 结果收集
// ---------------------------------------------------------------------------

const results: Array<{ name: string; status: 'PASS' | 'FAIL' | 'TYPE_ONLY'; note: string }> = [];
function report(name: string, ok: boolean, note: string): void {
	results.push({ name, status: ok ? 'PASS' : 'FAIL', note });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${note}`);
}
function typeOnly(name: string, note: string): void {
	results.push({ name, status: 'TYPE_ONLY', note });
	console.log(`TYPE_ONLY  ${name} — ${note}`);
}

// ---------------------------------------------------------------------------
// 公共脚手架
// ---------------------------------------------------------------------------

const tmpRoot = mkdtempSync(join(tmpdir(), 'pi-spike-'));
const cwd = join(tmpRoot, 'work');
const agentDir = join(tmpRoot, 'agent');
const sessionDir = join(tmpRoot, 'sessions');
mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });

/** spike 自定义工具（TypeBox schema 无法直接 import typebox，用 JSON Schema 字面量 + 收窄） */
const spikeTool: ToolDefinition = {
	name: 'spike_query',
	label: 'Spike Query',
	description: '查询一个字符串并原样返回（spike 测试工具）',
	parameters: {
		type: 'object',
		properties: { query: { type: 'string', description: '要查询的内容' } },
		required: ['query'],
	} as ToolDefinition['parameters'],
	async execute(toolCallId, params) {
		const query = (params as { query: string }).query;
		toolCalls.push({ tool: 'spike_query', query });
		return {
			content: [{ type: 'text', text: `spike_query 结果: ${query}` }],
			details: { query },
		};
	},
};

/** 慢工具：execute 挂起直到外部放行，用于 steer/abort 测试 */
let releaseSlowTool: (() => void) | undefined;
let slowToolEntries = 0;
const slowTool: ToolDefinition = {
	name: 'spike_slow',
	label: 'Spike Slow',
	description: '一个慢工具，用于测试 steer/abort',
	parameters: { type: 'object', properties: {} } as ToolDefinition['parameters'],
	async execute(_toolCallId, _params, signal) {
		slowToolEntries += 1;
		await new Promise<void>((resolve) => {
			releaseSlowTool = resolve;
			signal?.addEventListener('abort', () => resolve(), { once: true });
		});
		toolCalls.push({ tool: 'spike_slow', query: 'released' });
		return { content: [{ type: 'text', text: 'slow done' }], details: undefined };
	},
};

const toolCalls: Array<{ tool: string; query: string }> = [];

/** 工具 guard（扩展事件 tool_call，可运行时开关） */
let guardEnabled = false;
let guardSawToolCall = false;
const guardExtension: ExtensionFactory = (pi) => {
	pi.on('tool_call', (event): ToolCallEventResult | undefined => {
		guardSawToolCall = true;
		if (guardEnabled && event.toolName === 'spike_query') {
			return { block: true, reason: 'blocked-by-spike-guard' };
		}
		return undefined;
	});
};

/** settlement wrapup（agent_before_settle，注入收尾提示并续跑一轮） */
let wrapupBudget = 0;
let beforeSettleCount = 0;
const wrapupExtension: ExtensionFactory = (pi) => {
	pi.on('agent_before_settle', (): AgentBeforeSettleEventResult | undefined => {
		beforeSettleCount += 1;
		if (wrapupBudget > 0) {
			wrapupBudget -= 1;
			return {
				continue: true,
				entries: [
					{
						type: 'custom_message' as const,
						customType: 'spike_wrapup',
						content: '[系统] 预算已到，请立即收尾总结。',
						display: true,
					},
				],
			};
		}
		return undefined;
	});
};

const events: string[] = [];
let sawQueueUpdate = false;
let settledAborted: boolean | undefined;

function makeFaux(providerId: string, modelId: string): FauxHandle {
	return piAi.fauxProvider({
		provider: providerId,
		models: [{ id: modelId, name: 'Spike Faux', contextWindow: 200_000, maxTokens: 4096 }],
	});
}

async function makeRuntime(): Promise<ModelRuntime> {
	const rt = await ModelRuntime.create({
		authPath: join(agentDir, 'auth.json'),
		modelsPath: join(agentDir, 'models.json'),
		refreshOnCreate: false,
	});
	return rt;
}

function makeLoader(): DefaultResourceLoader {
	return new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: settings,
		extensionFactories: [guardExtension, wrapupExtension],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: '你是 spike 测试 agent。',
	});
}

const settings = SettingsManager.inMemory({
	compaction: { enabled: false },
	retry: { enabled: false, maxRetries: 1, baseDelayMs: 10 },
});

function wireEvents(session: AgentSession): void {
	events.length = 0;
	session.subscribe((event: AgentSessionEvent) => {
		events.push(event.type);
		if (event.type === 'queue_update') sawQueueUpdate = true;
		if (event.type === 'agent_settled') settledAborted = event.aborted;
	});
}

/** faux 响应工厂捕获的每次 LLM 请求上下文 */
const capturedContexts: Array<unknown[]> = [];
function ctxCapturingResponse(text: string): unknown {
	return (context: { messages: unknown[] }) => {
		capturedContexts.push(context.messages);
		return piAi.fauxAssistantMessage(text);
	};
}

async function createSession(
	faux: FauxHandle,
	runtime: ModelRuntime,
	sm: SessionManager,
	extra?: Partial<CreateAgentSessionOptions>,
): Promise<AgentSession> {
	const loader = makeLoader();
	await loader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: faux.getModel() as NonNullable<CreateAgentSessionOptions["model"]>,
		modelRuntime: runtime,
		settingsManager: settings,
		sessionManager: sm,
		resourceLoader: loader,
		tools: ['spike_query', 'spike_slow'],
		customTools: [spikeTool, slowTool],
		...extra,
	});
	return session;
}

async function waitFor(predicate: () => boolean, ms: number, what: string): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, 20));
	}
	console.log(`  (timeout waiting for ${what})`);
	return false;
}

// ---------------------------------------------------------------------------
// T1 自定义 provider（OpenAI 兼容 api + 假 baseUrl）
// ---------------------------------------------------------------------------

async function t1_provider(): Promise<void> {
	try {
		const openaiCompletionsUrl = pathToFileURL(join(scopeDir, 'pi-ai', 'dist', 'api', 'openai-completions.js')).href;
		const openaiCompletions = (await import(openaiCompletionsUrl)) as Record<string, unknown>;

		const providerId = 'spike-ov';
		const baseUrl = 'http://127.0.0.1:9/v1'; // 保留端口，连接必失败
		const model = {
			id: 'spike-model',
			name: 'Spike Model',
			api: 'openai-completions',
			provider: providerId,
			baseUrl,
			input: ['text'],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			reasoning: false,
			contextWindow: 100_000,
			maxTokens: 4096,
		};
		const provider = piAi.createProvider({
			id: providerId,
			name: 'Spike OpenAI-compatible',
			baseUrl,
			auth: {
				apiKey: {
					name: 'SPIKE_KEY',
					resolve: async () => ({ auth: { apiKey: 'sk-spike' } }),
				},
			},
			models: [model],
			api: { 'openai-completions': openaiCompletions },
		});
		const models = piAi.createModels();
		models.setProvider(provider);

		// 真正发起一次请求：必须走到死端口并以 stopReason=error 的 AssistantMessage 结束
		const message = models.streamSimple(
			model,
			{ messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }], timestamp: Date.now() }] },
			{ maxRetries: 0 },
		);
		const result = await message.result();
		const stopReason = result['stopReason'];
		const errorMessage = String(result['errorMessage'] ?? '');
		const ok = provider.id === providerId && stopReason === 'error' && /ECONNREFUSED|fetch|connect/i.test(errorMessage);
		report('T1 自定义 provider（baseUrl+OpenAI 兼容 api）', ok, `createProvider 构造成功；streamSimple 到 127.0.0.1:9 返回 stopReason=${String(stopReason)} (${errorMessage.slice(0, 80)})`);
	} catch (error) {
		report('T1 自定义 provider（baseUrl+OpenAI 兼容 api）', false, String(error));
	}
}

// ---------------------------------------------------------------------------
// T2 会话创建 + 自定义工具 + faux prompt 全链路
// ---------------------------------------------------------------------------

async function t2_session(faux: FauxHandle, runtime: ModelRuntime): Promise<AgentSession | undefined> {
	try {
		const session = await createSession(faux, runtime, SessionManager.inMemory(cwd));
		wireEvents(session);
		faux.setResponses([
			piAi.fauxAssistantMessage([piAi.fauxToolCall('spike_query', { query: 'hello' })]),
			piAi.fauxAssistantMessage('工具调用完成。'),
		]);
		capturedContexts.length = 0;
		await session.prompt('请调用 spike_query 查询 hello');
		await session.waitForIdle();

		const toolOk = toolCalls.some((c) => c.tool === 'spike_query' && c.query === 'hello');
		const textOk = session.getLastAssistantText() === '工具调用完成。';
		const callsOk = faux.state.callCount === 2;
		report('T2 会话+自定义工具+prompt（faux 无 key）', toolOk && textOk && callsOk, `工具执行=${toolOk}，末条回复="${session.getLastAssistantText() ?? ''}"，LLM 调用次数=${faux.state.callCount}`);
		return session;
	} catch (error) {
		report('T2 会话+自定义工具+prompt（faux 无 key）', false, String(error));
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// T3 事件顺序
// ---------------------------------------------------------------------------

function t3_events(): void {
	const got = [...events];
	const order = (a: string, b: string) => got.indexOf(a) !== -1 && got.indexOf(b) !== -1 && got.indexOf(a) < got.indexOf(b);
	const required = ['agent_start', 'turn_start', 'message_end', 'tool_execution_start', 'tool_execution_end', 'turn_end', 'agent_end', 'agent_settled'];
	const missing = required.filter((t) => !got.includes(t));
	const orderingOk =
		order('agent_start', 'turn_start') &&
		order('tool_execution_start', 'tool_execution_end') &&
		order('tool_execution_end', 'agent_end') &&
		order('agent_end', 'agent_settled');
	report('T3 事件顺序', missing.length === 0 && orderingOk, `顺序=[${got.join(' → ')}]`);
}

// ---------------------------------------------------------------------------
// T4 beforeToolCall / tool_call guard 阻断
// ---------------------------------------------------------------------------

async function t4_guard(session: AgentSession | undefined, faux: FauxHandle): Promise<void> {
	if (!session) {
		report('T4 工具 guard（扩展 tool_call 阻断）', false, '前置会话缺失');
		return;
	}
	try {
		const before = toolCalls.length;
		guardEnabled = true;
		faux.setResponses([
			piAi.fauxAssistantMessage([piAi.fauxToolCall('spike_query', { query: 'should-block' })]),
			ctxCapturingResponse('收到阻断结果，结束。'),
		]);
		capturedContexts.length = 0;
		await session.prompt('再查一次 should-block');
		await session.waitForIdle();
		guardEnabled = false;

		const notExecuted = toolCalls.length === before;
		const guardSaw = guardSawToolCall;
		// 模型收到什么：第二次请求的上下文里，工具结果应为错误文本 blocked-by-spike-guard
		const secondContext = capturedContexts[0];
		const blockSeenByModel = secondContext ? JSON.stringify(secondContext).includes('blocked-by-spike-guard') : false;
		report('T4 工具 guard（扩展 tool_call 阻断）', notExecuted && guardSaw && blockSeenByModel, `execute 未运行=${notExecuted}；guard 收到 tool_call=${guardSaw}；模型收到的工具结果含阻断原因=${blockSeenByModel}`);
	} catch (error) {
		report('T4 工具 guard（扩展 tool_call 阻断）', false, String(error));
	}
}

// ---------------------------------------------------------------------------
// T5 settlement wrapup（agent_before_settle 注入收尾 + 限一轮）
// ---------------------------------------------------------------------------

async function t5_wrapup(session: AgentSession | undefined, faux: FauxHandle): Promise<void> {
	if (!session) {
		report('T5 wrapup（agent_before_settle 注入收尾）', false, '前置会话缺失');
		return;
	}
	try {
		beforeSettleCount = 0;
		wrapupBudget = 1; // 只允许续跑 1 轮
		faux.setResponses([piAi.fauxAssistantMessage('第一轮回答。'), ctxCapturingResponse('已按收尾指令总结。')]);
		capturedContexts.length = 0;
		await session.prompt('开始任务');
		await session.waitForIdle();

		const extraCall = faux.state.callCount >= 2;
		const settled = events.includes('agent_settled');
		const ctx = capturedContexts[capturedContexts.length - 1];
		const wrapupInContext = ctx ? JSON.stringify(ctx).includes('spike_wrapup') || JSON.stringify(ctx).includes('预算已到') : false;
		const limited = beforeSettleCount >= 2 && wrapupBudget === 0; // 第二次 settle 未续跑
		const wrapupEntry = session.sessionManager.getEntries().some((e) => e.type === 'custom_message');
		report(
			'T5 wrapup（agent_before_settle 注入收尾）',
			extraCall && settled && wrapupInContext && limited,
			`额外 LLM 轮次发生=${extraCall}；收尾消息进入模型上下文=${wrapupInContext}；二次 settle 停止=${limited}；custom_message 会话条目=${wrapupEntry}；before_settle 次数=${beforeSettleCount}`,
		);
	} catch (error) {
		report('T5 wrapup（agent_before_settle 注入收尾）', false, String(error));
	}
}

// ---------------------------------------------------------------------------
// T6 文件会话 resume（prompt → dispose → open 同一路径继续）
// ---------------------------------------------------------------------------

async function t6_resume(fauxFactory: () => FauxHandle, runtime: ModelRuntime): Promise<void> {
	let sessionFile: string | undefined;
	try {
		const faux1 = fauxFactory();
		runtime.registerNativeProvider(faux1.provider);
		const sm = SessionManager.create(cwd, sessionDir);
		const session = await createSession(faux1, runtime, sm);
		faux1.setResponses([piAi.fauxAssistantMessage('暗号是 pineapple，已记住。')]);
		await session.prompt('请记住暗号 pineapple');
		await session.waitForIdle();
		sessionFile = sm.getSessionFile();
		const persisted = typeof sessionFile === 'string';
		session.dispose();

		// 重新 open 同一路径
		const faux2 = fauxFactory();
		const runtime2 = await makeRuntime();
		runtime2.registerNativeProvider(faux2.provider);
		const reopened = SessionManager.open(sessionFile as string);
		const session2 = await createSession(faux2, runtime2, reopened);
		const restored = session2.state.messages.some((m) => JSON.stringify(m).includes('pineapple'));
		faux2.setResponses([piAi.fauxAssistantMessage('暗号是 pineapple。')]);
		await session2.prompt('暗号是什么？');
		await session2.waitForIdle();
		const answered = session2.getLastAssistantText() === '暗号是 pineapple。';
		const listed = (await SessionManager.list(cwd, sessionDir)).length >= 1;
		session2.dispose();
		report('T6 文件会话 resume（按路径 open + 继续对话）', persisted && restored && answered && listed, `会话文件=${sessionFile ?? 'none'}；恢复包含旧消息=${restored}；续问回答正确=${answered}；SessionManager.list≥1=${listed}`);
	} catch (error) {
		report('T6 文件会话 resume（按路径 open + 继续对话）', false, String(error));
	}
}

// ---------------------------------------------------------------------------
// T7 运行中 steer 注入
// ---------------------------------------------------------------------------

async function t7_steer(fauxFactory: () => FauxHandle, runtime: ModelRuntime): Promise<void> {
	try {
		const faux = fauxFactory();
		const runtime2 = await makeRuntime();
		runtime2.registerNativeProvider(faux.provider);
		const session = await createSession(faux, runtime2, SessionManager.inMemory(cwd));
		wireEvents(session);
		faux.setResponses([
			piAi.fauxAssistantMessage([piAi.fauxToolCall('spike_slow', {})]),
			ctxCapturingResponse('收到 banana，结束。'),
		]);
		const runPromise = session.prompt('调用 spike_slow');
		const toolStarted = await waitFor(() => toolCalls.some((c) => c.tool === 'spike_slow') || events.includes('tool_execution_start'), 5_000, 'tool start');
		const disposition = await session.steer('补充：记得带上 banana');
		releaseSlowTool?.();
		await runPromise;
		await session.waitForIdle();

		const ctx = capturedContexts[capturedContexts.length - 1];
		const steerDelivered = ctx ? JSON.stringify(ctx).includes('banana') : false;
		report('T7 运行中 steer 注入', toolStarted && steerDelivered && sawQueueUpdate, `steer 返回="${disposition}"；queue_update 事件=${sawQueueUpdate}；steer 文本进入下一次 LLM 上下文=${steerDelivered}`);

		// 附带验证 abort：慢工具挂起时中断，agent_settled.aborted=true
		const entriesBefore = slowToolEntries;
		events.length = 0;
		settledAborted = undefined;
		faux.setResponses([
			piAi.fauxAssistantMessage([piAi.fauxToolCall('spike_slow', {})]),
			piAi.fauxAssistantMessage('不该到达。'),
		]);
		const abortRun = session.prompt('再来一次');
		const started = await waitFor(() => slowToolEntries > entriesBefore, 5_000, 'second tool start');
		void session.abort();
		await Promise.race([
			abortRun.catch(() => undefined).then(() => session.waitForIdle()),
			new Promise((_, reject) => setTimeout(() => reject(new Error('abort timeout')), 10_000)),
		]).catch((e: unknown) => console.log(`  (${String(e)})`));
		report('T7b 运行中 abort', started && settledAborted === true, `第二次工具启动=${started}；agent_settled.aborted=${String(settledAborted)}`);
		session.dispose();
	} catch (error) {
		report('T7 运行中 steer 注入', false, String(error));
	}
}

// ---------------------------------------------------------------------------
// T8 settingsManager（InMemory + retry + compaction 关闭）
// ---------------------------------------------------------------------------

function t8_settings(): void {
	try {
		const s = SettingsManager.inMemory({
			retry: { enabled: false, maxRetries: 1, baseDelayMs: 10 },
			compaction: { enabled: false, reserveTokens: 1234, keepRecentTokens: 567 },
		});
		const retry = s.getRetrySettings();
		const compaction = s.getCompactionSettings({ provider: 'x', id: 'y' });
		const ok = retry.enabled === false && compaction.enabled === false && compaction.reserveTokens === 1234;
		report('T8 settingsManager（InMemory+retry+compaction）', ok, `retry=${JSON.stringify(retry)}；compaction=${JSON.stringify(compaction)}`);
	} catch (error) {
		report('T8 settingsManager（InMemory+retry+compaction）', false, String(error));
	}
}

// ---------------------------------------------------------------------------
// T9 runner.ts 骨架运行时冒烟（guard + wrapup + resume 全走 AgentRunner）
// ---------------------------------------------------------------------------

async function t9_runner(): Promise<void> {
	try {
		const faux = makeFaux('faux-runner', 'faux-1');
		const runtime = await makeRuntime();
		runtime.registerNativeProvider(faux.provider);

		const activities: RunnerActivity[] = [];
		let wrapupCalls = 0;
		capturedContexts.length = 0;
		faux.setResponses([
			piAi.fauxAssistantMessage([piAi.fauxToolCall('spike_query', { query: 'blocked?' })]),
			piAi.fauxAssistantMessage('第一轮结束。'),
			ctxCapturingResponse('已按收尾指令总结。'),
		]);
		const toolCallsBefore = toolCalls.length;

		const runner = await AgentRunner.create({
			cwd,
			agentDir,
			sessionDir: join(tmpRoot, 'runner-sessions'),
			modelRuntime: runtime,
			model: faux.getModel() as NonNullable<CreateAgentSessionOptions["model"]>,
			systemPrompt: '你是 runner 冒烟 agent。',
			toolAllowlist: ['spike_query'],
			customTools: [spikeTool],
			guard: (call) => (call.toolName === 'spike_query' ? { block: true, reason: 'runner-guard' } : undefined),
			wrapup: () => {
				wrapupCalls += 1;
				return wrapupCalls <= 1 ? { prompt: '[wrapup] 请总结' } : undefined;
			},
			maxWrapupTurns: 1,
			onActivity: (a) => activities.push(a),
		});
		const result = await runner.prompt('开始');
		const file = runner.sessionFile;

		const guardWorked = toolCalls.length === toolCallsBefore;
		const wrapupWorked =
			wrapupCalls === 1 && faux.state.callCount === 3 && !!capturedContexts[capturedContexts.length - 1] &&
			JSON.stringify(capturedContexts[capturedContexts.length - 1]).includes('[wrapup]');
		const settledOk = result.aborted === false && result.lastAssistantText === '已按收尾指令总结。';
		const activityOk =
			activities.some((a) => a.kind === 'settled' && !a.aborted) &&
			activities.some((a) => a.kind === 'assistant_message_end');

		// resume：按落盘路径新建 runner，历史恢复 + 继续对话
		let resumeOk = false;
		if (file) {
			const faux2 = makeFaux('faux-runner', 'faux-1');
			const runtime2 = await makeRuntime();
			runtime2.registerNativeProvider(faux2.provider);
			faux2.setResponses([piAi.fauxAssistantMessage('续问已答。')]);
			const resumed = await AgentRunner.create({
				cwd,
				agentDir,
				modelRuntime: runtime2,
				model: faux2.getModel() as NonNullable<CreateAgentSessionOptions['model']>,
				resumeSessionPath: file,
				toolAllowlist: ['spike_query'],
				customTools: [spikeTool],
			});
			const historyOk = resumed.messages.some((m) => JSON.stringify(m).includes('开始'));
			const r2 = await resumed.prompt('继续');
			resumeOk = historyOk && r2.lastAssistantText === '续问已答。' && r2.aborted === false;
			resumed.dispose();
		}
		runner.dispose();

		report(
			'T9 runner.ts 运行时冒烟（guard+wrapup+resume）',
			guardWorked && wrapupWorked && settledOk && activityOk && resumeOk,
			`guard 阻断=${guardWorked}；wrapup 注入+续跑一轮=${wrapupWorked}；run 结果=${settledOk}；activity 流=${activityOk}；按路径 resume=${resumeOk}`,
		);
	} catch (error) {
		report('T9 runner.ts 运行时冒烟（guard+wrapup+resume）', false, String(error));
	}
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const overallTimeout = setTimeout(() => {
	console.error('spike 总超时，强制退出');
	process.exit(1);
}, 60_000);

async function main(): Promise<void> {
	t8_settings();
	await t1_provider();

	const faux = makeFaux('faux-spike', 'faux-1');
	const runtime = await makeRuntime();
	runtime.registerNativeProvider(faux.provider);

	const session = await t2_session(faux, runtime);
	t3_events();
	await t4_guard(session, faux);
	await t5_wrapup(session, faux);
	session?.dispose();

	await t6_resume(() => makeFaux('faux-resume', 'faux-1'), runtime);
	await t7_steer(() => makeFaux('faux-steer', 'faux-1'), runtime);
	await t9_runner();

	clearTimeout(overallTimeout);
	const failed = results.filter((r) => r.status === 'FAIL');
	console.log('\n===== spike 汇总 =====');
	for (const r of results) console.log(`${r.status.padEnd(10)} ${r.name}`);
	console.log(`\n${results.length} 项：PASS=${results.filter((r) => r.status === 'PASS').length} FAIL=${failed.length} TYPE_ONLY=${results.filter((r) => r.status === 'TYPE_ONLY').length}`);
	rmSync(tmpRoot, { recursive: true, force: true });
	process.exit(failed.length > 0 ? 1 : 0);
}

void main();
