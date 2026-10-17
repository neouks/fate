// 批次 C5：自定义工具（tools 表 kind!=builtin 行）CRUD + 一次性测试执行。
// 对齐前端 web/src/lib/api.ts 的 createCustomTool/updateCustomTool/deleteCustomTool/testCustomTool。
// GET /api/tools 已由 routes/config.ts 返回全部行（含 custom），此处不重复注册。
// exec 规格 JSONB 直存（kind=command: {command, args?...}；kind=http: {method,url,headers?...}）。

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const TEST_TIMEOUT_MS = 15_000;
const TEST_OUTPUT_CAP = 64 * 1024;
const CUSTOM_KINDS = new Set(["shell", "command", "script", "http"]);

interface CustomToolInput {
  key: string;
  description: string;
  schema: Record<string, unknown>;
  agents: string[];
  enabled: boolean;
  kind: string;
  exec: Record<string, unknown>;
  deferred: boolean;
  directory: string;
  usage_help: string;
  when_to_use: string;
  executable: string;
}

/** 从请求体解析自定义工具字段（宽松：缺省按零值）。 */
function parseToolBody(b: Record<string, unknown>, forCreate: boolean): CustomToolInput | { error: string } {
  const key = typeof b["key"] === "string" ? b["key"].trim() : "";
  if (forCreate) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(key)) return { error: "key 仅限字母数字/_/.-/且不以符号开头" };
  }
  const kind = String(b["kind"] ?? "command");
  if (!CUSTOM_KINDS.has(kind)) return { error: `kind 仅支持 ${[...CUSTOM_KINDS].join("|")}` };
  return {
    key,
    description: typeof b["description"] === "string" ? b["description"] : "",
    schema: (typeof b["schema"] === "object" && b["schema"] !== null && !Array.isArray(b["schema"])
      ? (b["schema"] as Record<string, unknown>)
      : {}),
    agents: Array.isArray(b["agents"]) ? b["agents"].map(String).filter((s) => s !== "") : [],
    enabled: b["enabled"] !== false,
    kind,
    exec: (typeof b["exec"] === "object" && b["exec"] !== null && !Array.isArray(b["exec"])
      ? (b["exec"] as Record<string, unknown>)
      : {}),
    deferred: b["deferred"] === true,
    directory: typeof b["directory"] === "string" ? b["directory"] : "",
    usage_help: typeof b["usage_help"] === "string" ? b["usage_help"] : "",
    when_to_use: typeof b["when_to_use"] === "string" ? b["when_to_use"] : "",
    executable: typeof b["executable"] === "string" ? b["executable"] : "",
  };
}

/** 受控测试目录：directory 提供且在 dataDir 内 → 用之；否则临时目录。 */
function testWorkdir(app: FastifyInstance, directory: string): string {
  if (directory.trim() === "") {
    return path.join(app.dataDir, "tmp", "tool-test");
  }
  const resolved = path.resolve(directory);
  const allowed = path.resolve(app.dataDir);
  if (resolved === allowed || resolved.startsWith(allowed + path.sep)) return resolved;
  return path.join(allowed, "tmp", "tool-test");
}

export function registerCustomToolRoutes(app: FastifyInstance): void {
  const db = () => app.db;

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  app.post("/api/tools/custom", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseToolBody(b, true);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const exists = await db().query(`SELECT 1 FROM tools WHERE key=$1`, [parsed.key]);
    if (exists.rows.length > 0) return reply.code(409).send({ error: `工具 key ${parsed.key} 已存在` });
    await db().query(
      `INSERT INTO tools(key, system, description, schema, agents, enabled, kind, exec, deferred, directory, usage_help, when_to_use, executable)
       VALUES ($1, false, $2, $3::jsonb, $4::jsonb, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)`,
      [
        parsed.key,
        parsed.description,
        JSON.stringify(parsed.schema ?? {}),
        JSON.stringify(parsed.agents ?? []),
        parsed.enabled,
        parsed.kind,
        JSON.stringify(parsed.exec ?? {}),
        parsed.deferred,
        parsed.directory,
        parsed.usage_help,
        parsed.when_to_use,
        parsed.executable,
      ],
    );
    return reply.code(201).send({ key: parsed.key });
  });

  app.put("/api/tools/custom/:key", async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const cur = await db().query(`SELECT system FROM tools WHERE key=$1`, [key]);
    if (cur.rows.length === 0) return reply.code(404).send({ error: `工具 ${key} 不存在` });
    if (cur.rows[0]!["system"] === true) return reply.code(400).send({ error: "内置工具不可用自定义工具接口修改" });
    const parsed = parseToolBody({ ...b, key }, false);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    await db().query(
      `UPDATE tools SET description=$2, schema=$3::jsonb, agents=$4::jsonb, enabled=$5, kind=$6, exec=$7::jsonb,
         deferred=$8, directory=$9, usage_help=$10, when_to_use=$11, executable=$12 WHERE key=$1`,
      [
        key,
        parsed.description,
        JSON.stringify(parsed.schema ?? {}),
        JSON.stringify(parsed.agents ?? []),
        parsed.enabled,
        parsed.kind,
        JSON.stringify(parsed.exec ?? {}),
        parsed.deferred,
        parsed.directory,
        parsed.usage_help,
        parsed.when_to_use,
        parsed.executable,
      ],
    );
    return { ok: true };
  });

  app.delete("/api/tools/custom/:key", async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const res = await db().query(`DELETE FROM tools WHERE key=$1 AND system=false RETURNING key`, [key]);
    if (res.rows.length === 0) return reply.code(404).send({ error: `自定义工具 ${key} 不存在` });
    return { deleted: String(res.rows[0]!["key"]) };
  });

  // ─── 一次性测试执行 ───────────────────────────────────────────────────────

  app.post("/api/tools/custom/test", async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const kind = String(b["kind"] ?? "");
    const exec = (typeof b["exec"] === "object" && b["exec"] !== null && !Array.isArray(b["exec"])
      ? (b["exec"] as Record<string, unknown>)
      : {});
    const action = String(b["action"] ?? "run");
    const started = Date.now();

    if (kind === "command" || kind === "shell") {
      const command =
        typeof b["command"] === "string" && b["command"].trim() !== ""
          ? b["command"].trim()
          : typeof exec["command"] === "string"
            ? exec["command"]
            : "";
      const execArgs = Array.isArray(exec["args"]) ? (exec["args"] as unknown[]).map(String) : [];
      const full = command === "" ? "" : execArgs.length > 0 ? `${command} ${execArgs.join(" ")}` : command;
      if (full === "") return { output: "缺少 command（body.command 或 exec.command）", is_error: true };
      if (action === "check") return { output: `命令检查通过：${full}`, is_error: false };
      const cwd = testWorkdir(app, typeof b["directory"] === "string" ? b["directory"] : String(exec["directory"] ?? ""));
      mkdirSync(cwd, { recursive: true });
      return await new Promise<{ output: string; is_error: boolean; duration_ms: number }>((resolve) => {
        const child = spawn(full, {
          shell: true,
          cwd,
          env: { ...process.env },
          timeout: TEST_TIMEOUT_MS,
        });
        let out = "";
        const cap = (c: Buffer): void => {
          if (out.length < TEST_OUTPUT_CAP) out += c.toString("utf8");
        };
        child.stdout?.on("data", cap);
        child.stderr?.on("data", cap);
        child.on("error", (err) => resolve({ output: `执行失败: ${err.message}`, is_error: true, duration_ms: Date.now() - started }));
        child.on("close", (code, signal) => {
          const text = out.length > TEST_OUTPUT_CAP ? `${out.slice(0, TEST_OUTPUT_CAP)}\n…(截断)` : out;
          resolve({
            output: text === "" ? `（无输出，exit=${code ?? signal ?? "unknown"}）` : text,
            is_error: code !== 0,
            duration_ms: Date.now() - started,
          });
        });
      });
    }

    if (kind === "http") {
      const url = typeof exec["url"] === "string" ? exec["url"] : "";
      const method = String(exec["method"] ?? "GET").toUpperCase();
      if (url === "") return { output: "缺少 exec.url", is_error: true };
      if (action === "check") return { output: `HTTP 检查通过：${method} ${url}`, is_error: false };
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
        const headers: Record<string, string> = {};
        if (typeof exec["headers"] === "object" && exec["headers"] !== null && !Array.isArray(exec["headers"])) {
          for (const [k, v] of Object.entries(exec["headers"] as Record<string, unknown>)) headers[k] = String(v);
        }
        const body = exec["body"] === undefined ? undefined : JSON.stringify(exec["body"]);
        if (body !== undefined) headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
        const res = await fetch(url, { method, headers, body, signal: controller.signal });
        clearTimeout(timer);
        const text = (await res.text()).slice(0, 4096);
        return {
          output: `HTTP ${res.status} ${res.statusText}\n${text}`,
          is_error: !res.ok,
          duration_ms: Date.now() - started,
        };
      } catch (err) {
        return {
          output: `请求失败: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
          duration_ms: Date.now() - started,
        };
      }
    }

    if (kind === "builtin") {
      return { output: "内置工具不走自定义工具测试接口", is_error: true };
    }
    // script 等其余类型：执行侧延后。
    return {
      output: `执行侧延后：kind=${kind} 的即时测试尚未接线（当前支持 command/http）`,
      is_error: false,
    };
  });
}
