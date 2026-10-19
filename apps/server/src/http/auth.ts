// 认证：JWT HS256 签发/校验 + 管理员口令（bcrypt，与 Go 版 server/auth.go 同一存储键与哈希格式）。
// - data/jwt.key：与 Go 版共用同一份 HMAC 密钥（>=32 字符文本，签名取 trim 后的字节），
//   令牌互认：Go 签发的 token 在 TS 校验通过，反之亦然。
// - claims：{sub:"SERIES", iat, exp}（exp 为 unix 秒），TTL 7 天。
// - 口令哈希存 settings 键 auth.password_hash（bcrypt，cost 10）。

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import type { FastifyReply, FastifyRequest } from "fastify";

export const AUTH_PASSWORD_KEY = "auth.password_hash";
export const JWT_TTL_SECONDS = 7 * 24 * 3600;
const JWT_KEY_FILENAME = "jwt.key";
const KEY_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const MIN_PASSWORD_RUNES = 8;
const MAX_PASSWORD_BYTES = 72;

/** 与 Go 版 loadOrCreateJWTKey 同构：keyDir/jwt.key；旧位置（dataDir 内）存在则迁移。 */
export function loadOrCreateJWTKey(keyDir: string, dataDir: string): string {
  const keyPath = path.join(keyDir, JWT_KEY_FILENAME);
  const legacy = path.join(dataDir, JWT_KEY_FILENAME);
  if (legacy !== keyPath && !existsSync(keyPath) && existsSync(legacy)) {
    try {
      const data = readFileSync(legacy, "utf8");
      writeFileSync(keyPath, data, { mode: 0o600 });
    } catch {
      /* best-effort 迁移 */
    }
  }
  try {
    const existing = readFileSync(keyPath, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* 不存在或读失败 → 生成 */
  }
  let key = "";
  for (let i = 0; i < 32; i++) key += KEY_CHARS[randomInt(KEY_CHARS.length)]!;
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

// ─── JWT（HS256，与 Go golang-jwt/v5 的 RegisteredClaims 序列化一致）─────────

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** 签发 7 天 HS256 token（sub=SERIES）。 */
export function signJWT(key: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ sub: "SERIES", iat: now, exp: now + JWT_TTL_SECONDS }));
  const signingInput = `${header}.${claims}`;
  const sig = createHmac("sha256", key).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

/** 校验签名/算法/sub/有效期；任何失败返回 false（不区分原因，防侧信道）。 */
export function verifyJWT(token: string, key: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [header, claims, sig] = parts as [string, string, string];
  let h: { alg?: unknown };
  let c: { sub?: unknown; exp?: unknown };
  try {
    h = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { alg?: unknown };
    c = JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as { sub?: unknown; exp?: unknown };
  } catch {
    return false;
  }
  if (h["alg"] !== "HS256") return false;
  if (c["sub"] !== "SERIES") return false;
  const exp = Number(c["exp"]);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) return false;
  const expected = createHmac("sha256", key).update(`${header}.${claims}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// ─── 口令（bcrypt，存储/校验与 Go 版同键同格式）──────────────────────────────

/** 校验口令强度；空串=通过，否则为可直接展示的中文原因（对齐 Go validatePassword）。 */
export function validatePassword(pw: string): string {
  if ([...pw].length < MIN_PASSWORD_RUNES) return `密码长度至少 ${MIN_PASSWORD_RUNES} 位`;
  if (Buffer.byteLength(pw, "utf8") > MAX_PASSWORD_BYTES) return `密码长度不能超过 ${MAX_PASSWORD_BYTES} 字节`;
  return "";
}

export function hashPassword(pw: string): string {
  return bcrypt.hashSync(pw, 10);
}

export function verifyPassword(pw: string, hash: string): boolean {
  try {
    return bcrypt.compareSync(pw, hash);
  } catch {
    return false;
  }
}

// ─── 请求侧 token 提取（Bearer / X-Series-Token / cookie / SSE query）────────

function cookieValue(req: FastifyRequest, name: string): string | null {
  const raw = req.headers["cookie"];
  if (!raw) return null;
  for (const part of (Array.isArray(raw) ? raw.join("; ") : raw).split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

export function extractToken(req: FastifyRequest): string {
  const auth = req.headers["authorization"];
  if (auth) {
    const [scheme, ...rest] = (Array.isArray(auth) ? auth[0]! : auth).split(" ");
    if (scheme?.toLowerCase() === "bearer") return rest.join(" ").trim();
  }
  const xs = req.headers["x-series-token"];
  if (xs) return Array.isArray(xs) ? xs[0] ?? "" : xs;
  // EventSource cannot set an Authorization header. Its explicit token must
  // take precedence over a cookie from another app on the same hostname/port.
  const q = req.query as Record<string, unknown> | null;
  const t = q?.["token"];
  if (typeof t === "string" && t) return t;
  return cookieValue(req, "series_token") ?? "";
}

/** JWT 鉴权：通过后放行；失败 401（文案对齐 Go requireAuth）。 */
export function requireJWT(key: string): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req, reply) => {
    const tok = extractToken(req);
    if (tok === "") {
      await reply.code(401).send({ error: "未授权" });
      return;
    }
    if (!verifyJWT(tok, key)) {
      await reply.code(401).send({ error: "token 无效或已过期" });
      return;
    }
  };
}

/** 供 /api/auth/me 等返回当前用户（单用户系统，token sub 恒为 SERIES）。 */
export function currentUser(): Record<string, string> {
  return { id: "1", name: "SERIES", username: "series", email: "", avatar: "", role: "operator" };
}
