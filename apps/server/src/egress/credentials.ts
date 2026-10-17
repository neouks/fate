// 任务代理凭据：平移 Go 版 guard/proxy_tag.go 的语义。
//
// 形态（与 Go 完全一致，跨实现可互验）：
// - 进程内随机 32 字节 HMAC-SHA256 密钥（重启即失效，不落盘不外发）
// - username = `series-task-<taskID>` + 可选 `~<base64url(scope)>`（scope 如 "worker:<intentID>"）
// - password = HMAC-SHA256(identity) 的 hex（64 字符）
//
// agent 可以看到自己的凭据，但改 taskID / scope 后签名失效——shell 进程无法借用
// 另一个任务的授权策略。parseAndVerify 对签名做长度一致前提下的常数时间比较。

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TASK_PROXY_USER_PREFIX = "series-task-";

/** 进程内一次性密钥（Go taskProxySecret）。 */
const taskProxySecret = randomBytes(32);

function taskProxyIdentity(taskID: number, scope: string): string {
  let identity = String(taskID);
  if (scope !== "") identity += `~${Buffer.from(scope, "utf8").toString("base64url")}`;
  return identity;
}

function taskProxySignature(taskID: number, scope: string): string {
  return createHmac("sha256", taskProxySecret).update(taskProxyIdentity(taskID, scope), "utf8").digest("hex");
}

export interface TaskProxyCredentials {
  username: string;
  password: string;
}

/** 生成进程内签名的一次性任务代理身份；taskID<=0 返回 null（Go ok=false）。 */
export function taskCredentials(taskID: number, scope = ""): TaskProxyCredentials | null {
  if (!Number.isInteger(taskID) || taskID <= 0) return null;
  return {
    username: TASK_PROXY_USER_PREFIX + taskProxyIdentity(taskID, scope),
    password: taskProxySignature(taskID, scope),
  };
}

/** 凭据 → Proxy-Authorization 头值（`Basic base64(user:pass)`）。 */
export function proxyAuthorizationHeader(creds: TaskProxyCredentials): string {
  return `Basic ${Buffer.from(`${creds.username}:${creds.password}`, "utf8").toString("base64")}`;
}

export type ParsedProxyScope =
  | { tagged: false }
  | { tagged: true; taskID: number; scope: string };

// Go encoding/base64 StdEncoding 严格校验；Node Buffer.from 宽松（忽略非法字符），
// 这里先用正则对齐严格性，非法按未打标处理（与 Go decodeErr 分支一致）。
const STRICT_BASE64_STD = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * 解析并验签 Proxy-Authorization 头（Go ParseTaskProxyScope）：
 * - 未带 / 非 Basic / 非 series-task- 前缀 → { tagged: false }（普通凭据刻意按未打标上报）
 * - 打标但标识/签名无效 → throw（调用方拒绝请求）
 */
export function parseAndVerify(header: string | undefined): ParsedProxyScope {
  if (header === undefined || !header.startsWith("Basic ")) return { tagged: false };
  const b64 = header.slice("Basic ".length);
  if (!STRICT_BASE64_STD.test(b64)) return { tagged: false };
  const decoded = Buffer.from(b64, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return { tagged: false };
  const user = decoded.slice(0, colon);
  const password = decoded.slice(colon + 1);
  if (!user.startsWith(TASK_PROXY_USER_PREFIX)) return { tagged: false };

  // 打标流量：身份与签名必须完全成立，否则一律拒绝。
  const identity = user.slice(TASK_PROXY_USER_PREFIX.length);
  const tilde = identity.indexOf("~");
  let scope = "";
  let idText = identity;
  if (tilde >= 0) {
    idText = identity.slice(0, tilde);
    scope = Buffer.from(identity.slice(tilde + 1), "base64url").toString("utf8");
    if (scope === "") throw new Error("无效的任务代理归属");
  }
  if (!/^\d+$/.test(idText)) throw new Error("无效的任务代理标识");
  const taskID = Number.parseInt(idText, 10);
  if (!(taskID > 0)) throw new Error("无效的任务代理标识");
  const expected = taskProxySignature(taskID, scope);
  // 长度一致的前提下常数时间比较（timingSafeEqual 不等长会抛异常，先对齐 Go 的显式长度短路）。
  if (
    password.length !== expected.length ||
    !timingSafeEqual(Buffer.from(password, "utf8"), Buffer.from(expected, "utf8"))
  ) {
    throw new Error("任务代理签名无效");
  }
  return { tagged: true, taskID, scope };
}
