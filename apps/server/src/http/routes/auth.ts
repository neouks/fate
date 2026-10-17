// 认证路由：status/init/login/change-password/me。语义对齐 Go server/auth.go。

import type { FastifyInstance } from "fastify";
import {
  AUTH_PASSWORD_KEY,
  currentUser,
  extractToken,
  hashPassword,
  requireJWT,
  signJWT,
  validatePassword,
  verifyJWT,
  verifyPassword,
} from "../auth.js";

export function registerAuthRoutes(app: FastifyInstance, opts: { jwtKey: string }): void {
  const platform = () => app.db.platform();

  // GET /api/auth/status — 管理员口令是否已初始化（未初始化时前端引导去 /setup）。
  app.get("/api/auth/status", async (_req, reply) => {
    try {
      const hash = await platform().getSetting(AUTH_PASSWORD_KEY);
      return { initialized: hash !== null && hash !== "" };
    } catch (err) {
      // 读失败必须 503：把「读不到」伪装成 initialized:false 会把用户推去覆盖已有密码。
      return reply.code(503).send({ error: "数据源暂时不可用，请稍后重试" });
    }
  });

  // POST /api/auth/init — 首次设置口令（已设置 → 403）。
  app.post("/api/auth/init", async (req, reply) => {
    const body = (req.body ?? {}) as { password?: unknown };
    const password = typeof body["password"] === "string" ? body["password"] : "";
    if (password === "") return reply.code(400).send({ error: "密码不能为空" });
    const msg = validatePassword(password);
    if (msg !== "") return reply.code(400).send({ error: msg });
    let hash: string;
    try {
      hash = hashPassword(password);
    } catch {
      return reply.code(500).send({ error: "密码加密失败" });
    }
    // 主键约束兜底「仅首次可设」（与 Go 同型）：并发下后到者 403。
    const inserted = await platform().insertSettingIfAbsent(AUTH_PASSWORD_KEY, hash);
    if (!inserted) return reply.code(403).send({ error: "密码已设置" });
    return { token: signJWT(opts.jwtKey) };
  });

  // POST /api/auth/login — 用户名口令 → JWT。
  app.post("/api/auth/login", async (req, reply) => {
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = typeof body["username"] === "string" ? body["username"] : "";
    const password = typeof body["password"] === "string" ? body["password"] : "";
    if (username !== "SERIES") return reply.code(401).send({ error: "用户名或密码错误" });
    let hash: string | null;
    try {
      hash = await platform().getSetting(AUTH_PASSWORD_KEY);
    } catch {
      return reply.code(503).send({ error: "数据源暂时不可用，请稍后重试" });
    }
    if (hash === null || hash === "") return reply.code(403).send({ error: "密码未初始化，请先设置密码" });
    if (!verifyPassword(password, hash)) return reply.code(401).send({ error: "用户名或密码错误" });
    return { token: signJWT(opts.jwtKey) };
  });

  // POST /api/auth/change-password — 需有效 token + 当前口令（路由在豁免前缀下，自行校验）。
  app.post("/api/auth/change-password", async (req, reply) => {
    if (!verifyJWT(extractToken(req), opts.jwtKey)) return reply.code(401).send({ error: "未授权" });
    const body = (req.body ?? {}) as { old_password?: unknown; new_password?: unknown };
    const oldPw = typeof body["old_password"] === "string" ? body["old_password"] : "";
    const newPw = typeof body["new_password"] === "string" ? body["new_password"] : "";
    if (newPw === "") return reply.code(400).send({ error: "新密码不能为空" });
    const msg = validatePassword(newPw);
    if (msg !== "") return reply.code(400).send({ error: msg });
    let hash: string | null;
    try {
      hash = await platform().getSetting(AUTH_PASSWORD_KEY);
    } catch {
      return reply.code(503).send({ error: "数据源暂时不可用，请稍后重试" });
    }
    if (hash === null || hash === "") return reply.code(403).send({ error: "密码未初始化，请先设置密码" });
    if (!verifyPassword(oldPw, hash)) return reply.code(401).send({ error: "当前密码错误" });
    await platform().setSetting(AUTH_PASSWORD_KEY, hashPassword(newPw));
    return { ok: true };
  });

  // GET /api/auth/me — 当前用户（TS 版新增；前端 use-current-user 的服务端对应物）。
  app.get("/api/auth/me", { preHandler: requireJWT(opts.jwtKey) }, async () => ({ user: currentUser() }));
}
