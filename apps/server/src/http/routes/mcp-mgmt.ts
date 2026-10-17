import { McpClient } from "@earendil-works/pi-mcp";
import { createServerTransport } from "../../pi/mcpTransport.js";
// Management probes and pi sessions share the same native MCP client transports.
import type { FastifyInstance } from "fastify";
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

async function connectMcpOnce(cfg: ServerConfig): Promise<DiscoveredMcpTool[]> {
  const client=new McpClient({name:'series-management',version:'1',requestTimeoutMs:CONNECT_TIMEOUT_MS});
  try {
    await client.connect(createServerTransport({...cfg,headers:cfg.env},process.cwd()));
    return (await client.listTools()).map(t=>({name:t.name,description:t.description ?? '',inputSchema:t.inputSchema}));
  } finally { await client.close(); }

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
