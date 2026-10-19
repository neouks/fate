import { rootDomain } from "./assets.js";
// 任务侧资产授权/范围/覆盖度 store。
// 平移自 Go 版 db/task_scope.go（AddAutoScope/AddAgentScope/covTargetCTE/TaskCoverage/
// ListUntestedAssets）、db/task_assets.go（Validate*/TaskAssetApprovalStates/Approve/Revoke/
// MarkTaskAssetsTested/AssetKey/normalizeTaskAssetHost）、db/main_execution.go（ValidateIntent*/
// intentAssetAllowedSQL）、db/worker_execution.go（ValidateWorker*）、db/asset_skips.go
// （RememberTaskAssetDenials/ActiveTaskAssetSkips）。SQL 原样平移（表/列/函数名不变）。
//
// 与 Go 版的已知偏差：
// - RootDomain（eTLD+1）Go 依赖 golang.org/x/net/publicsuffix；TS 侧用常用二级公共后缀
//   集合近似，未收录后缀回退「最后两段」。对常见域（example.com / *.co.uk 等）等价。
// - NormalizeAgentHost 的 IDNA ToASCII 用 URL 构造器（punycode + 小写）近似。

import net from "node:net";
import type { PoolClient } from "pg";
import type { Database } from "./index.js";
import { nodeAllowsPendingAssets } from "./exploration.js";
import type { Node } from "./exploration.js";

// ─── 常量与错误（db/task_assets.go）──────────────────────────────────────────

export const MAX_TASK_ASSET_MUTATION_COUNT = 100;
export const MAX_TASK_ASSET_SUMMARY_RUNES = 500;

export const APPROVAL_APPROVED = "approved";
export const APPROVAL_PENDING = "pending";
export const APPROVAL_REVOKED = "revoked";
export const APPROVAL_BLOCKED = "blocked";

export class TaskAssetInvalidError extends Error {
  constructor(message = "invalid task asset association") {
    super(message);
    this.name = "TaskAssetInvalidError";
  }
}
export class TaskAssetTaskNotFoundError extends Error {
  constructor(message = "task not found") {
    super(message);
    this.name = "TaskAssetTaskNotFoundError";
  }
}
export class TaskAssetNotFoundError extends Error {
  constructor(message = "asset not found") {
    super(message);
    this.name = "TaskAssetNotFoundError";
  }
}
export class TaskAssetBlockedError extends Error {
  constructor(message = "task asset is blocked") {
    super(message);
    this.name = "TaskAssetBlockedError";
  }
}
export class TaskAssetNotApprovedError extends Error {
  constructor(message = "task asset is not approved") {
    super(message);
    this.name = "TaskAssetNotApprovedError";
  }
}

// ─── 主机/域/IP 归一化（db/nkey.go / db/task_assets.go / db/assets.go）───────

/** 归一化域自然键：trim + 小写 + 去尾点（Go DomainKey）。 */
export function domainKey(fqdn: string): string {
  return fqdn.trim().toLowerCase().replace(/\.$/, "");
}

/** 常见二级公共后缀（publicsuffix 的近似子集；Go 用完整 PSL）。 */
export { rootDomain } from "./assets.js";

/** 规范化 IP 字面量（Go net.ParseIP + ip.String()）；非法返回 null。IPv6 输出压缩形。 */
export function parseCanonicalIP(v: string): string | null {
  const t = v.trim();
  const kind = net.isIP(t);
  if (kind === 4) return t;
  if (kind === 6) {
    try {
      return new URL(`http://[${t}]/`).hostname.replace(/^\[/, "").replace(/\]$/, "");
    } catch {
      return null;
    }
  }
  return null;
}

/** 裸 IP → 单主机 CIDR（/32 或 /128）；非法返回 ""（Go ipToHostCIDR）。 */
export function ipToHostCIDR(ip: string): string {
  const t = ip.trim();
  const kind = net.isIP(t);
  if (kind === 0) return "";
  const v4 = kind === 4 || (kind === 6 && t.toLowerCase().startsWith("::ffff:")); // Go To4() 含 v4 映射地址
  return t + (v4 ? "/32" : "/128");
}

/** 去掉 host:port / [v6]:port 的端口；裸主机/裸 IPv6 原样返回（Go stripHostPort / net.SplitHostPort）。 */
export function stripHostPort(v: string): string {
  const t = v.trim();
  const v6 = t.match(/^\[([0-9a-fA-F:.]+)\]:\d+$/);
  if (v6) return v6[1]!;
  const m = t.match(/^([^\[\]:]+):(\d+)$/);
  if (m) return m[1]!;
  return t;
}

/** 校验并归一化 Agent 主机名（Go NormalizeAgentHost）：IP→规范形，域名→ASCII 小写。 */
export function normalizeAgentHost(raw: string, allowSingle: boolean): string {
  let h = domainKey(raw);
  const ip = parseCanonicalIP(h);
  if (ip !== null) return ip;
  try {
    // IDNA ToASCII 近似：URL 构造器完成 punycode 编码与小写化。
    h = new URL(`http://${h}`).hostname.replace(/^\[/, "").replace(/\]$/, "");
  } catch {
    /* 保持原值，由下方标签校验拒绝 */
  }
  if (h === "" || h.length > 253 || (!allowSingle && !h.includes("."))) {
    throw new TaskAssetInvalidError(`invalid host "${raw}": 需要明确的主机名，不能使用变量或占位符`);
  }
  for (const label of h.split(".")) {
    if (label.length === 0 || label.length > 63 || label.startsWith("-") || label.endsWith("-")) {
      throw new TaskAssetInvalidError(`invalid host "${raw}"`);
    }
    for (const c of label) {
      if (!((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "-")) {
        throw new TaskAssetInvalidError(`invalid host "${raw}": 不得使用变量、下划线或占位符`);
      }
    }
  }
  return h;
}

/** 任务侧主机身份归一化（Go normalizeTaskAssetHost：trim/小写/去方括号 → URL 主机 → IP 规范形 → 去尾点）。 */
export function normalizeTaskAssetHost(value: string): string {
  let v = value.trim().toLowerCase().replace(/^\[+/, "").replace(/\]+$/, "");
  if (v.includes("://")) {
    try {
      const h = new URL(v).hostname;
      if (h !== "") v = h.replace(/^\[/, "").replace(/\]$/, "");
    } catch {
      /* 无主机名的相对引用：保持原值（与 Go url.Parse Hostname()=='' 分支一致） */
    }
  }
  const ip = parseCanonicalIP(v);
  if (ip !== null) return ip;
  return v.replace(/\.$/, "");
}

/** 小写 scheme/host、裸根去尾斜杠（Go normalizeURL）。 */
export function normalizeURL(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  let s = u.toString();
  if (s.endsWith("/") && u.pathname === "/" && u.search === "") s = s.slice(0, -1);
  return s;
}

function defaultPort(scheme: string, p: string): number {
  if (p !== "") {
    const n = Number.parseInt(p, 10);
    if (!Number.isNaN(n)) return n;
  }
  if (scheme === "https") return 443;
  if (scheme === "http") return 80;
  return 0;
}

/** 从 URL 提取 domain/port/service_name（Go parseURL）。 */
export function parseURL(raw: string): { domain: string; port: number; serviceName: string } {
  try {
    const u = new URL(raw);
    const scheme = u.protocol.replace(":", "").toLowerCase();
    let serviceName: string;
    if (scheme === "https") serviceName = "HTTPS";
    else if (scheme === "http") serviceName = "HTTP";
    else serviceName = scheme.toUpperCase();
    return {
      domain: u.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, ""),
      port: defaultPort(scheme, u.port),
      serviceName,
    };
  } catch {
    return { domain: "", port: 0, serviceName: "" };
  }
}

// ─── AssetKey（任务本地稳定身份，删除墓碑用；Go AssetKey）───────────────────

export interface AssetIdentity {
  id: number;
  type: string;
  domain?: string | null;
  root_domain?: string | null;
  ip?: string | null;
  url?: string | null;
  method?: string | null;
  service_name?: string | null;
  port?: number | null;
  bundle_id?: string | null;
  app_name?: string | null;
}

/**
 * 删除墓碑用的任务本地稳定身份：刻意独立于全局资产行 id，共享资产的删除/重建
 * 无法绕过任务的显式封禁。
 */
export function assetKey(a: AssetIdentity | null): { key: string; host: string } {
  if (!a) return { key: "", host: "" };
  let host = normalizeTaskAssetHost(a.domain ?? "");
  if (host === "") host = normalizeTaskAssetHost(a.ip ?? "");
  if (host === "" && a.url) {
    try {
      host = normalizeTaskAssetHost(new URL(a.url).hostname);
    } catch {
      /* 保持空 */
    }
  }
  let key = "";
  switch (a.type) {
    case "root_domain":
    case "subdomain":
      key = `${a.type}:${normalizeTaskAssetHost(a.domain ?? "")}`;
      break;
    case "ip":
      key = `ip:${normalizeTaskAssetHost(a.ip ?? "")}`;
      break;
    case "service":
      key = `service:${normalizeURL(a.url ?? "")}`;
      if (!a.url) {
        const port = a.port ?? 0;
        key = `service:${host}:${port}:${String(a.service_name ?? "").trim().toLowerCase()}`;
      }
      break;
    case "endpoint":
      key = `endpoint:${normalizeURL(a.url ?? "")}:${String(a.method ?? "").trim().toUpperCase()}`;
      break;
    case "app":
      key = `app:${String(a.bundle_id ?? "").trim().toLowerCase() || String(a.app_name ?? "").trim().toLowerCase()}`;
      break;
    default:
      key = `${a.type}:${String(a.id).trim()}`;
  }
  return { key, host };
}

// ─── intentAssetAllowedSQL（db/main_execution.go；与 exploration.ts 私有实现同体）──

export function intentAssetAllowedSQL(task: string, asset: string, node: string): string {
  return (
    `(CASE WHEN ${node}.payload->'pending_asset_execution'->>'issuer'='mainagent' ` +
    `THEN task_asset_worker_executable(${task},${asset}) ` +
    `ELSE task_asset_effectively_approved(${task},${asset}) END)`
  );
}

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface TaskScope {
  id?: number;
  task_id: number;
  kind: string; // company|root_domain|subdomain|ip|cidr|icp|keyword
  company_id?: number | null;
  company_name?: string;
  domain?: string;
  net?: string;
  value?: string;
  /** 空 = 写入端默认：upsert 落 'auto'，addAgentScope 落 'agent'。 */
  source?: string;
  reason?: string;
}

export interface CoverageAsset {
  id: number;
  type: string;
  label: string;
}

export interface CoverageByType {
  type: string;
  total: number;
  tested: number;
}

export interface Coverage {
  enabled: boolean;
  scopeRows: number;
  denominator: number;
  tested: number;
  pct: number | null;
  byType: CoverageByType[];
}

export interface TaskAssetSkip {
  host: string;
  state: string;
  attempts: number;
}

export interface TaskAssetMutation {
  requested: number;
  attached: number;
  existing: number;
}

// ─── id 归一化（db/task_assets.go）───────────────────────────────────────────

/** 变更端点的严格归一化：非空、正数、去重、上限 100。 */
export function normalizeTaskAssetIDs(ids: number[]): number[] {
  if (ids.length === 0) throw new TaskAssetInvalidError("invalid task asset association: asset_ids is required");
  const seen = new Set<number>();
  const normalized: number[] = [];
  for (const id of ids) {
    if (id <= 0) throw new TaskAssetInvalidError("invalid task asset association: asset id must be positive");
    if (seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
    if (normalized.length > MAX_TASK_ASSET_MUTATION_COUNT) {
      throw new TaskAssetInvalidError(
        `invalid task asset association: at most ${MAX_TASK_ASSET_MUTATION_COUNT} assets per request`,
      );
    }
  }
  return normalized;
}

/** 建任务路径的可选归一化：空列表合法。 */
export function normalizeTaskAssetIDsForCreate(ids: number[]): number[] {
  if (ids.length === 0) return [];
  return normalizeTaskAssetIDs(ids);
}

function normalizeICP(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function normalizeKeyword(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

// ─── covTargetCTE（db/task_scope.go，$1=taskID $2=expID；原样平移）──────────

const covTargetCTE = `
target AS (
  SELECT DISTINCT a.id, a.type,
         COALESCE(a.url, a.domain, a.ip, a.app_name, a.root_domain, '') AS label
  FROM assets a
  JOIN task_scope ts ON ts.task_id = $1 AND (
       (ts.kind='company'     AND a.company_id = ts.company_id)
    OR (ts.kind='root_domain' AND a.root_domain = ts.domain)
    OR (ts.kind='subdomain'   AND a.domain = ts.domain)
    OR (ts.kind IN ('ip','cidr') AND ts.net >>= try_inet(a.ip))
    OR (ts.kind='icp' AND (
         lower(regexp_replace(COALESCE(a.icp,''), '[[:space:]]+', '', 'g')) = ts.value
         OR lower(regexp_replace(COALESCE(a.app_icp,''), '[[:space:]]+', '', 'g')) = ts.value
       ))
  )
  AND task_asset_effectively_approved($1,a.id)
),
tested AS (
  SELECT DISTINCT link.asset_id
  FROM task_asset_links link
  WHERE link.task_id = $1 AND link.tested AND task_asset_effectively_approved($1,link.asset_id)
  UNION
  SELECT DISTINCT ea.asset_id
  FROM exploration_anchors ea
  JOIN exploration_nodes en ON en.id = ea.node_id
  WHERE en.exploration_id = $2 AND en.kind IN ('fact','finding')
    AND task_asset_effectively_approved($1,ea.asset_id)
)`;

/** 校验 CIDR 字符串（Go net.ParseCIDR 近似：IP 合法 + 掩码位数在族范围内）。 */
function validCIDR(v: string): boolean {
  const slash = v.lastIndexOf("/");
  if (slash <= 0) return false;
  const addr = v.slice(0, slash);
  const mask = Number.parseInt(v.slice(slash + 1), 10);
  if (!/^\d+$/.test(v.slice(slash + 1)) || Number.isNaN(mask)) return false;
  const kind = net.isIP(addr);
  if (kind === 4) return mask >= 0 && mask <= 32;
  if (kind === 6) return mask >= 0 && mask <= 128;
  return false;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export class TaskScopeStore {
  workerRead = false;

  constructor(private db: Database, private tx?: PoolClient) {}

  private exec<T extends Record<string, unknown>>(text: string, values?: unknown[]) {
    return this.tx ? this.tx.query<T>(text, values) : this.db.query<T>(text, values);
  }

  // ─── 范围写入（upsertTaskScopeResult/AddAutoScope/AddAgentScope）───────────

  /** 幂等插一条 scope（uq_task_scope）；重复静默忽略。返回是否新插入。 */
  async upsertTaskScopeResult(ts: TaskScope): Promise<boolean> {
    if (ts.task_id <= 0 || ts.kind === "") return false;
    const res = await this.exec(
      `INSERT INTO task_scope(task_id, kind, company_id, domain, net, value, source, reason)
       VALUES ($1,$2,$3,$4,$5::cidr,$6,$7,NULLIF($8,''))
       ON CONFLICT DO NOTHING`,
      [
        ts.task_id,
        ts.kind,
        ts.company_id && ts.company_id > 0 ? ts.company_id : null,
        ts.domain || null,
        ts.net || null,
        ts.value || null,
        ts.source || "auto",
        ts.reason ?? "",
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async upsertTaskScope(ts: TaskScope): Promise<void> {
    await this.upsertTaskScopeResult(ts);
  }

  /**
   * 记录单个显式插入资产隐含的保守任务范围（source='auto'）。只允许 insertAssets
   * 顶层循环调用——绝不从 db 层副作用（linkHostAssets）调用，派生资产不盲目扩范围。
   * 粒度跟随资产自身类型。taskID<=0 → no-op。
   */
  async addAutoScope(taskID: number, assetType: string, domain: string, rawURL: string, ip: string): Promise<void> {
    if (taskID <= 0) return;
    switch (assetType) {
      case "root_domain": {
        const d = domainKey(domain);
        if (d !== "") return this.upsertTaskScope({ task_id: taskID, kind: "root_domain", domain: d });
        return;
      }
      case "subdomain": {
        const d = domainKey(domain);
        if (d !== "") return this.upsertTaskScope({ task_id: taskID, kind: "subdomain", domain: d });
        return;
      }
      case "service":
      case "endpoint": {
        let host = domain;
        if (host === "" && rawURL !== "") host = parseURL(normalizeURL(rawURL)).domain;
        host = domainKey(host);
        if (host !== "" && parseCanonicalIP(host) === null) {
          return this.upsertTaskScope({ task_id: taskID, kind: "subdomain", domain: host });
        }
        // IP 字面量主机或无主机 → 有 IP 就回退 ip 范围。
        const c = ipToHostCIDR(ip);
        if (c !== "") return this.upsertTaskScope({ task_id: taskID, kind: "ip", net: c });
        return;
      }
      case "ip": {
        const c = ipToHostCIDR(ip);
        if (c !== "") return this.upsertTaskScope({ task_id: taskID, kind: "ip", net: c });
        return;
      }
    }
  }

  /**
   * 解析 (kind,value) 并记录任务范围。LLM 工具传 source='agent'，UI 传 'manual'。
   * company：企业名或 id（须已存在）。root_domain/subdomain：域名。ip/cidr：裸 IP
   * 自动 /32,/128。source='manual' 是操作者显式授权边界：同事务写入 task_asset_grants、
   * 把匹配的存量资产重新挂回任务（approved）并清墓碑（AddAgentScope + authorizeScopeAssetsInTx）。
   */
  async addAgentScope(taskID: number, kind: string, value: string, reason: string, source: string): Promise<TaskScope> {
    if (source === "") source = "agent";
    const ts: TaskScope = { task_id: taskID, kind, source, reason };
    if (taskID <= 0) throw new Error("需要 task_id");
    value = value.trim();
    if (value === "") throw new Error("value 不能为空");
    switch (kind) {
      case "company": {
        const companyID = await this.findCompanyID(value);
        if (companyID === null) {
          throw new Error(`company 不存在: ${value}（先用 list_companies 确认，或建好企业）`);
        }
        ts.company_id = companyID;
        break;
      }
      case "root_domain": {
        const d = domainKey(stripHostPort(value));
        let root = rootDomain(d).root;
        if (root === "") root = d;
        if (root === "") throw new Error(`无效根域: ${value}`);
        ts.domain = root;
        break;
      }
      case "subdomain": {
        const d = domainKey(stripHostPort(value));
        if (d === "") throw new Error(`无效子域: ${value}`);
        ts.domain = d;
        break;
      }
      case "ip":
      case "cidr": {
        let v = value;
        if (!v.includes("/")) {
          v = ipToHostCIDR(stripHostPort(v));
          ts.kind = "ip";
        } else {
          ts.kind = "cidr";
        }
        if (v === "") throw new Error(`无效 ip/cidr: ${value}`);
        if (!validCIDR(v)) throw new Error(`无效 ip/cidr: ${value}`);
        ts.net = v;
        break;
      }
      case "icp": {
        const parsed = normalizeICP(value);
        if (parsed === "") throw new Error("ICP 不能为空");
        ts.value = parsed;
        break;
      }
      case "keyword": {
        const parsed = normalizeKeyword(value);
        if (parsed === "") throw new Error("企业关键词不能为空");
        ts.value = parsed;
        break;
      }
      default:
        throw new Error(`不支持的 kind: ${kind}（company/root_domain/subdomain/ip/cidr/icp/keyword）`);
    }
    if (source !== "manual") {
      await this.upsertTaskScope(ts);
      return ts;
    }

    if (this.tx) {
      await this.upsertTaskScope(ts);
      await this.authorizeScopeAssets(this.tx, ts);
      return ts;
    }
    // 操作者范围 = 显式授权边界：范围与资产恢复同事务原子提交。
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      const scoped = new TaskScopeStore(this.db, client);
      await scoped.upsertTaskScope(ts);
      await scoped.authorizeScopeAssets(client, ts);
      await client.query("COMMIT");
      return ts;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 企业 id/名 → companies.id（Go CompanyStore.GetCompany / GetCompanyByName 的 companyNKey）。 */
  private async findCompanyID(value: string): Promise<number | null> {
    if (/^[+-]?\d+$/.test(value)) {
      const res = await this.exec<{ id: string }>(`SELECT id FROM companies WHERE id=$1`, [Number(value)]);
      return res.rows[0] ? Number(res.rows[0].id) : null;
    }
    const nkey = value
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
    const res = await this.exec<{ id: string }>(`SELECT id FROM companies WHERE nkey=$1`, [nkey]);
    return res.rows[0] ? Number(res.rows[0].id) : null;
  }

  /**
   * source='manual' 的授权落地（Go authorizeScopeAssetsInTx，SQL 原样）：
   * 写 task_asset_grants → 匹配资产重新挂任务（approved, manual）→ 按资产身份清墓碑 →
   * 按范围身份（host_key）清已删资产的残留墓碑。keyword 只是发现线索，不按展示名认领资产。
   */
  private async authorizeScopeAssets(client: PoolClient, scope: TaskScope): Promise<void> {
    if (scope.task_id <= 0) return;
    let grantKind = "";
    let grantValue = "";
    let root = "";
    switch (scope.kind) {
      case "root_domain":
        grantKind = "domain";
        grantValue = scope.domain ?? "";
        root = scope.domain ?? "";
        break;
      case "subdomain":
        grantKind = "host";
        grantValue = scope.domain ?? "";
        root = rootDomain(scope.domain ?? "").root;
        break;
      case "ip":
      case "cidr":
        grantKind = "cidr";
        grantValue = scope.net ?? "";
        break;
    }
    if (grantKind !== "") {
      await client.query(
        `INSERT INTO task_asset_grants(task_id,kind,value,root_domain,source,evidence) VALUES($1,$2,$3,$4,'manual',$5) ON CONFLICT DO NOTHING`,
        [scope.task_id, grantKind, grantValue, root, scope.reason ?? ""],
      );
    }
    let where = "";
    let arg: unknown = null;
    switch (scope.kind) {
      case "company":
        if (!scope.company_id || scope.company_id <= 0) return;
        where = "a.company_id=$1";
        arg = scope.company_id;
        break;
      case "root_domain":
        where = "a.domain=$1 OR a.domain LIKE '%.'||$1 OR a.root_domain=$1";
        arg = scope.domain ?? "";
        break;
      case "subdomain":
        where = "a.domain=$1";
        arg = scope.domain ?? "";
        break;
      case "ip":
      case "cidr":
        where = "try_inet(a.ip) IS NOT NULL AND $1::cidr >>= try_inet(a.ip)";
        arg = scope.net ?? "";
        break;
      case "icp":
        where = `(lower(regexp_replace(COALESCE(a.icp,''), '[[:space:]]+', '', 'g'))=$1
OR lower(regexp_replace(COALESCE(a.app_icp,''), '[[:space:]]+', '', 'g'))=$1)`;
        arg = scope.value ?? "";
        break;
      default:
        return;
    }
    const rows = await client.query<Record<string, unknown>>(
      `SELECT a.id,a.type,COALESCE(a.domain,'') AS domain,COALESCE(a.root_domain,'') AS root_domain,COALESCE(a.ip,'') AS ip,COALESCE(a.url,'') AS url,COALESCE(a.method,'') AS method,COALESCE(a.service_name,'') AS service_name,COALESCE(a.port,0) AS port FROM assets a WHERE (${where})`,
      [arg],
    );
    const summary = "用户在测试资产页手工新增";
    let reason = String(scope.reason ?? "").trim();
    if (reason === "") reason = "手动范围登记";
    for (const row of rows.rows) {
      const a: AssetIdentity = {
        id: Number(row["id"]),
        type: String(row["type"]),
        domain: row["domain"] as string,
        root_domain: (row["root_domain"] as string) || null,
        ip: row["ip"] as string,
        url: row["url"] as string,
        method: row["method"] as string,
        service_name: row["service_name"] as string,
        port: Number(row["port"] ?? 0),
      };
      await client.query(
        `UPDATE assets SET task_ids=CASE WHEN $1=ANY(task_ids) THEN task_ids ELSE array_append(task_ids,$1) END WHERE id=$2`,
        [scope.task_id, a.id],
      );
      await client.query(
        `INSERT INTO task_asset_links(task_id,asset_id,source,source_summary,approval_state,approved_at,approved_by,approval_reason)
        VALUES ($1,$2,'manual',$3,'approved',now(),'user',$4)
        ON CONFLICT(task_id,asset_id) DO UPDATE SET source='manual',source_summary=EXCLUDED.source_summary,source_node_id=NULL,
        approval_state='approved',approved_at=now(),approved_by='user',approval_reason=EXCLUDED.approval_reason`,
        [scope.task_id, a.id, summary, reason],
      );
      const { key } = assetKey(a);
      await client.query(
        `DELETE FROM task_asset_blocks WHERE task_id=$1 AND block_kind<>'invalid' AND (asset_id=$2 OR asset_key=$3)`,
        [scope.task_id, a.id, key],
      );
    }

    // 范围身份同样清「全局资产行已不存在」的墓碑；否则删除后重建全局行会让操作者的
    // 显式重新授权失效。
    switch (scope.kind) {
      case "root_domain":
        await client.query(
          `DELETE FROM task_asset_blocks
          WHERE task_id=$1 AND block_kind<>'invalid' AND host_key<>'' AND (host_key=$2 OR host_key LIKE '%.'||$2)`,
          [scope.task_id, scope.domain ?? ""],
        );
        break;
      case "subdomain":
        await client.query(
          `DELETE FROM task_asset_blocks WHERE task_id=$1 AND block_kind<>'invalid' AND host_key=$2`,
          [scope.task_id, scope.domain ?? ""],
        );
        break;
      case "ip":
      case "cidr":
        await client.query(
          `DELETE FROM task_asset_blocks
          WHERE task_id=$1 AND block_kind<>'invalid' AND try_inet(host_key) IS NOT NULL AND $2::cidr >>= try_inet(host_key)`,
          [scope.task_id, scope.net ?? ""],
        );
        break;
    }
  }

  /** 删除单条 scope（限定任务）；返回是否真的删除了一行。 */
  async deleteTaskScope(taskID: number, scopeID: number): Promise<boolean> {
    const res = await this.exec(`DELETE FROM task_scope WHERE id=$1 AND task_id=$2`, [scopeID, taskID]);
    return (res.rowCount ?? 0) > 0;
  }

  /** 列出任务全部 scope 行（含企业名解析）。 */
  async listTaskScope(taskID: number): Promise<TaskScope[]> {
    const res = await this.exec<{
      id: string;
      kind: string;
      company_id: string;
      company_name: string;
      domain: string;
      net: string;
      value: string;
      source: string;
      reason: string;
    }>(
      `SELECT ts.id, ts.kind, COALESCE(ts.company_id,0) AS company_id, COALESCE(c.name,'') AS company_name, COALESCE(ts.domain,'') AS domain,
             COALESCE(ts.net::text,'') AS net, COALESCE(ts.value,'') AS value, ts.source, COALESCE(ts.reason,'') AS reason
      FROM task_scope ts
      LEFT JOIN companies c ON c.id=ts.company_id
      WHERE ts.task_id=$1 ORDER BY ts.id`,
      [taskID],
    );
    return res.rows.map((r) => ({
      id: Number(r.id),
      task_id: taskID,
      kind: r.kind,
      company_id: Number(r.company_id) > 0 ? Number(r.company_id) : null,
      company_name: r.company_name,
      domain: r.domain,
      net: r.net,
      value: r.value,
      source: r.source,
      reason: r.reason,
    }));
  }

  // ─── 覆盖度（CoverageEnabled/TaskCoverage/ListUntestedAssets）──────────────

  /** 覆盖度功能开关（tasks.coverage_enabled）；缺失/出错 fail-open 为 true。taskID<=0 → true。 */
  async coverageEnabled(taskID: number): Promise<boolean> {
    if (taskID <= 0) return true;
    try {
      const res = await this.exec<{ coverage_enabled: boolean }>(
        `SELECT COALESCE(coverage_enabled,true) AS coverage_enabled FROM tasks WHERE id=$1`,
        [taskID],
      );
      return res.rows[0]?.coverage_enabled !== false;
    } catch {
      return true;
    }
  }

  /**
   * 粗粒度按类型覆盖度。分母=匹配任一活跃 task_scope 的资产；分子=已测（链接 tested
   * 或锚到 fact/finding 节点）。Go 版 Enabled 由 API 层填；TS 版在此直接读开关。
   */
  async taskCoverage(taskID: number, expID: number): Promise<Coverage> {
    const scopeRes = await this.exec<{ count: string }>(`SELECT count(*) FROM task_scope WHERE task_id=$1`, [taskID]);
    const cov: Coverage = {
      enabled: await this.coverageEnabled(taskID),
      scopeRows: Number(scopeRes.rows[0]?.count ?? 0),
      denominator: 0,
      tested: 0,
      pct: null,
      byType: [],
    };
    const res = await this.exec<{ type: string; total: string; tested: string }>(
      `WITH ${covTargetCTE}
      SELECT t.type, count(*) AS total,
             count(*) FILTER (WHERE t.id IN (SELECT asset_id FROM tested)) AS tested
      FROM target t GROUP BY t.type ORDER BY t.type`,
      [taskID, expID],
    );
    for (const row of res.rows) {
      const bt: CoverageByType = { type: row.type, total: Number(row.total), tested: Number(row.tested) };
      cov.byType.push(bt);
      cov.denominator += bt.total;
      cov.tested += bt.tested;
    }
    if (cov.denominator > 0) cov.pct = cov.tested / cov.denominator;
    return cov;
  }

  /** 范围内未测资产（可按类型过滤、分页）。返回页 + 总数。limit<=0 → 10。 */
  async listUntestedAssets(
    taskID: number,
    expID: number,
    typ: string,
    limit: number,
    offset: number,
  ): Promise<{ page: CoverageAsset[]; total: number }> {
    if (limit <= 0) limit = 10;
    if (offset < 0) offset = 0;
    const args: unknown[] = [taskID, expID];
    let typeFilter = "";
    if (typ !== "") {
      typeFilter = " AND t.type = $3";
      args.push(typ);
    }
    const totalRes = await this.exec<{ count: string }>(
      `WITH ${covTargetCTE}
      SELECT count(*) FROM target t WHERE t.id NOT IN (SELECT asset_id FROM tested)${typeFilter}`,
      args,
    );
    const total = Number(totalRes.rows[0]?.count ?? 0);
    const pageArgs = [...args, limit, offset];
    const limPos = args.length + 1;
    const offPos = args.length + 2;
    const res = await this.exec<{ id: string; type: string; label: string }>(
      `WITH ${covTargetCTE}
      SELECT t.id, t.type, t.label FROM target t
      WHERE t.id NOT IN (SELECT asset_id FROM tested)${typeFilter}
      ORDER BY t.id LIMIT $${limPos} OFFSET $${offPos}`,
      pageArgs,
    );
    return {
      page: res.rows.map((r) => ({ id: Number(r.id), type: r.type, label: r.label })),
      total,
    };
  }

  // ─── 授权校验（DB 侧 SQL 函数族）──────────────────────────────────────────

  /** 批量读有效授权态（task_asset_effective_approval_state）；缺失 id 不含入结果。 */
  async taskAssetApprovalStates(taskID: number, ids: number[]): Promise<Map<number, string>> {
    const states = new Map<number, string>();
    if (ids.length === 0) return states;
    const res = await this.exec<{ id: string; state: string | null }>(
      `SELECT id,task_asset_effective_approval_state($1,id) AS state
      FROM assets WHERE id=ANY($2::bigint[])`,
      [taskID, ids],
    );
    for (const row of res.rows) states.set(Number(row.id), row.state ?? "");
    return states;
  }

  /**
   * 严格 planning/startup 准入校验。运行中 Worker 写回用 validateWorkerAssets。
   * 空列表合法（全局方向）。当前任务链接权威；无链接时可被直接继承的来源链接
   * 以来源任务的只读状态授权。
   */
  async validateTaskAssetsApproved(taskID: number, assetIDs: number[]): Promise<void> {
    if (taskID <= 0 || assetIDs.length === 0) return;
    const ids = normalizeTaskAssetIDs(assetIDs);
    const states = await this.taskAssetApprovalStates(taskID, ids);
    for (const id of ids) {
      const state = states.get(id) ?? "";
      if (state === APPROVAL_APPROVED) continue;
      if (state === "") throw new TaskAssetNotFoundError();
      if (state === APPROVAL_BLOCKED) throw new TaskAssetBlockedError(`task asset is blocked: asset ${id} 或其父资产已封禁`);
      throw new TaskAssetNotApprovedError(`task asset is not approved: asset ${id} 状态为 ${state}`);
    }
  }

  /** 运行中 Worker 写回校验：approved 或 pending 均可执行。 */
  async validateWorkerAssets(taskID: number, ids: number[]): Promise<void> {
    const states = await this.taskAssetApprovalStates(taskID, ids);
    for (const id of ids) {
      const state = states.get(id) ?? "";
      if (state !== APPROVAL_APPROVED && state !== APPROVAL_PENDING) {
        throw new TaskAssetNotApprovedError(`task asset is not approved: asset ${id} 不属于本任务或已被主动限制 (${state})`);
      }
    }
  }

  /** 非结构化网络工具（Bash/HTTP/MCP）的任务授权批量读（task_host_approval_state）。 */
  async taskHostApprovalStates(taskID: number, hosts: string[]): Promise<Map<string, string>> {
    const states = new Map<string, string>();
    if (hosts.length === 0) return states;
    const res = await this.exec<{ host: string; state: string | null }>(
      `SELECT host,COALESCE(task_host_approval_state($1,host),'') AS state
      FROM unnest($2::text[]) AS requested(host)`,
      [taskID, hosts],
    );
    for (const row of res.rows) states.set(row.host, row.state ?? "");
    return states;
  }

  /**
   * 任务级主机准入：显式/相关模板对未知主机 fail-closed；all_assets 仍放行新的合法
   * 主机，除非操作者封禁、撤回或删除生效。
   */
  async validateTaskHostsApproved(taskID: number, hosts: string[]): Promise<void> {
    if (taskID <= 0 || hosts.length === 0) return;
    const want: string[] = [];
    const seen = new Set<string>();
    for (const raw of hosts) {
      const host = normalizeTaskAssetHost(raw);
      if (host === "") continue;
      let normalized: string;
      try {
        normalized = normalizeAgentHost(host, true);
      } catch {
        throw new TaskAssetInvalidError(`invalid task asset association: host "${host}" 格式无效`);
      }
      if (!seen.has(normalized)) {
        want.push(normalized);
        seen.add(normalized);
      }
    }
    const states = await this.taskHostApprovalStates(taskID, want);
    for (const host of want) {
      const state = states.get(host) ?? "";
      if (state === APPROVAL_APPROVED) continue;
      if (state === "") throw new TaskAssetTaskNotFoundError();
      if (state === APPROVAL_BLOCKED) throw new TaskAssetBlockedError(`task asset is blocked: host ${host} 已封禁`);
      throw new TaskAssetNotApprovedError(`task asset is not approved: host ${host} 状态为 ${state}`);
    }
  }

  /** Worker 运行态主机校验：approved 或 pending 均可。 */
  async validateWorkerHosts(taskID: number, hosts: string[]): Promise<void> {
    const normalized = hosts.map((host) => {
      try {
        return normalizeAgentHost(host, true);
      } catch {
        throw new TaskAssetInvalidError(`invalid task asset association: host "${host}"`);
      }
    });
    const states = await this.taskHostApprovalStates(taskID, normalized);
    for (const host of normalized) {
      const state = states.get(host) ?? "";
      if (state !== APPROVAL_APPROVED && state !== APPROVAL_PENDING) {
        throw new TaskAssetNotApprovedError(`task asset is not approved: host ${host} 已被主动限制或任务无效 (${state})`);
      }
    }
  }

  /**
   * Network egress guard with port awareness. Legacy host scopes still allow
   * any port when the task has no selected service asset for that host; once a
   * service/endpoint asset is explicitly linked, only its approved ports pass.
   */
  private async validateHostPort(taskID: number, rawHost: string, port: number, allowPending: boolean): Promise<void> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TaskAssetInvalidError("invalid target port");
    const host = normalizeAgentHost(stripHostPort(rawHost), true);
    if(allowPending)await this.validateWorkerHosts(taskID, [host]);else await this.validateTaskHostsApproved(taskID,[host]);
    const linked = await this.exec<{id:string;type:string;domain:string;url:string;ip:string;port:number|null}>(
      `SELECT DISTINCT a.id,a.type,COALESCE(a.domain,'') AS domain,COALESCE(a.url,'') AS url,
              COALESCE(a.ip,'') AS ip,a.port
       FROM task_asset_links l JOIN assets a ON a.id=l.asset_id
       WHERE (l.task_id=$1 OR l.task_id IN (SELECT source_task_id FROM task_relations WHERE task_id=$1))
         AND a.type IN ('service','endpoint')`, [taskID]);
    const matching = linked.rows.filter(asset => {
      const hosts = new Set<string>();
      if (asset.domain) hosts.add(normalizeTaskAssetHost(asset.domain));
      if (asset.ip) hosts.add(normalizeTaskAssetHost(asset.ip));
      if (asset.url) { try { hosts.add(normalizeTaskAssetHost(new URL(asset.url).hostname)); } catch { /* malformed legacy URL */ } }
      return hosts.has(host);
    });
    if (!matching.length) return;
    const states = await this.taskAssetApprovalStates(taskID, matching.map(asset => Number(asset.id)));
    const allowedStates=allowPending?[APPROVAL_APPROVED,APPROVAL_PENDING]:[APPROVAL_APPROVED];
    const permitted = matching.some(asset => Number(asset.port) === port &&
      allowedStates.includes(states.get(Number(asset.id)) ?? ""));
    if (!permitted) throw new TaskAssetNotApprovedError(`task target port is not approved: ${host}:${port}`);
  }

  async validateWorkerHostPort(taskID:number,host:string,port:number):Promise<void>{return this.validateHostPort(taskID,host,port,true);}
  async validateTaskHostPort(taskID:number,host:string,port:number):Promise<void>{return this.validateHostPort(taskID,host,port,false);}

  /** 意图资产校验：受信 main-agent 派发放行 pending（AllowsPendingAssets 分流）。 */
  async validateIntentAssets(taskID: number, n: Node | null, ids: number[]): Promise<void> {
    if (n && nodeAllowsPendingAssets(n)) return this.validateWorkerAssets(taskID, ids);
    return this.validateTaskAssetsApproved(taskID, ids);
  }

  /** 意图主机校验：同上按 AllowsPendingAssets 分流。 */
  async validateIntentHosts(taskID: number, n: Node | null, hosts: string[]): Promise<void> {
    if (n && nodeAllowsPendingAssets(n)) return this.validateWorkerHosts(taskID, hosts);
    return this.validateTaskHostsApproved(taskID, hosts);
  }

  async validateIntentHostPort(taskID:number,n:Node|null,host:string,port:number):Promise<void>{
    if(n&&nodeAllowsPendingAssets(n))return this.validateWorkerHostPort(taskID,host,port);
    return this.validateTaskHostPort(taskID,host,port);
  }

  /**
   * 原子合并所有 Worker 与代理的拒绝记忆（task_asset_skips）。成功目标与授权查询
   * 错误不会成为禁止项。不创建/修改任何资产、授权或意图。
   */
  async rememberTaskAssetDenials(
    taskID: number,
    hosts: string[],
    assetIDs: number[],
    scopes: string[] = [],
  ): Promise<TaskAssetSkip[]> {
    const normalized: string[] = [];
    for (const host of hosts) {
      try {
        normalized.push(normalizeAgentHost(host, true));
      } catch {
        /* 非法主机不入记忆 */
      }
    }
    const res = await this.exec<{ host: string; state: string; attempts: string }>(
      `WITH targets AS (
 SELECT unnest($2::text[]) host UNION SELECT task_asset_host(a) FROM assets a WHERE a.id=ANY($3::bigint[])
 AND EXISTS(SELECT 1 FROM task_asset_links l WHERE l.asset_id=a.id AND
 (l.task_id=$1 OR l.task_id IN (SELECT source_task_id FROM task_relations WHERE task_id=$1)))
 ), denied AS MATERIALIZED (
 SELECT host,task_host_approval_state($1,host) state FROM targets WHERE host<>''
 ), saved AS (
 INSERT INTO task_asset_skips(task_id,host,observer_scopes) SELECT $1,host,COALESCE($4::text[],'{}') FROM denied WHERE state IN ('pending','revoked','blocked') ORDER BY host
 ON CONFLICT(task_id,host) DO UPDATE SET last_seen=now(),attempts=task_asset_skips.attempts+1,
 observer_scopes=ARRAY(SELECT DISTINCT scope FROM unnest(task_asset_skips.observer_scopes || EXCLUDED.observer_scopes) scope ORDER BY scope)
 RETURNING host,attempts
 ) SELECT saved.host,denied.state,saved.attempts FROM saved JOIN denied USING(host) ORDER BY host`,
      [taskID, normalized, assetIDs, scopes],
    );
    return res.rows.map((r) => ({ host: r.host, state: r.state, attempts: Number(r.attempts) }));
  }

  /** 仍处于 pending/revoked/blocked 的拒绝记忆（按当前授权实时过滤）。 */
  async activeTaskAssetSkips(taskID: number, scope = ""): Promise<TaskAssetSkip[]> {
    const res = await this.exec<{ host: string; state: string | null; attempts: string }>(
      `SELECT host,state,attempts FROM (
 SELECT host,task_host_approval_state(task_id,host) state,attempts FROM task_asset_skips WHERE task_id=$1
 AND ($2='' OR $2=ANY(observer_scopes) OR ($2='planner' AND EXISTS(
 SELECT 1 FROM exploration_nodes n JOIN tasks t ON t.exploration_id=n.exploration_id
 WHERE t.id=$1 AND n.kind='intent' AND n.state IN ('open','running','paused')
 AND ('worker:'||n.id::text)=ANY(observer_scopes))))
 ) active WHERE state IN ('pending','revoked','blocked') ORDER BY host`,
      [taskID, scope],
    );
    return res.rows.map((r) => ({ host: r.host, state: r.state ?? "", attempts: Number(r.attempts) }));
  }

  // ─── task_asset_links 审批读写（Approve/Revoke/MarkTested）────────────────

  /** 只改当前任务链接并移除匹配墓碑，恢复手工重挂资产的测试资格。 */
  async approveTaskAssets(taskID: number, assetIDs: number[], actor: string, reason: string): Promise<number[]> {
    const ids = normalizeTaskAssetIDs(assetIDs);
    actor = actor.trim();
    if (actor === "") actor = "user";
    reason = reason.trim();
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      // 与发现写入共用同一全局资产写锁（Go resolveApprovalSelection 里的 lockCompanyScopeMutation）。
      await client.query(`SELECT pg_advisory_xact_lock($1)`, [COMPANY_SCOPE_MUTATION_LOCK]);
      const done = await this.approveInTx(client, taskID, ids, actor, reason);
      await client.query("COMMIT");
      return done;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async approveInTx(client: PoolClient, taskID: number, ids: number[], actor: string, reason: string) {
    await rejectDerivedApprovalAssets(client, ids);
    const assets = await lockTaskAssetApprovalRows(client, taskID, ids);
    await rejectDeletedApprovalAssets(client, taskID, ids);
    await client.query(
      `UPDATE task_asset_links SET approval_state='approved', approved_at=now(), approved_by=$3,
      approval_reason=$4 WHERE task_id=$1 AND asset_id=ANY($2::bigint[])`,
      [taskID, ids, actor, reason],
    );
    for (const id of ids) {
      const { key } = assetKey(assets.get(id) ?? null);
      await client.query(`DELETE FROM task_asset_blocks WHERE task_id=$1 AND block_kind='manual' AND (asset_id=$2 OR asset_key=$3)`, [
        taskID,
        id,
        key,
      ]);
    }
    return ids;
  }

  /** 撤回当前任务授权；封禁资产需先批准或重新关联，不能直接撤回。 */
  async revokeTaskAssets(taskID: number, assetIDs: number[], actor: string, reason: string): Promise<number[]> {
    const ids = normalizeTaskAssetIDs(assetIDs);
    actor = actor.trim();
    if (actor === "") actor = "user";
    reason = reason.trim();
    if (reason === "") reason = "用户撤回测试授权";
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock($1)`, [COMPANY_SCOPE_MUTATION_LOCK]);
      await rejectDerivedApprovalAssets(client, ids);
      await lockTaskAssetApprovalRows(client, taskID, ids);
      const blocked = await client.query<{ ok: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM unnest($2::bigint[]) id WHERE task_asset_blocked($1,id)) AS ok`,
        [taskID, ids],
      );
      if (blocked.rows[0]?.ok === true) {
        throw new TaskAssetBlockedError("task asset is blocked: 封禁资产需先批准或重新关联，不能直接撤回");
      }
      await client.query(
        `UPDATE task_asset_links SET approval_state='revoked', approval_reason=$3,
        approved_by=$4 WHERE task_id=$1 AND asset_id=ANY($2::bigint[])`,
        [taskID, ids, reason, actor],
      );
      await client.query("COMMIT");
      return ids;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 记录当前任务 agent 对这些资产产出过 fact/finding。任务局部，不跨任务泄漏测试态。 */
  async markTaskAssetsTested(taskID: number, assetIDs: number[], agentKey: string): Promise<void> {
    if (taskID <= 0 || assetIDs.length === 0) return;
    const ids = normalizeTaskAssetIDs(assetIDs);
    await this.exec(
      `UPDATE task_asset_links
      SET tested=true, tested_at=COALESCE(tested_at,now()), tested_by=COALESCE(NULLIF($3,''),tested_by)
       WHERE task_id=$1 AND asset_id=ANY($2::bigint[]) AND task_asset_effectively_approved(task_id,asset_id)`,
      [taskID, ids, agentKey.trim()],
    );
  }
}

// 企业范围编辑互斥锁（db/companies.go companyScopeMutationLock）。
const COMPANY_SCOPE_MUTATION_LOCK = 7337741003;

/** 服务/接口资产派生自父域名/IP，不允许单独审批（Go rejectDerivedApprovalAssets）。 */
async function rejectDerivedApprovalAssets(client: PoolClient, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const res = await client.query<{ ok: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM assets WHERE id=ANY($1::bigint[]) AND type NOT IN ('root_domain','subdomain','ip')) AS ok`,
    [ids],
  );
  if (res.rows[0]?.ok === true) {
    throw new TaskAssetInvalidError("invalid task asset association: 服务和接口无需单独审批，请操作父域名/IP");
  }
}

/** 事务内锁任务/链接行并取资产行（用于 AssetKey）；任务不存在/资产不齐时报错。 */
async function lockTaskAssetApprovalRows(client: PoolClient, taskID: number, ids: number[]): Promise<Map<number, AssetIdentity>> {
  const task = await client.query<{ ok: boolean }>(`SELECT EXISTS(SELECT 1 FROM tasks WHERE id=$1 AND deleted_at IS NULL) AS ok`, [
    taskID,
  ]);
  if (task.rows[0]?.ok !== true) throw new TaskAssetTaskNotFoundError();
  const res = await client.query<Record<string, unknown>>(
    `SELECT a.id,a.type,COALESCE(a.domain,'') AS domain,COALESCE(a.root_domain,'') AS root_domain,
    COALESCE(a.ip,'') AS ip,COALESCE(a.url,'') AS url,COALESCE(a.method,'') AS method,COALESCE(a.service_name,'') AS service_name,COALESCE(a.port,0) AS port
    FROM task_asset_links l JOIN assets a ON a.id=l.asset_id
    WHERE l.task_id=$1 AND l.asset_id=ANY($2::bigint[]) FOR UPDATE OF l`,
    [taskID, ids],
  );
  const assets = new Map<number, AssetIdentity>();
  for (const row of res.rows) {
    const id = Number(row["id"]);
    assets.set(id, {
      id,
      type: String(row["type"]),
      domain: row["domain"] as string,
      root_domain: (row["root_domain"] as string) || null,
      ip: row["ip"] as string,
      url: row["url"] as string,
      method: row["method"] as string,
      service_name: row["service_name"] as string,
      port: Number(row["port"] ?? 0),
    });
  }
  if (assets.size !== ids.length) throw new TaskAssetNotFoundError();
  return assets;
}

/** 删除/非法封禁资产不能直接批准（Go rejectDeletedApprovalAssets）。 */
async function rejectDeletedApprovalAssets(client: PoolClient, taskID: number, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const res = await client.query<{ ok: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM assets a JOIN task_asset_blocks b
    ON b.task_id=$1 AND (b.asset_id=a.id OR b.asset_key=task_asset_identity_key(a))
    WHERE a.id=ANY($2::bigint[]) AND b.block_kind IN ('deleted','invalid')) AS ok`,
    [taskID, ids],
  );
  if (res.rows[0]?.ok === true) {
    throw new TaskAssetBlockedError("task asset is blocked: 删除封禁资产请先重新关联；非法资产必须先纠正，不能直接批准");
  }
}
