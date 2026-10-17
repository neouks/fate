// 批次 C4：MCP 管理面——工具发现缓存读取 / refresh（连一次 tools/list 写缓存）/
// test（连通性，不发缓存）/ usage（mcp_usage 计量）。
// 对齐前端 web/src/lib/api.ts 的 mcpTools/refreshMcpServer/testMcpServer/mcpUsage。
//
// 连接实现说明：@earendil-works/pi-mcp 是 pi-coding-agent 的传递依赖，未在
// apps/server/package.json 声明（pnpm 严格布局下不可 import，且本批次不改现有文件）。
// 故按 pi-mcp dist/*.d.ts 的协议面（McpClient: connect → initialize 握手 → listTools；
// StdioTransport = 换行分隔 JSON-RPC；StreamableHttpTransport = POST + 会话头）实现
// 等价的最小客户端：stdio / http(Streamable HTTP) / sse(legacy HTTP+SSE) 三种 transport。
// 待 pi-mcp 进入直接依赖后可整体替换 connectMcpOnce()。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import https from "node:https";
import type { FastifyInstance } from "fastify";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const CONNECT_TIMEOUT_MS = 15_000;

export interface DiscoveredMcpTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

interface ServerConfig {
  transport: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  insecure: boolean;
}

// ─── JSON-RPC 基元 ───────────────────────────────────────────────────────────

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number | string;
  result?: unknown;
  error?: { message?: string };
}

function rpcRequest(id: number, method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
}

function asTools(result: unknown): DiscoveredMcpTool[] {
  const list = (result as { tools?: unknown })?.tools;
  if (!Array.isArray(list)) return [];
  return list
    .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
    .map((t) => ({
      name: String(t["name"] ?? ""),
      description: String(t["description"] ?? ""),
      inputSchema: (t["inputSchema"] as Record<string, unknown>) ?? undefined,
    }))
    .filter((t) => t.name !== "");
}

// ─── stdio transport（换行分隔 JSON-RPC）────────────────────────────────────

async function stdioListTools(cfg: ServerConfig): Promise<DiscoveredMcpTool[]> {
  const child: ChildProcessWithoutNullStreams = spawn(cfg.command, cfg.args, {
    env: { ...process.env, ...cfg.env },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  const pending = new Map<number, (v: JsonRpcResponse) => void>();
  let buffer = "";
  let stderrTail = "";
  let closed: ((err: Error) => void) | null = null;
  const exit = new Promise<never>((_, reject) => {
    closed = reject;
  });
  child.on("error", (err) => closed?.(err));
  child.on("exit", (code) => closed?.(new Error(`MCP 服务器进程退出（code=${code}）${stderrTail ? `: ${stderrTail.slice(-400)}` : ""}`)));
  child.stderr.on("data", (c: Buffer) => {
    stderrTail = (stderrTail + c.toString("utf8")).slice(-2000);
  });
  child.stdout.on("data", (c: Buffer) => {
    buffer += c.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line === "") continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (typeof msg.id === "number") pending.get(msg.id)?.(msg);
    }
  });

  const waitResp = (id: number): Promise<JsonRpcResponse> =>
    new Promise((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => reject(new Error(`等待 JSON-RPC 响应超时（id=${id}）`)), CONNECT_TIMEOUT_MS);
    });

  const send = (line: string): void => {
    child.stdin.write(line + "\n");
  };

  try {
    send(rpcRequest(1, "initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "series-mgmt", version: "0.1.0" },
    }));
    const init = await Promise.race([waitResp(1), exit]);
    if (init.error) throw new Error(`initialize 失败: ${init.error.message ?? "未知错误"}`);
    send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    send(rpcRequest(2, "tools/list", {}));
    const tools = await Promise.race([waitResp(2), exit]);
    if (tools.error) throw new Error(`tools/list 失败: ${tools.error.message ?? "未知错误"}`);
    return asTools(tools.result);
  } finally {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2000).unref();
  }
}

// ─── HTTP(S) 基元（支持 insecure 自签证书）──────────────────────────────────

interface HttpResp {
  status: number;
  contentType: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function httpRequest(
  urlStr: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer | null,
  timeoutMs: number,
  insecure: boolean,
): Promise<HttpResp> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new Error(`无效 URL: ${urlStr}`));
      return;
    }
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
        ...(url.protocol === "https:" && insecure ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers["content-type"] ?? ""),
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`HTTP ${method} 超时（>${timeoutMs}ms）`)));
    if (body) req.end(body);
    else req.end();
  });
}

/** 响应可能是纯 JSON 或 SSE 帧（data: 行）——都解析出 id 匹配的 JSON-RPC 响应。 */
function extractRpcResponse(resp: HttpResp, id: number): JsonRpcResponse | null {
  const text = resp.body.toString("utf8");
  if (resp.contentType.includes("text/event-stream")) {
    for (const block of text.split("\n\n")) {
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          const msg = JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
          if (msg.id === id) return msg;
        } catch {
          /* 跳过非 JSON 帧 */
        }
      }
    }
    return null;
  }
  try {
    const msg = JSON.parse(text) as JsonRpcResponse;
    return msg.id === id ? msg : null;
  } catch {
    return null;
  }
}

// ─── Streamable HTTP transport（POST JSON-RPC；Mcp-Session-Id 会话）─────────

async function streamableHttpListTools(cfg: ServerConfig, urlStr: string): Promise<DiscoveredMcpTool[]> {
  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...cfg.env, // 与 src/index.ts 的映射一致：env 即自定义头（如 X-API-Key）
  };
  const post = async (payload: string): Promise<HttpResp> =>
    httpRequest(urlStr, "POST", baseHeaders, Buffer.from(payload, "utf8"), CONNECT_TIMEOUT_MS, cfg.insecure);

  const initResp = await post(rpcRequest(1, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "series-mgmt", version: "0.1.0" },
  }));
  if (initResp.status >= 400) {
    throw new Error(`initialize HTTP ${initResp.status}: ${initResp.body.toString("utf8").slice(0, 300)}`);
  }
  const init = extractRpcResponse(initResp, 1);
  if (!init || init.error) throw new Error(`initialize 失败: ${init?.error?.message ?? (initResp.body.toString("utf8").slice(0, 300) || "无响应")}`);

  const sessionHeader = initResp.headers["mcp-session-id"];
  if (sessionHeader) {
    baseHeaders["Mcp-Session-Id"] = Array.isArray(sessionHeader) ? sessionHeader[0]! : sessionHeader;
    baseHeaders["Mcp-Protocol-Version"] = MCP_PROTOCOL_VERSION;
  }
  await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));

  const toolsResp = await post(rpcRequest(2, "tools/list", {}));
  if (toolsResp.status >= 400) {
    throw new Error(`tools/list HTTP ${toolsResp.status}: ${toolsResp.body.toString("utf8").slice(0, 300)}`);
  }
  const tools = extractRpcResponse(toolsResp, 2);
  if (!tools || tools.error) throw new Error(`tools/list 失败: ${tools?.error?.message ?? "无响应"}`);
  return asTools(tools.result);
}

// ─── legacy SSE transport（GET 事件流拿 endpoint，请求 POST、响应走流）──────

async function sseListTools(cfg: ServerConfig, urlStr: string): Promise<DiscoveredMcpTool[]> {
  // 打开 GET 事件流并增量解析：`endpoint` 事件给出消息端点；JSON-RPC 响应以
  // `message` 事件（data 为 JSON）回流。请求侧 POST 到端点。
  return new Promise<DiscoveredMcpTool[]>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new Error(`无效 URL: ${urlStr}`));
      return;
    }
    const mod = url.protocol === "https:" ? https : http;
    let buffer = "";
    let endpoint = "";
    let settled = false;
    const finish = (err: Error | null, tools?: DiscoveredMcpTool[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      if (err) reject(err);
      else resolve(tools ?? []);
    };
    const timer = setTimeout(() => finish(new Error(`SSE 连接超时（>${CONNECT_TIMEOUT_MS}ms）`)), CONNECT_TIMEOUT_MS);

    const post = (payload: string): void => {
      const ep = new URL(endpoint);
      const preq = mod.request(
        {
          protocol: ep.protocol,
          hostname: ep.hostname,
          port: ep.port || (ep.protocol === "https:" ? 443 : 80),
          path: ep.pathname + ep.search,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          ...(ep.protocol === "https:" && cfg.insecure ? { rejectUnauthorized: false } : {}),
        },
        (pres) => {
          pres.resume(); // 响应体在 GET 流上；POST 状态码 202/200 均可
          pres.on("error", () => undefined);
        },
      );
      preq.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
      preq.end(payload);
    };

    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "GET",
        headers: { Accept: "text/event-stream", ...cfg.env },
        ...(url.protocol === "https:" && cfg.insecure ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => finish(new Error(`SSE 连接 HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString("utf8").slice(0, 300)}`)));
          return;
        }
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const evName = block.split("\n").find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "message";
            const data = block
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trim())
              .join("\n");
            if (data === "") continue;
            if (evName === "endpoint") {
              endpoint = new URL(data, urlStr).toString();
              post(rpcRequest(1, "initialize", {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: "series-mgmt", version: "0.1.0" },
              }));
              post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
              post(rpcRequest(2, "tools/list", {}));
              continue;
            }
            try {
              const msg = JSON.parse(data) as JsonRpcResponse;
              if (msg.id === 2) {
                if (msg.error) finish(new Error(`tools/list 失败: ${msg.error.message ?? "未知错误"}`));
                else finish(null, asTools(msg.result));
              }
            } catch {
              /* 忽略非 JSON 事件 */
            }
          }
        });
        res.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
        res.on("end", () => finish(new Error("SSE 事件流提前结束（未收到 tools/list 响应）")));
      },
    );
    req.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
    req.end();
  });
}

/** 按 mcp_servers 行连接一次并拉 tools/list。失败抛错（调用方决定 200+error 或 5xx）。 */
async function connectMcpOnce(cfg: ServerConfig): Promise<DiscoveredMcpTool[]> {
  const transport = cfg.transport;
  if (transport === "stdio") {
    if (cfg.command === "") throw new Error("stdio 服务器缺少 command");
    return stdioListTools(cfg);
  }
  if (cfg.url === "") throw new Error(`${transport} 服务器缺少 url`);
  if (transport === "http") return streamableHttpListTools(cfg, cfg.url);
  if (transport === "sse") return sseListTools(cfg, cfg.url);
  throw new Error(`不支持的 transport: ${transport}`);
}

// ─── 路由 ────────────────────────────────────────────────────────────────────

function serverRowToConfig(row: Record<string, unknown>): ServerConfig {
  return {
    transport: String(row["transport"] ?? "stdio"),
    command: String(row["command"] ?? ""),
    args: Array.isArray(row["args"]) ? (row["args"] as unknown[]).map(String) : [],
    env: (typeof row["env"] === "object" && row["env"] !== null && !Array.isArray(row["env"])
      ? Object.fromEntries(Object.entries(row["env"] as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : {}) as Record<string, string>,
    url: String(row["url"] ?? ""),
    insecure: row["insecure"] === true,
  };
}

export function registerMcpMgmtRoutes(app: FastifyInstance): void {
  const db = () => app.db;

  async function mcpRow(id: number): Promise<Record<string, unknown> | null> {
    const res = await db().query(`SELECT * FROM mcp_servers WHERE id=$1`, [id]);
    return res.rows[0] ?? null;
  }

  const cachedTools = async (id: number): Promise<{ name: string; description: string }[]> => {
    const res = await db().query(
      `SELECT tool_name, COALESCE(description,'') AS description FROM mcp_tools_cache WHERE server_id=$1 ORDER BY tool_name`,
      [id],
    );
    return res.rows.map((r) => ({ name: String(r["tool_name"]), description: String(r["description"]) }));
  };

  /** 拉一次 tools/list 并整表替换缓存（事务）。 */
  async function refreshCache(id: number, tools: DiscoveredMcpTool[]): Promise<void> {
    const client = await db().pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM mcp_tools_cache WHERE server_id=$1`, [id]);
      for (const t of tools) {
        await client.query(
          `INSERT INTO mcp_tools_cache(server_id, tool_name, description, schema) VALUES ($1,$2,$3,$4::jsonb)
           ON CONFLICT (server_id, tool_name) DO UPDATE SET description=EXCLUDED.description, schema=EXCLUDED.schema, discovered_at=now()`,
          [id, t.name, t.description, JSON.stringify(t.inputSchema ?? {})],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // GET /api/mcp/:id/tools — 缓存行（表空/未发现 → {tools:[]}）。
  app.get("/api/mcp/:id/tools", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!(await mcpRow(id))) return reply.code(404).send({ error: "MCP 服务器不存在" });
    return { tools: await cachedTools(id) };
  });

  // POST /api/mcp/:id/refresh — 连一次拉 tools/list 写缓存；连接失败 200 {tools:[],error}。
  app.post("/api/mcp/:id/refresh", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = await mcpRow(id);
    if (!row) return reply.code(404).send({ error: "MCP 服务器不存在" });
    try {
      const tools = await connectMcpOnce(serverRowToConfig(row));
      await refreshCache(id, tools);
      return { tools: tools.map((t) => ({ name: t.name, description: t.description })) };
    } catch (err) {
      return { tools: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  // GET /api/mcp/:id/test — 按 id 连通性测试（只测不发缓存）。
  app.get("/api/mcp/:id/test", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = await mcpRow(id);
    if (!row) return reply.code(404).send({ error: "MCP 服务器不存在" });
    const started = Date.now();
    try {
      const tools = await connectMcpOnce(serverRowToConfig(row));
      return {
        ok: true,
        tool_count: tools.length,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
        latency_ms: Date.now() - started,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), latency_ms: Date.now() - started };
    }
  });

  // POST /api/mcp/test — 前端真实调用：按 body 配置连通性测试（未保存也可测）。
  app.post("/api/mcp/test", async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const started = Date.now();
    const cfg: ServerConfig = {
      transport: String(b["transport"] ?? "stdio"),
      command: typeof b["command"] === "string" ? b["command"] : "",
      args: Array.isArray(b["args"]) ? b["args"].map(String) : [],
      env: (typeof b["env"] === "object" && b["env"] !== null && !Array.isArray(b["env"])
        ? Object.fromEntries(Object.entries(b["env"] as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
        : {}) as Record<string, string>,
      url: typeof b["url"] === "string" ? b["url"] : "",
      insecure: b["insecure"] === true,
    };
    try {
      const tools = await connectMcpOnce(cfg);
      return {
        ok: true,
        tool_count: tools.length,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
        latency_ms: Date.now() - started,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), latency_ms: Date.now() - started };
    }
  });

  // GET /api/mcp/:id/usage — mcp_usage 计量（stats 按工具聚合 + 最近调用明细）。
  app.get("/api/mcp/:id/usage", async (req) => {
    const id = Number((req.params as { id: string }).id);
    const q = req.query as Record<string, string>;
    const limit = Math.min(Math.max(Number(q["limit"]) || 50, 1), 500);
    const stats = await db().query(
      `SELECT COALESCE(server_id,$1) AS server_id, COALESCE(NULLIF(server_name,''),'#'||$1::text) AS server_name, tool_name,
              count(*) AS calls, count(DISTINCT task_id) AS tasks,
              array_agg(DISTINCT agent_key) FILTER (WHERE agent_key IS NOT NULL AND agent_key<>'') AS agents,
              max(ts) AS last_used
       FROM mcp_usage WHERE server_id=$1 GROUP BY COALESCE(server_id,$1), COALESCE(NULLIF(server_name,''),'#'||$1::text), tool_name
       ORDER BY count(*) DESC`,
      [id],
    );
    const calls = await db().query(
      `SELECT ts, tool_name, COALESCE(agent_key,'') AS agent_key, COALESCE(task_id,0) AS task_id,
              COALESCE(session_id,'') AS session_id
       FROM mcp_usage WHERE server_id=$1 ORDER BY ts DESC LIMIT $2`,
      [id, limit],
    );
    return {
      stats: stats.rows.map((r) => ({
        server_id: Number(r["server_id"]),
        server_name: String(r["server_name"]),
        tool_name: String(r["tool_name"]),
        calls: Number(r["calls"] ?? 0),
        tasks: Number(r["tasks"] ?? 0),
        agents: Array.isArray(r["agents"]) ? (r["agents"] as string[]).map(String) : [],
        ...(r["last_used"]
          ? { last_used: r["last_used"] instanceof Date ? (r["last_used"] as Date).toISOString() : String(r["last_used"]) }
          : {}),
      })),
      calls: calls.rows.map((r) => ({
        ts: r["ts"] instanceof Date ? (r["ts"] as Date).toISOString() : String(r["ts"] ?? ""),
        tool_name: String(r["tool_name"]),
        agent_key: String(r["agent_key"]),
        task_id: Number(r["task_id"] ?? 0),
        session_id: String(r["session_id"]),
      })),
    };
  });
}
