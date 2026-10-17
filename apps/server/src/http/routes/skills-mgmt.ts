// 批次 C2：skills 管理面（文件树读写/上传解包/目录/用量/缺口）+ 可见性（MCP 资源 + Skill）。
// 对齐前端 web/src/lib/api.ts 的 skills 方法族：skillFiles/readSkillFile/writeSkillFile/
// deleteSkillPath/createSkillDir/uploadSkill/skillUsage/missingSkills/deleteSkill/updateSkillMeta/
// createSkill，以及 getAgentVisibility/setAgentVisibility/resourceVisibility/toggleVisibility/
// skillVisibility/toggleSkillVisibility。
// GET /api/skills 与 POST /api/skills/file 已由 routes/config.ts 提供，此处不重复注册。
// 可见性落库表：agent_visibility（mcp 资源，schema §G）与 agent_skill_visibility（skill 按名）。

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { FastifyInstance } from "fastify";

// ─── 路径安全 ────────────────────────────────────────────────────────────────

/** 解析 rel 到 root 内；越界（../、绝对路径）→ error。root 本身允许（目录操作）。 */
function resolveWithin(
  root: string,
  rel: string,
): { ok: true; abs: string } | { ok: false; error: string } {
  const rootAbs = path.resolve(root);
  if (rel.includes("\0") || rel.includes("\\")) return { ok: false, error: "非法路径" };
  const abs = path.resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return { ok: false, error: "路径越界" };
  return { ok: true, abs };
}

/** 递归列出目录内文件（相对 root；跳过 node_modules/.git，深度<=6，数量<=1000）。 */
function listFiles(dir: string, root: string, depth = 0, out: string[] = []): string[] {
  if (depth > 6 || out.length > 1000) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, root, depth + 1, out);
    else if (e.isFile()) out.push(path.relative(root, p).split(path.sep).join("/"));
  }
  return out;
}

// ─── SKILL.md frontmatter ────────────────────────────────────────────────────

function parseFrontmatter(md: string): { fm: Record<string, string>; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: md };
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) fm[kv[1]!] = kv[2]!.trim();
  }
  return { fm, body: md.slice(m[0].length) };
}

function buildSkillMd(fm: Record<string, string>, body: string): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (v === "") continue;
    lines.push(`${k}: ${v.includes("\n") ? JSON.stringify(v) : v}`);
  }
  lines.push("---", "", body.trim() === "" ? `# ${fm["name"] ?? "skill"}` : body.trim(), "");
  return lines.join("\n");
}

function skillNameOK(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) && name !== "." && name !== "..";
}

// ─── ZIP（最小读取器：EOCD → 中央目录 → 本地头；stored + deflate）───────────

interface ZipEntry {
  name: string;
  isDir: boolean;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const MAX_ZIP_ENTRIES = 500;
const MAX_ZIP_TOTAL_BYTES = 20 * 1024 * 1024;

function readZipEntries(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip 缺少结束目录（EOCD），不是有效的 zip 文件");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw new Error("zip 中央目录损坏");
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const uncompressedSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localHeaderOffset = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    entries.push({ name, isDir: name.endsWith("/"), method, compressedSize, uncompressedSize, localHeaderOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractZipEntry(buf: Buffer, entry: ZipEntry, capBytes: number): Buffer {
  const o = entry.localHeaderOffset;
  if (o + 30 > buf.length || buf.readUInt32LE(o) !== 0x04034b50) throw new Error(`zip 本地头损坏: ${entry.name}`);
  const nameLen = buf.readUInt16LE(o + 26);
  const extraLen = buf.readUInt16LE(o + 28);
  const dataStart = o + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: capBytes });
  throw new Error(`不支持的压缩方法 ${entry.method}: ${entry.name}`);
}

/** zip 条目名归一化：拒绝 ../ 与绝对路径；剥掉 ./ 前缀。 */
function cleanEntryName(name: string): string | null {
  const t = name.replace(/\\/g, "/").trim();
  if (t === "" || t.includes("\0") || t.startsWith("/")) return null;
  const segs = t.split("/").filter((s) => s !== "." && s !== "");
  if (segs.length === 0 || segs.includes("..")) return null;
  return segs.join("/");
}

// ─── multipart/form-data（最小解析：只取 filename 的文件段）──────────────────

function parseMultipartFile(buffer: Buffer, contentType: string | undefined): { filename: string; data: Buffer } | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? "");
  const boundary = (m?.[1] ?? m?.[2] ?? "").trim();
  if (boundary === "") return null;
  const delim = Buffer.from(`--${boundary}`);
  let pos = buffer.indexOf(delim);
  while (pos !== -1) {
    let start = pos + delim.length;
    if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break; // 终界 --
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;
    else if (buffer[start] === 0x0a) start += 1;
    const next = buffer.indexOf(delim, start);
    if (next === -1) break;
    let end = next;
    if (end >= start + 2 && buffer[end - 2] === 0x0d && buffer[end - 1] === 0x0a) end -= 2;
    const part = buffer.subarray(start, end);
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString("utf8");
      const fm = /filename="([^"]*)"/i.exec(headers);
      if (fm && fm[1] !== "") return { filename: fm[1]!, data: Buffer.from(part.subarray(headerEnd + 4)) };
    }
    pos = next;
  }
  return null;
}

// ─── 路由 ────────────────────────────────────────────────────────────────────

export function registerSkillMgmtRoutes(app: FastifyInstance): void {
  const db = () => app.db;
  const root = () => app.skillsRoot;

  // Fastify 默认不解析 multipart：收原始 buffer，由上面的小解析器处理（仅取文件段）。
  app.addContentTypeParser(
    "multipart/form-data",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  /** skill 目录内读写目标（name + rel 双层校验）。 */
  function skillPath(name: string, rel: string): { ok: true; abs: string } | { ok: false; error: string } {
    if (!skillNameOK(name)) return { ok: false, error: "非法 skill 名称" };
    const r = resolveWithin(path.join(root(), name), rel);
    if (!r.ok) return r;
    if (r.abs === path.resolve(path.join(root(), name))) return { ok: false, error: "不能操作 skill 根目录本身" };
    return r;
  }

  function skillExists(name: string): boolean {
    try {
      return statSync(path.join(root(), name)).isDirectory();
    } catch {
      return false;
    }
  }

  // ─── skill 创建 / 删除 / 元数据 ────────────────────────────────────────────

  app.post("/api/skills", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b["name"] === "string" ? b["name"].trim() : "";
    const description = typeof b["description"] === "string" ? b["description"].trim() : "";
    if (!skillNameOK(name)) return reply.code(400).send({ error: "name 仅限字母数字/./_/- 且不以符号开头" });
    if (description === "") return reply.code(400).send({ error: "description 不能为空" });
    if (skillExists(name)) return reply.code(409).send({ error: `skill ${name} 已存在` });
    const fm: Record<string, string> = { name, description };
    if (typeof b["license"] === "string" && b["license"] !== "") fm["license"] = b["license"];
    if (typeof b["compatibility"] === "string" && b["compatibility"] !== "") fm["compatibility"] = b["compatibility"];
    const mcps = Array.isArray(b["mcps"]) ? b["mcps"].map(String).filter((s) => s !== "") : [];
    if (mcps.length > 0) fm["mcps"] = JSON.stringify(mcps);
    const dir = path.join(root(), name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), buildSkillMd(fm, typeof b["instructions"] === "string" ? b["instructions"] : ""));
    return reply.code(201).send({ name });
  });

  app.delete("/api/skills/:name", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!skillNameOK(name)) return reply.code(400).send({ error: "非法 skill 名称" });
    const r = resolveWithin(root(), name);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    if (!skillExists(name)) return reply.code(404).send({ error: `skill ${name} 不存在` });
    rmSync(r.abs, { recursive: true, force: true });
    return { deleted: name };
  });

  app.put("/api/skills/:name/meta", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!skillExists(name)) return reply.code(404).send({ error: `skill ${name} 不存在` });
    const skillMd = path.join(root(), name, "SKILL.md");
    let md = "";
    try {
      md = readFileSync(skillMd, "utf8");
    } catch {
      return reply.code(404).send({ error: "缺少 SKILL.md" });
    }
    const { fm, body } = parseFrontmatter(md);
    fm["name"] = fm["name"] ?? name;
    if (typeof b["description"] === "string" && b["description"].trim() !== "") fm["description"] = b["description"].trim();
    if (typeof b["license"] === "string") fm["license"] = b["license"].trim();
    if (typeof b["compatibility"] === "string") fm["compatibility"] = b["compatibility"].trim();
    if (Array.isArray(b["mcps"])) fm["mcps"] = JSON.stringify(b["mcps"].map(String).filter((s) => s !== ""));
    writeFileSync(skillMd, buildSkillMd(fm, body));
    return { ok: true };
  });

  // ─── zip 上传安装 ─────────────────────────────────────────────────────────

  app.post("/api/skills/upload", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const overwrite = q["overwrite"] === "true" || q["overwrite"] === "1";
    const file = parseMultipartFile(req.body as Buffer, req.headers["content-type"]);
    if (!file) return reply.code(400).send({ error: "缺少上传文件（multipart file 字段）" });
    if (!/\.zip$/i.test(file.filename)) return reply.code(400).send({ error: "仅支持 .zip 上传" });

    let entries: ZipEntry[];
    try {
      entries = readZipEntries(file.data);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    if (entries.length > MAX_ZIP_ENTRIES) return reply.code(400).send({ error: `zip 条目过多（>${MAX_ZIP_ENTRIES}）` });
    const fileEntries = entries.filter((e) => !e.isDir);
    const totalBytes = fileEntries.reduce((s, e) => s + e.uncompressedSize, 0);
    if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
      return reply.code(400).send({ error: `解压后总体积超限（>${MAX_ZIP_TOTAL_BYTES / 1024 / 1024}MB）` });
    }

    // 清洗条目名并确定 skill 根：单一顶层目录（内含 SKILL.md）→ 用它；根级 SKILL.md → 用 zip 文件名。
    const cleaned = new Map<string, ZipEntry>();
    for (const e of fileEntries) {
      const n = cleanEntryName(e.name);
      if (n === null) return reply.code(400).send({ error: `zip 条目路径非法: ${e.name}` });
      cleaned.set(n, e);
    }
    const names = [...cleaned.keys()];
    const tops = new Set(names.map((n) => n.split("/")[0]!));
    let skillName: string;
    let strip = 0;
    if (tops.size === 1 && cleaned.has(`${[...tops][0]}/SKILL.md`)) {
      skillName = [...tops][0]!;
      strip = 1;
    } else if (cleaned.has("SKILL.md")) {
      skillName = file.filename.replace(/\.zip$/i, "").trim();
    } else {
      return reply.code(400).send({ error: "zip 内缺少 SKILL.md（应在根目录或唯一顶层目录下）" });
    }
    if (!skillNameOK(skillName)) {
      return reply.code(400).send({ error: `skill 名称非法: ${skillName}（仅字母数字/./_/-）` });
    }
    const target = path.join(root(), skillName);
    if (existsSync(target) && !overwrite) return reply.code(409).send({ error: `skill ${skillName} 已存在` });

    let written = 0;
    let budget = MAX_ZIP_TOTAL_BYTES;
    for (const [n, e] of cleaned) {
      const rel = strip > 0 ? n.split("/").slice(strip).join("/") : n;
      if (rel === "") continue;
      const r = resolveWithin(target, rel);
      if (!r.ok) return reply.code(400).send({ error: `zip 条目路径越界: ${e.name}` });
      mkdirSync(path.dirname(r.abs), { recursive: true });
      let data: Buffer;
      try {
        data = extractZipEntry(file.data, e, budget + 1);
      } catch (err) {
        return reply.code(400).send({ error: `解压失败 (${e.name}): ${err instanceof Error ? err.message : String(err)}` });
      }
      budget -= data.length;
      if (budget < 0) return reply.code(400).send({ error: "解压后总体积超限（>20MB）" });
      writeFileSync(r.abs, data);
      written += 1;
    }
    if (!existsSync(path.join(target, "SKILL.md"))) {
      rmSync(target, { recursive: true, force: true });
      return reply.code(400).send({ error: "缺少 SKILL.md" });
    }
    return { name: skillName, files: written };
  });

  // ─── 文件树读写 ───────────────────────────────────────────────────────────

  app.post("/api/skills/:skill/dirs", async (req, reply) => {
    const skill = (req.params as { skill: string }).skill;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const rel = typeof b["path"] === "string" ? b["path"].replace(/^\/+|\/+$/g, "") : "";
    if (rel === "") return reply.code(400).send({ error: "path 不能为空" });
    const r = skillPath(skill, rel);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    mkdirSync(r.abs, { recursive: true });
    return { dir: rel };
  });

  app.get("/api/skills/:name/files", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!skillExists(name)) return reply.code(404).send({ error: `skill ${name} 不存在` });
    return { files: listFiles(path.join(root(), name), path.join(root(), name)) };
  });

  app.get("/api/skills/:name/files/*", async (req, reply) => {
    const p = req.params as { name: string; "*": string };
    const r = skillPath(p["name"], p["*"]);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    try {
      const content = readFileSync(r.abs, "utf8");
      return { content, file: p["*"] };
    } catch {
      return reply.code(404).send({ error: "文件不存在" });
    }
  });

  app.put("/api/skills/:name/files/*", async (req, reply) => {
    const p = req.params as { name: string; "*": string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b["content"] !== "string") return reply.code(400).send({ error: "content 必须是字符串" });
    const r = skillPath(p["name"], p["*"]);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    mkdirSync(path.dirname(r.abs), { recursive: true });
    writeFileSync(r.abs, b["content"]);
    return { ok: true };
  });

  app.delete("/api/skills/:skill/files/*", async (req, reply) => {
    const p = req.params as { skill: string; "*": string };
    const r = skillPath(p["skill"], p["*"]);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    if (!existsSync(r.abs)) return reply.code(404).send({ error: "路径不存在" });
    rmSync(r.abs, { recursive: true, force: true });
    return { deleted: p["*"] };
  });

  // ─── 用量 / 缺口（skill_usage 账本）────────────────────────────────────────

  app.get("/api/skills/:name/usage", async (req) => {
    const name = (req.params as { name: string }).name;
    const q = req.query as Record<string, string>;
    const limit = Math.min(Math.max(Number(q["limit"]) || 50, 1), 500);
    const res = await db().query(
      `SELECT ts, COALESCE(agent_key,'') AS agent_key, COALESCE(task_id,0) AS task_id,
              COALESCE(session_id,'') AS session_id, args_len
       FROM skill_usage WHERE skill=$1 AND found=true ORDER BY ts DESC LIMIT $2`,
      [name, limit],
    );
    return {
      calls: res.rows.map((r) => ({
        ts: r["ts"] instanceof Date ? (r["ts"] as Date).toISOString() : String(r["ts"] ?? ""),
        agent_key: String(r["agent_key"]),
        task_id: Number(r["task_id"] ?? 0),
        session_id: String(r["session_id"]),
        args_len: Number(r["args_len"] ?? 0),
      })),
    };
  });

  app.get("/api/skills/missing", async (req) => {
    const q = req.query as Record<string, string>;
    const limit = Math.min(Math.max(Number(q["limit"]) || 20, 1), 200);
    const res = await db().query(
      `SELECT skill, count(*) AS calls, array_agg(DISTINCT agent_key) FILTER (WHERE agent_key IS NOT NULL AND agent_key<>'') AS agents,
              max(ts) AS last_used
       FROM skill_usage WHERE found=false GROUP BY skill ORDER BY count(*) DESC LIMIT $1`,
      [limit],
    );
    // 已在 skills 目录里的不算缺口（曾缺失、后来补上了）。
    let present = new Set<string>();
    try {
      present = new Set(readdirSync(root()).filter((n) => statSync(path.join(root(), n)).isDirectory()));
    } catch {
      /* 空集 */
    }
    return {
      missing: res.rows
        .filter((r) => !present.has(String(r["skill"])))
        .map((r) => ({
          skill: String(r["skill"]),
          calls: Number(r["calls"] ?? 0),
          agents: Array.isArray(r["agents"]) ? (r["agents"] as string[]).map(String) : [],
          ...(r["last_used"]
            ? { last_used: r["last_used"] instanceof Date ? (r["last_used"] as Date).toISOString() : String(r["last_used"]) }
            : {}),
        })),
    };
  });

  // ─── 可见性：agent 视角（GET/PUT /api/agents/:key/visibility）───────────────

  app.get("/api/agents/:key/visibility", async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const agent = await db().platform().getAgentByKey(key);
    if (!agent) return reply.code(404).send({ error: `agent ${key} 不存在` });
    const [mcp, skill] = await Promise.all([
      db().query<{ resource_id: number }>(
        `SELECT resource_id FROM agent_visibility WHERE agent_id=$1 AND resource_kind='mcp' AND mcp_tool_name='' AND enabled`,
        [agent.id],
      ),
      db().query<{ skill_name: string }>(
        `SELECT skill_name FROM agent_skill_visibility WHERE agent_id=$1 AND enabled`,
        [agent.id],
      ),
    ]);
    return {
      mcp: mcp.rows.map((r) => Number(r.resource_id)),
      skill: skill.rows.map((r) => r.skill_name),
    };
  });

  app.put("/api/agents/:key/visibility", async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const agent = await db().platform().getAgentByKey(key);
    if (!agent) return reply.code(404).send({ error: `agent ${key} 不存在` });
    const mcp = Array.isArray(b["mcp"]) ? [...new Set(b["mcp"].map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))] : [];
    const skill = Array.isArray(b["skill"])
      ? [...new Set(b["skill"].map((v) => String(v)).filter((s) => s !== ""))]
      : [];
    const client = await db().pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM agent_visibility WHERE agent_id=$1 AND resource_kind='mcp' AND mcp_tool_name=''`, [agent.id]);
      await client.query(`DELETE FROM agent_skill_visibility WHERE agent_id=$1`, [agent.id]);
      for (const id of mcp) {
        await client.query(
          `INSERT INTO agent_visibility(agent_id, resource_kind, resource_id, mcp_tool_name, enabled)
           VALUES ($1,'mcp',$2,'',true) ON CONFLICT (agent_id, resource_kind, resource_id, mcp_tool_name) DO UPDATE SET enabled=true`,
          [agent.id, id],
        );
      }
      for (const name of skill) {
        await client.query(
          `INSERT INTO agent_skill_visibility(agent_id, skill_name, enabled) VALUES ($1,$2,true)
           ON CONFLICT (agent_id, skill_name) DO UPDATE SET enabled=true`,
          [agent.id, name],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return { ok: true };
  });

  // ─── 可见性：资源视角（MCP 按 id / Skill 按名 + toggle）────────────────────

  app.get("/api/visibility/:kind/:id", async (req, reply) => {
    const p = req.params as { kind: string; id: string };
    if (p["kind"] !== "mcp") return reply.code(400).send({ error: "kind 仅支持 mcp" });
    const res = await db().query<{ key: string }>(
      `SELECT a.key FROM agent_visibility v JOIN agents a ON a.id=v.agent_id
       WHERE v.resource_kind='mcp' AND v.resource_id=$1 AND v.mcp_tool_name='' AND v.enabled ORDER BY a.key`,
      [Number(p["id"])],
    );
    return { agents: res.rows.map((r) => r.key) };
  });

  app.post("/api/visibility/toggle", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const agentID = String(b["agent_id"] ?? "");
    const kind = String(b["kind"] ?? "");
    const resourceID = Number(b["resource_id"]);
    const visible = b["visible"] === true;
    if (kind !== "mcp" || !Number.isInteger(resourceID) || resourceID <= 0) {
      return reply.code(400).send({ error: "kind 仅支持 mcp 且 resource_id 必须为正整数" });
    }
    const agent = await db().platform().getAgentByKey(agentID);
    if (!agent) return reply.code(404).send({ error: `agent ${agentID} 不存在` });
    await db().query(
      `INSERT INTO agent_visibility(agent_id, resource_kind, resource_id, mcp_tool_name, enabled)
       VALUES ($1,'mcp',$2,'',$3)
       ON CONFLICT (agent_id, resource_kind, resource_id, mcp_tool_name) DO UPDATE SET enabled=EXCLUDED.enabled`,
      [agent.id, resourceID, visible],
    );
    return { ok: true };
  });

  app.get("/api/visibility/skill/:name", async (req) => {
    const name = (req.params as { name: string }).name;
    const res = await db().query<{ key: string }>(
      `SELECT a.key FROM agent_skill_visibility v JOIN agents a ON a.id=v.agent_id
       WHERE v.skill_name=$1 AND v.enabled ORDER BY a.key`,
      [name],
    );
    return { agents: res.rows.map((r) => r.key) };
  });

  app.post("/api/visibility/skill/toggle", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const agentID = String(b["agent_id"] ?? "");
    const skillName = String(b["skill_name"] ?? "");
    const visible = b["visible"] === true;
    if (skillName === "") return reply.code(400).send({ error: "skill_name 不能为空" });
    const agent = await db().platform().getAgentByKey(agentID);
    if (!agent) return reply.code(404).send({ error: `agent ${agentID} 不存在` });
    await db().query(
      `INSERT INTO agent_skill_visibility(agent_id, skill_name, enabled) VALUES ($1,$2,$3)
       ON CONFLICT (agent_id, skill_name) DO UPDATE SET enabled=EXCLUDED.enabled`,
      [agent.id, skillName, visible],
    );
    return { ok: true };
  });
}
