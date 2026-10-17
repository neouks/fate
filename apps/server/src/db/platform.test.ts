// 平台 store 集成测试：seedBuiltins 幂等（跑两遍行数不变）、拦截规则 Match
// （优先级降序首命中即停 / (?i) 正则 / 坏正则跳过）、Decide 原子结算（两次 decide
// 第二次拒绝、超时不覆盖人工）、settings 类型化访问器、ToolResolve 过滤+覆盖、
// LLM profile CRUD。
// 依赖本地开发库 (127.0.0.1:5433)，无库时跳过。
// 运行：cd apps/server && npx vitest run src/db/platform.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDatabase, type Database } from "./index.js";
import {
  PlatformStore,
  seedBuiltins,
  DEFAULT_INTERCEPT_ENABLED_TOOLS,
  SETTING_INTERCEPT_ENABLED_TOOLS,
  ActiveLLMProfileDeleteError,
  LLMProfileNotFoundError,
} from "./platform.js";
import {
  InterceptStore,
  Interceptor,
  InterceptAlreadyDecidedError,
  compileInterceptRegex,
  type RuleInput,
  type InterceptAudit,
} from "./intercept.js";

const TEST_DSN = process.env.SERIES_TEST_PG_DSN ?? "postgres://series:series@127.0.0.1:5433/series_test?sslmode=disable";

let haveDB = true;
let db: Database | null = null;
let platform: PlatformStore;
let store: InterceptStore;
let interceptor: Interceptor;

const cleanupSQL: string[] = []; // 测试自建行的收尾 DDL

beforeAll(async () => {
  process.env.SERIES_PG_DSN = TEST_DSN;
  try {
    db = await openDatabase();
  } catch {
    haveDB = false;
    return;
  }
  platform = new PlatformStore(db);
  store = new InterceptStore(db);
  interceptor = new Interceptor(db);
});

afterAll(async () => {
  if (db) {
    for (const sql of cleanupSQL) {
      await db.query(sql).catch(() => undefined);
    }
  }
  await db?.close().catch(() => undefined);
});

async function count(sql: string): Promise<number> {
  const res = await db!.query<{ n: string }>(`SELECT count(*) AS n FROM (${sql}) t`);
  return Number(res.rows[0]!.n);
}

/** 测试专用规则（超高优先级压过内置规则；用后删除）。 */
async function testRule(overrides: Partial<RuleInput> & { name: string }): Promise<number> {
  const r = await store.createInterceptRule({
    name: overrides.name,
    matchTarget: "tool_input",
    matchType: "regex",
    pattern: overrides.pattern ?? "NEVER-MATCH-xyz",
    action: overrides.action ?? "deny",
    message: overrides.message ?? "",
    priority: overrides.priority ?? 1_000_000,
    enabled: true,
    timeoutEnabled: false,
    timeoutSeconds: 60,
    timeoutAction: "deny",
    ...overrides,
  });
  cleanupSQL.push(`DELETE FROM intercept_rules WHERE id=${r.id}`);
  interceptor.invalidate();
  return r.id;
}

function testAudit(): InterceptAudit {
  return {
    run_id: "run-test-1",
    tool_use_id: "tu-test-1",
    correlation: "exact",
    input_digest: "d41d8cd9",
    user_message: "帮我删掉这条数据",
    context: [],
    captured_at: new Date().toISOString(),
    initial_action: "ask",
    initial_reason: "规则要求审批",
    execution_status: "pending",
  };
}

describe.skipIf(!haveDB)("seedBuiltins", () => {
  it("两遍运行幂等：行数不变，六角色 + 规则 v1/v2/v3 + 内置 MCP 就位", async () => {
    await seedBuiltins(db!);
    const snap1 = {
      agents: await count(`SELECT 1 FROM agents WHERE builtin`),
      goalsVars: await count(`SELECT 1 FROM agent_prompt_vars`),
      mcp: await count(`SELECT 1 FROM mcp_servers`),
      rules: await count(`SELECT 1 FROM intercept_rules WHERE name LIKE '[内置]%'`),
      skills: await count(`SELECT 1 FROM agent_skill_visibility WHERE skill_name='api-recon'`),
    };
    await seedBuiltins(db!);
    const snap2 = {
      agents: await count(`SELECT 1 FROM agents WHERE builtin`),
      goalsVars: await count(`SELECT 1 FROM agent_prompt_vars`),
      mcp: await count(`SELECT 1 FROM mcp_servers`),
      rules: await count(`SELECT 1 FROM intercept_rules WHERE name LIKE '[内置]%'`),
      skills: await count(`SELECT 1 FROM agent_skill_visibility WHERE skill_name='api-recon'`),
    };
    expect(snap2).toEqual(snap1); // 幂等：第二遍零新增

    // 六个内置角色（key 集合精确匹配）
    const keys = (await platform.listAgents()).filter((a) => a.builtin).map((a) => a.key).sort();
    expect(keys).toEqual(["auto", "goals", "mainagent", "pentest", "planner", "worker"]);

    // 变量目录：goals 1 / planner 2 / mainagent 3 / worker 2 = 8 条
    expect(snap1.agents).toBe(6);
    expect(snap1.goalsVars).toBe(8);
    expect(snap1.mcp).toBeGreaterThanOrEqual(4); // ScopeSentry(schema 播) + playwright/web_search/chrome-devtools
    const mcpNames = (await platform.listMCP()).map((m) => m.name);
    for (const n of ["playwright", "web_search", "chrome-devtools", "ScopeSentry"]) expect(mcpNames).toContain(n);
    const seeded = (await platform.listMCP()).filter((m) => ["playwright", "web_search", "chrome-devtools"].includes(m.name));
    expect(seeded.every((m) => !m.enabled)).toBe(true); // 预设默认 disabled

    // 规则种子：v1 17 + v2 2 + v3 1 = 20；旗标全部落 done
    expect(snap1.rules).toBeGreaterThanOrEqual(20);
    expect(await platform.getSetting("intercept_default_rules_v1")).toBe("done");
    expect(await platform.getSetting("intercept_default_rules_v2")).toBe("done");
    expect(await platform.getSetting("intercept_default_rules_v3")).toBe("done");
    expect(await platform.getSetting("interactive_shell_default_v1")).toBe("true");

    // 抽查规则内容
    const rules = await store.listInterceptRules();
    const rmrf = rules.find((r) => r.name === "[内置] 递归强制删除 rm -rf")!;
    expect(rmrf.priority).toBe(100);
    expect(rmrf.action).toBe("deny");
    const exfil = rules.find((r) => r.name === "[内置] 数据外泄管道")!;
    expect(exfil.enabled).toBe(false); // v2 外泄规则默认禁用
    const delPath = rules.find((r) => r.name === "[内置] 删除类接口路径")!;
    expect(delPath.priority).toBe(80);
    expect(delPath.pattern).toContain("(?i)");

    // agent 细节：pentest 默认开交互 shell 且不限时；goals 默认关
    const pentest = await platform.getAgentByKey("pentest");
    expect(pentest!.interactiveShell).toBe(true);
    expect(pentest!.runSeconds).toBe(0);
    const goals = await platform.getAgentByKey("goals");
    expect(goals!.interactiveShell).toBe(false);
    expect(goals!.runSeconds).toBe(1200);
    const plannerVars = await platform.promptVars((await platform.getAgentByKey("planner"))!.id);
    expect(plannerVars.map((v) => v.name)).toEqual(["AssetSummary", "Goal"]);
  });
});

describe.skipIf(!haveDB)("settings 类型化访问器", () => {
  it("workers 默认 3 / setWorkers / getBool", async () => {
    await db!.query(`DELETE FROM settings WHERE key='workers'`);
    expect(await platform.workers()).toBe(3);
    await platform.setSetting("workers", "0");
    expect(await platform.workers()).toBe(3); // 非法回退默认
    await platform.setWorkers(5);
    expect(await platform.workers()).toBe(5);
    await expect(platform.setWorkers(0)).rejects.toThrow();
    await db!.query(`DELETE FROM settings WHERE key='workers'`);

    expect(await platform.getBool("__no_such_key__", true)).toBe(true);
    expect(await platform.insertSettingIfAbsent("__once__", "v1")).toBe(true);
    expect(await platform.insertSettingIfAbsent("__once__", "v2")).toBe(false); // 已存在不覆盖
    expect(await platform.getSetting("__once__")).toBe("v1");
    await db!.query(`DELETE FROM settings WHERE key='__once__'`);
  });
});

describe.skipIf(!haveDB)("拦截规则 Match", () => {
  it("compileInterceptRegex：(?i) 提升为 flags，坏正则返回 null", () => {
    const re = compileInterceptRegex(String.raw`(?i)\bDROP\s+`);
    expect(re).not.toBeNull();
    expect(re!.test("drop table")).toBe(true);
    expect(re!.test("drop table")).toBe(true); // 无 g flag，test 无状态可重复
    expect(compileInterceptRegex("(")).toBeNull();
    expect(compileInterceptRegex(String.raw`(?U)a+`)).toBeNull(); // 不可映射旗标 → 跳过
  });

  it("优先级降序首命中即停；(?i) 正则命中；坏正则规则被跳过", async () => {
    // 优先级最高但正则非法 → 装载时剔除，不能截断匹配链
    await testRule({ name: "t-bad-regex", pattern: "(", priority: 3_000_000, action: "deny", message: "坏正则" });
    // 高优先级 allow 先命中即停（低优先级 deny 同样命中也不生效）
    await testRule({
      name: "t-allow-first", pattern: String.raw`(?i)DELETEME-SECRET`, priority: 2_000_000,
      action: "allow", message: "放行测试",
    });
    await testRule({ name: "t-deny-lower", pattern: String.raw`secret`, priority: 1_500_000, action: "deny" });
    // tool_name 字符串规则
    await testRule({
      name: "t-name-string", matchTarget: "tool_name", matchType: "string", pattern: "Bash",
      priority: 1_000_000, action: "ask", message: "",
    });

    // 高优先级 allow 胜出（首命中即停），大小写不敏感
    const d1 = await interceptor.match("Bash", '{"command":"echo deleteme-secret"}');
    expect(d1).not.toBeNull();
    expect(d1!.ruleName).toBe("t-allow-first");
    expect(d1!.action).toBe("allow");
    expect(d1!.message).toBe("放行测试");
    expect(d1!.configDigest).toHaveLength(64);

    // 无 input 命中 → 落到 tool_name 规则；message 为空给默认文案
    const d2 = await interceptor.match("Bash", '{"command":"echo hello"}');
    expect(d2!.ruleName).toBe("t-name-string");
    expect(d2!.action).toBe("ask");
    expect(d2!.message).toContain("t-name-string");
    expect(d2!.message).toContain("审批");

    // 其他工具 + 干净输入 → 无命中（内置规则也不该误伤日常命令）
    const d3 = await interceptor.match("WebFetch", '{"command":"echo hello"}');
    expect(d3).toBeNull();

    // 内置种子规则经 (?i) 桥接后真的可匹配（用非 Bash 的工具名，避开本组高优先级 tool_name 规则）
    const d4 = await interceptor.match("shell_open", '{"command":"sudo rm -rf / --no-preserve-root"}');
    expect(d4).not.toBeNull();
    expect(d4!.action).toBe("deny");
    expect(d4!.ruleName).toContain("内置");
  });

  it("IsToolEnabled 默认集 + SetEnabledTools 持久化并失效缓存", async () => {
    await db!.query(`DELETE FROM settings WHERE key='${SETTING_INTERCEPT_ENABLED_TOOLS}'`);
    interceptor.invalidate();
    expect(await interceptor.isToolEnabled("Bash")).toBe(true);
    expect(await interceptor.getEnabledTools()).toEqual(DEFAULT_INTERCEPT_ENABLED_TOOLS);
    await interceptor.setEnabledTools(["Bash", "MyCustomTool"]);
    expect(await interceptor.isToolEnabled("MyCustomTool")).toBe(true);
    expect(await interceptor.isToolEnabled("WebFetch")).toBe(false);
    expect(await interceptor.getEnabledTools()).toEqual(["Bash", "MyCustomTool"]);
    await db!.query(`DELETE FROM settings WHERE key='${SETTING_INTERCEPT_ENABLED_TOOLS}'`);
    interceptor.invalidate();
    expect(await interceptor.getEnabledTools()).toEqual(DEFAULT_INTERCEPT_ENABLED_TOOLS);
  });
});

describe.skipIf(!haveDB)("pending 审批原子结算", () => {
  it("创建/列表 → decide 成功；第二次 decide 拒绝；超时无法覆盖人工", async () => {
    const ruleID = await testRule({ name: "t-ask-rule", action: "ask", message: "请审批" });
    const id = await store.createInterceptPending({
      ruleID, convID: 0, taskID: "task-test-1", agentName: "worker-1", toolName: "Bash",
      input: { command: "curl -X DELETE http://t/api/user/1" }, reason: "请审批", audit: testAudit(),
    });
    expect(id).toBeGreaterThan(0);

    // 列表（按任务过滤）
    const pending = await store.listPendingIntercepts("task-test-1");
    expect(pending.some((p) => p.id === id && p.status === "pending")).toBe(true);
    const mine = pending.find((p) => p.id === id)!;
    expect(mine.ruleID).toBe(ruleID);
    expect(mine.conversationID).toBeNull(); // convID=0 → NULL
    expect(mine.decisionSource).toBe("rule");
    expect((mine.toolInput as Record<string, unknown>)["command"]).toContain("DELETE");

    // 第一次 decide 成功
    await expect(interceptor.decide(id, true)).resolves.toBeUndefined();

    // 第二次 decide（人工改主意）→ 拒绝改写历史
    await expect(interceptor.decide(id, false)).rejects.toThrow(InterceptAlreadyDecidedError);

    // 超时收割也撞不上 WHERE status='pending'
    expect(await store.resolveIntercept(id, "timeout", "deny", "审批超时")).toBe(false);

    // 结算后审计 merge 生效：effective_action=allow、awaiting_result（correlation=exact）
    const detail = await store.getInterceptDetail(id)!;
    expect(detail!.status).toBe("allowed");
    expect(detail!.audit!.effective_action).toBe("allow");
    expect(detail!.audit!.execution_status).toBe("awaiting_result");
    expect(detail!.audit!.decision_reason).toBe("人工允许执行");
    expect(detail!.ruleName).toBe("t-ask-rule");

    // CompleteIntercept：三重 WHERE（run_id+tool_use_id+awaiting_result）命中 1 行
    const n = await store.completeIntercept(id, "run-test-1", "tu-test-1", "executed", "已执行", false);
    expect(n).toBe(1);
    const done = await store.getInterceptDetail(id)!;
    expect(done!.audit!.execution_status).toBe("executed");
    expect(done!.audit!.output).toBe("已执行");

    // run_id 不匹配 → 0 行（不被误回填）
    const n2 = await store.completeIntercept(id, "run-other", "tu-test-1", "failed", "x", false);
    expect(n2).toBe(0);

    // 未决列表不再包含它
    expect((await store.listPendingIntercepts("task-test-1")).some((p) => p.id === id)).toBe(false);
  });

  it("无审计行：结算后 audit 保持 NULL；非 allow 决定 → not_executed", async () => {
    const id = await store.createInterceptPending({
      ruleID: 0, convID: 0, taskID: "task-test-2", agentName: "worker-2", toolName: "Write",
      input: {}, reason: "[模型] 疑似越权写入", audit: null,
    });
    expect((await store.getInterceptPending(id))!.decisionSource).toBe("model"); // ruleID=0 + [模型] 前缀
    expect(await store.resolveIntercept(id, "denied", "deny", "人工拒绝执行")).toBe(true);
    const d = await store.getInterceptDetail(id)!;
    expect(d!.status).toBe("denied");
    expect(d!.audit).toBeNull(); // 原本无审计 → merge 不产生审计
    // 非 allow 无执行可回填
    expect(await store.completeIntercept(id, "", "", "executed", "", false)).toBe(0);
  });

  it("CreateDecidedIntercept 直接落终态（观测日志）", async () => {
    const id = await store.createDecidedIntercept({
      ruleID: 0, convID: 0, taskID: "", agentName: "", toolName: "Bash",
      input: '{"command":"ls"}', status: "denied", reason: "规则拒绝", audit: null,
    });
    const p = await store.getInterceptPending(id)!;
    expect(p!.status).toBe("denied");
    expect(p!.decidedAt).not.toBeNull();
    expect(p!.taskID).toBeNull();
    // 不出现在未决列表
    expect((await store.listPendingIntercepts()).some((x) => x.id === id)).toBe(false);
  });
});

describe.skipIf(!haveDB)("ToolResolve 核心", () => {
  it("按 agent 过滤 + 描述覆盖 + schema 元数据合并；无行工具放行；seed 首插 only", async () => {
    const key = "test_tool_resolve_demo";
    const schema = {
      type: "object",
      properties: {
        limit: { type: "number", description: "代码版", default: 10 },
        verbose: { type: "boolean" },
      },
    };
    await platform.seedTool(key, "DB 覆盖描述", schema, ["worker"]);
    // 首插 only：再 seed 不同描述不覆盖
    await platform.seedTool(key, "第二版描述", schema, ["worker"]);
    const row = await platform.getTool(key)!;
    expect(row!.description).toBe("DB 覆盖描述");

    const codeTools = [
      {
        name: key,
        description: "代码内置描述",
        schema: {
          type: "object",
          properties: { limit: { type: "number" }, verbose: { type: "boolean", description: "代码版" } },
        },
      },
      { name: "mcp_unknown_tool", description: "MCP 工具", schema: { type: "object" } },
    ];
    const forWorker = await platform.resolveToolsForAgent("worker", codeTools);
    expect(forWorker.map((t) => t.name).sort()).toEqual(["mcp_unknown_tool", key]); // worker 绑定保留 + 无行放行
    const resolved = forWorker.find((t) => t.name === key)!;
    expect(resolved.description).toBe("DB 覆盖描述");
    expect((resolved.schema.properties as Record<string, Record<string, unknown>>).limit!["default"]).toBe(10);
    expect((resolved.schema.properties as Record<string, Record<string, unknown>>).limit!["description"]).toBe("代码版");
    // 未绑定 agent → 丢弃
    const forPlanner = await platform.resolveToolsForAgent("planner", codeTools);
    expect(forPlanner.map((t) => t.name)).toEqual(["mcp_unknown_tool"]);
    // 禁用 → 丢弃
    await platform.updateTool(key, "DB 覆盖描述", schema, ["worker"], false);
    const afterDisable = await platform.resolveToolsForAgent("worker", codeTools);
    expect(afterDisable.map((t) => t.name)).toEqual(["mcp_unknown_tool"]);
    cleanupSQL.push(`DELETE FROM tools WHERE key='${key}'`);
  });
});

describe.skipIf(!haveDB)("提示词版本", () => {
  it("SeedPromptIfEmpty 首插 only + savePrompt 追加版本 + promptOverride", async () => {
    // 用一次性自定义 agent，避免与其它并发迁移/种子写入 goals 的提示词互相干扰
    await db!.query(
      `INSERT INTO agents(key, name, description, role, builtin, enabled) VALUES ('test_prompt_agent','测试','','assistant',false,true)
       ON CONFLICT (key) DO NOTHING`,
    );
    cleanupSQL.push(`DELETE FROM agents WHERE key='test_prompt_agent'`); // 级联清 agent_prompts
    const a = (await platform.getAgentByKey("test_prompt_agent"))!;

    await platform.seedPromptIfEmpty(a.id, "v1 模板 {{EngagementDescription}}");
    await platform.seedPromptIfEmpty(a.id, "v2 模板"); // 已有版本 → no-op
    expect(await platform.currentPrompt(a.id)).toBe("v1 模板 {{EngagementDescription}}");
    expect(await platform.promptOverride("test_prompt_agent")).toBe("v1 模板 {{EngagementDescription}}");
    expect(await platform.promptOverride("__no_agent__")).toBeNull();

    const v2 = await platform.savePrompt(a.id, "用户编辑版", "页面编辑", "user");
    expect(v2).toBe(2);
    expect(await platform.currentPrompt(a.id)).toBe("用户编辑版");
    const versions = await platform.listPromptVersions(a.id);
    expect(versions.map((x) => x.version)).toEqual([2, 1]);
    expect(versions[0]!.note).toBe("页面编辑");
  });
});

describe.skipIf(!haveDB)("LLM profile CRUD", () => {
  it("保存/激活/池链/删除（激活中不可删）", async () => {
    const nameA = `测试profile-A-${Date.now()}`;
    const nameB = `测试profile-B-${Date.now()}`;
    cleanupSQL.push(`DELETE FROM llm_profiles WHERE name IN ('${nameA}','${nameB}')`);

    const idA = await platform.saveProfile({
      name: nameA, format: "openai", model: "gpt-test", apiKey: "sk-test-abcd1234",
      baseURL: "https://gw.example/v1", priority: 10,
      retry: { connect: { attempts: 99, interval_ms: -5 } },
    });
    expect(idA).toBeGreaterThan(0);
    // hint 尾 4 位 + retry clamp（attempts 99→20，interval -5→0）
    const listA = (await platform.listProfiles()).find((p) => p.id === idA)!;
    expect(listA.apiKey).toBe(""); // 列表不带 key
    expect(listA.apiKeyHint).toBe("…1234");
    expect(listA.retry.connect.attempts).toBe(20);
    expect(listA.retry.connect.interval_ms).toBe(0);

    // 更新留空 key = 保留
    await platform.saveProfile({ id: idA, name: nameA, format: "openai", model: "gpt-test-2" });
    const reloaded = await platform.profileByID(idA);
    expect(reloaded!.model).toBe("gpt-test-2");
    expect(reloaded!.apiKey).toBe("sk-test-abcd1234");

    await platform.setActiveProfile(idA);
    const active = await platform.activeProfile();
    expect(active!.id).toBe(idA);
    expect(active!.isDefault).toBe(true);

    const idB = await platform.saveProfile({
      name: nameB, format: "anthropic", model: "claude-test", apiKey: "sk-ant-5678", priority: 5,
    });
    const pool = await platform.poolProfiles();
    expect(pool[0]!.id).toBe(idA); // 激活 profile 领头
    expect(pool.map((p) => p.id)).toContain(idB);

    // 激活中不可删；切激活后可删
    await expect(platform.deleteProfile(idA)).rejects.toThrow(ActiveLLMProfileDeleteError);
    await platform.setActiveProfile(idB);
    await platform.deleteProfile(idA);
    expect(await platform.profileByID(idA)).toBeNull();
    await expect(platform.setActiveProfile(987654321)).rejects.toThrow(LLMProfileNotFoundError);
    // 单默认不变式
    expect((await platform.activeProfile())!.id).toBe(idB);
  });
});
