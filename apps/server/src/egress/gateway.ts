// 瘦身出口网关（M6）：任务 scope → 网络出口授权。
//
// 替代已删除的 MITM 流量录制：Node 原生 http 服务器，零额外依赖。
// - HTTP CONNECT 隧道：解析 host:port → 鉴权（Proxy-Authorization 里的签名任务标签）→
//   授权校验（worker 口径，pending 可放行）→ net.connect 上游原样管道转发；拒绝时 403 + 短文案
// - 普通 HTTP 代理请求（绝对 URI）：校验 Host → http.request 转发（保持方法/头/体）→ 回写响应；
//   Proxy-Authorization 里的内部凭据在转发前删除，绝不能到目标
// - HTTPS 不解密（无 MITM、无 CA、无录制）——只做 CONNECT 级 allowlist
//
// 未带（或非 series-task-）凭据的流量直接放行：独立聊天/enrich/UI 不打标——与 Go 版
// traffic.authorizeTaskRequest 的未打标分支一致；此处仅 console.debug 留痕。

import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { Database } from "../db/index.js";
import { stripHostPort } from "../db/task_scope.js";
import { parseAndVerify } from "./credentials.js";

/** 请求放行/拒绝判定结果。 */
type GateDecision = { allowed: true } | { allowed: false; status: number; message: string };

/**
 * 任务级出口授权（Go traffic.authorizeTaskRequest 的打标分支）：
 * strip 端口 → validateWorkerHosts（worker 口径：approved 或 pending 均放行）；
 * 校验失败 rememberTaskAssetDenials 记忆（忽略记忆错误本身）后抛出带文案的错误。
 */
export async function authorizeTaskRequest(db: Database, taskID: number, host: string): Promise<void> {
  const bare = stripHostPort(host);
  try {
    await db.taskScope().validateWorkerHosts(taskID, [bare]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .taskScope()
      .rememberTaskAssetDenials(taskID, [bare], [])
      .catch(() => undefined);
    throw new Error(`任务资产执行被阻止: ${msg}`);
  }
}

/** 每请求鉴权 + 授权门：未打标放行（debug 留痕），打标无效/未授权拒绝。 */
async function gateRequest(
  db: Database,
  proxyAuthorization: string | undefined,
  host: string,
): Promise<GateDecision> {
  let parsed;
  try {
    parsed = parseAndVerify(proxyAuthorization);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { allowed: false, status: 403, message: `任务代理凭据无效: ${msg}` };
  }
  if (!parsed.tagged) {
    console.debug(`[egress] 未打标流量直接放行: ${host}`);
    return { allowed: true };
  }
  try {
    await authorizeTaskRequest(db, parsed.taskID, host);
    return { allowed: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      allowed: false,
      status: 403,
      message: `${msg}。跳过本项资源，继续其他已授权测试，不要重试该地址。`,
    };
  }
}

/** CONNECT authority（host:port / [v6]:port）→ { host, port }；解析失败返回 null。 */
function parseAuthority(authority: string): { host: string; port: number } | null {
  const m = authority.match(/^\[([0-9a-fA-F:.]+)\]:(\d+)$/) ?? authority.match(/^([^:]+):(\d+)$/);
  if (!m) return null;
  const port = Number.parseInt(m[2]!, 10);
  if (!(port > 0) || port > 65535) return null;
  return { host: m[1]!, port };
}

/** 内部凭据绝不能到目标：转发前删除代理层头 + 逐跳头。 */
function sanitizeOutgoingHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: Record<string, string | string[] | undefined> = { ...headers };
  for (const h of ["proxy-authorization", "proxy-connection", "connection", "keep-alive", "upgrade", "te", "trailer"]) {
    delete out[h];
  }
  return out;
}

/** CONNECT 隧道：鉴权 → net.connect 上游 → 双向原样管道。 */
function handleConnect(db: Database, req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): void {
  const fail = (status: number, message: string) => {
    const body = Buffer.from(message, "utf8");
    clientSocket.end(
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Forbidden"}\r\n` +
        `Content-Type: text/plain; charset=utf-8\r\n` +
        `Content-Length: ${body.length}\r\n` +
        `Connection: close\r\n\r\n` +
        body.toString("utf8"),
    );
  };

  const target = parseAuthority(req.url ?? "");
  if (!target) {
    fail(400, "出口网关：无法解析 CONNECT 目标");
    return;
  }

  void gateRequest(db, req.headers["proxy-authorization"], target.host)
    .then((decision) => {
      if (!decision.allowed) {
        fail(decision.status, decision.message);
        return;
      }
      const upstream = net.connect({ host: target.host, port: target.port });
      let established = false;
      upstream.on("error", (err) => {
        if (established) {
          clientSocket.destroy();
          return;
        }
        fail(502, `出口网关：连接上游失败: ${err.message}`);
      });
      clientSocket.on("error", () => upstream.destroy());
      upstream.on("connect", () => {
        established = true;
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
    })
    .catch(() => fail(500, "出口网关：内部错误"));
}

/** 普通 HTTP 代理请求（绝对 URI）：鉴权 → http.request 转发 → 回写。 */
async function handlePlainHTTP(db: Database, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const fail = (status: number, message: string) => {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(message);
  };

  // 绝对 URI 优先；缺失时退回 Host 头 + 原始路径（非代理形态请求按目标不可达拒绝）。
  let target: URL;
  try {
    target = new URL(req.url ?? "");
  } catch {
    const hostHeader = req.headers.host;
    if (!hostHeader) {
      fail(400, "出口网关：缺少请求目标");
      return;
    }
    try {
      target = new URL(req.url ?? "/", `http://${stripHostPort(hostHeader)}`);
    } catch {
      fail(400, "出口网关：无法解析请求目标");
      return;
    }
  }
  if (target.protocol !== "http:") {
    fail(400, `出口网关：不支持的协议 ${target.protocol}（HTTPS 请走 CONNECT）`);
    return;
  }

  const decision = await gateRequest(db, req.headers["proxy-authorization"], target.hostname);
  if (!decision.allowed) {
    fail(decision.status, decision.message);
    return;
  }

  const upstream = http.request(target, {
    method: req.method,
    headers: sanitizeOutgoingHeaders(req.headers),
  });
  upstream.on("error", (err) => {
    if (!res.headersSent) fail(502, `出口网关：转发失败: ${err.message}`);
    else res.destroy();
  });
  upstream.on("response", (ur) => {
    res.writeHead(ur.statusCode ?? 502, ur.headers);
    ur.pipe(res);
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

/** 构造出口网关服务器（未监听；由 startEgressGateway 绑定）。 */
export function createEgressServer(db: Database): http.Server {
  const server = http.createServer((req, res) => {
    void handlePlainHTTP(db, req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("出口网关：内部错误");
      } else {
        res.destroy();
      }
    });
  });
  server.on("connect", (req, socket, head) => handleConnect(db, req, socket, head));
  return server;
}
