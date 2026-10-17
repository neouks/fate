// 资产图测试：归一化/解析纯函数（不依赖 PG）+ upsert 去重合并与公司归属（连本地开发库，
// 无库时跳过，模式同 exploration.core.test.ts）。
// 运行：cd apps/server && npx vitest run src/db/assets.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDatabase, type Database } from "./index.js";
import {
  AssetStore,
  calcCSegment,
  companyNKey,
  domainKey,
  looksLikeIPAddress,
  marshalJSONBArray,
  marshalStringArray,
  normalizeICP,
  normalizeURL,
  parseAutoScopeLine,
  parseCIDR,
  parseIP,
  parseScopeInput,
  parseScopeLine,
  parseURL,
  rootDomain,
  validateAssetIP,
  AssetIPInvalidError,
} from "./assets.js";

// ─── 纯函数（不依赖 PG）──────────────────────────────────────────────────────

describe("assets normalization (pure)", () => {
  it("domainKey：trim + 小写 + 去一个尾点", () => {
    expect(domainKey("  Example.COM. ")).toBe("example.com");
    expect(domainKey("example.com..")).toBe("example.com.");
    expect(domainKey("")).toBe("");
  });

  it("parseIP：规范化为 Go net.IP.String() 语义", () => {
    expect(parseIP("1.2.3.4")).toBe("1.2.3.4");
    expect(parseIP("2001:0DB8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
    expect(parseIP("0:0:0:0:0:0:0:1")).toBe("::1");
    expect(parseIP("::")).toBe("::");
    expect(parseIP("::ffff:192.0.2.1")).toBe("192.0.2.1"); // v4 映射 → 点分十进制
    expect(parseIP("fe80::")).toBe("fe80::");
    expect(parseIP("1:2:3:4:5:6:7:8")).toBe("1:2:3:4:5:6:7:8");
    // 非法输入（与 Go net.ParseIP 一致，不做 trim）
    expect(parseIP("1.2.3")).toBeNull();
    expect(parseIP("1.2.3.256")).toBeNull();
    expect(parseIP("1::2::3")).toBeNull();
    expect(parseIP("fe80::1%eth0")).toBeNull();
    expect(parseIP("example.com")).toBeNull();
    expect(parseIP(" 1.2.3.4")).toBeNull();
    expect(parseIP("12345::")).toBeNull();
  });

  it("parseCIDR：网络地址掩码 + 前缀长度", () => {
    expect(parseCIDR("192.168.1.5/24")).toEqual({ network: "192.168.1.0/24", ones: 24, bits: 32 });
    expect(parseCIDR("10.0.0.0/8")?.network).toBe("10.0.0.0/8");
    expect(parseCIDR("1.2.3.4/0")?.network).toBe("0.0.0.0/0");
    expect(parseCIDR("2001:db8::/32")).toEqual({ network: "2001:db8::/32", ones: 32, bits: 128 });
    expect(parseCIDR("2001:db8:1:2:3:4:5:6/48")?.network).toBe("2001:db8:1::/48");
    expect(parseCIDR("1.2.3.4")).toBeNull();
    expect(parseCIDR("1.2.3.4/33")).toBeNull();
    expect(parseCIDR("2001:db8::/129")).toBeNull();
    expect(parseCIDR("/24")).toBeNull();
  });

  it("calcCSegment：IPv4→/24、IPv6→/48", () => {
    expect(calcCSegment("1.2.3.4")).toBe("1.2.3.0/24");
    expect(calcCSegment("10.20.30.40")).toBe("10.20.30.0/24");
    expect(calcCSegment("2001:db8:1234:5678::1")).toBe("2001:db8:1234::/48");
    expect(calcCSegment("2001:0DB8:1234:5678:9ABC:DEF0:1.2.3.4")).toBe("2001:db8:1234::/48");
    expect(calcCSegment("fe80::1")).toBe("fe80::/48");
    expect(calcCSegment("")).toBe("");
    expect(calcCSegment("not-an-ip")).toBe("");
  });

  it("rootDomain：eTLD+1；IP/未分类主机以自身为根", () => {
    expect(rootDomain("a.b.example.co.uk")).toEqual({ root: "example.co.uk", isApex: false });
    expect(rootDomain("example.com")).toEqual({ root: "example.com", isApex: true });
    expect(rootDomain("EXAMPLE.com.")).toEqual({ root: "example.com", isApex: true });
    // 未知 TLD（非 ICANN）：默认 * 规则，主机自身为根（Go publicsuffix 同行为）
    expect(rootDomain("x.localhost")).toEqual({ root: "x.localhost", isApex: true });
    expect(rootDomain("foo")).toEqual({ root: "foo", isApex: true });
    expect(rootDomain("1.2.3.4")).toEqual({ root: "1.2.3.4", isApex: true });
    expect(rootDomain("")).toEqual({ root: "", isApex: true });
  });

  it("normalizeURL：scheme/host 小写、裸根去尾斜杠、保留大小写路径与查询", () => {
    expect(normalizeURL("HTTP://Example.COM:8080/")).toBe("http://example.com:8080");
    expect(normalizeURL("http://example.com")).toBe("http://example.com");
    expect(normalizeURL("http://example.com/")).toBe("http://example.com");
    expect(normalizeURL("http://example.com/?q=1")).toBe("http://example.com/?q=1");
    expect(normalizeURL("https://EXAMPLE.com/A/B?q=1#Frag")).toBe("https://example.com/A/B?q=1#Frag");
    expect(normalizeURL("http://User@Example.COM:8080/x")).toBe("http://User@example.com:8080/x");
    expect(normalizeURL("http://[2001:DB8::1]:8080/x")).toBe("http://[2001:db8::1]:8080/x");
    expect(normalizeURL("example.com")).toBe("example.com"); // 无 scheme：原样（Go 相对 URL 语义）
  });

  it("parseURL：domain/port/service_name 提取与默认端口", () => {
    expect(parseURL("http://example.com:8080/x")).toEqual({ domain: "example.com", port: 8080, serviceName: "HTTP" });
    expect(parseURL("https://x.io")).toEqual({ domain: "x.io", port: 443, serviceName: "HTTPS" });
    expect(parseURL("ftp://x.io:21")).toEqual({ domain: "x.io", port: 21, serviceName: "FTP" });
    expect(parseURL("http://[2001:db8::1]:9000/p")).toEqual({ domain: "2001:db8::1", port: 9000, serviceName: "HTTP" });
    expect(parseURL("http://x.io:abc/")).toEqual({ domain: "x.io", port: 80, serviceName: "HTTP" }); // 非法端口回退默认
    expect(parseURL("example.com")).toEqual({ domain: "", port: 0, serviceName: "" });
  });

  it("marshal 数组字面量：PG text[]/jsonb[] 转义", () => {
    expect(marshalStringArray([])).toBe("{}");
    expect(marshalStringArray(["a", "b"])).toBe('{"a","b"}');
    expect(marshalStringArray(['a"b'])).toBe('{"a\\"b"}');
    expect(marshalJSONBArray([])).toBe("{}");
    expect(marshalJSONBArray([{ port: 22, service: "ssh" }])).toBe('{"{\\"port\\":22,\\"service\\":\\"ssh\\"}"}');
  });

  it("validateAssetIP：空/合法放行，主机名拒绝", () => {
    expect(() => validateAssetIP("")).not.toThrow();
    expect(() => validateAssetIP("2001:db8::1")).not.toThrow();
    expect(() => validateAssetIP("web.example.com")).toThrow(AssetIPInvalidError);
  });

  it("normalizeICP / companyNKey / looksLikeIPAddress", () => {
    expect(normalizeICP(" 京 ICP 备 123 号 ")).toBe("京icp备123号");
    expect(companyNKey("  Foo   Bar Ltd.  ")).toBe("foo bar ltd.");
    expect(looksLikeIPAddress("1.2.3.4")).toBe(true);
    expect(looksLikeIPAddress("999.1.1.1")).toBe(true); // 形似而非合法
    expect(looksLikeIPAddress("fe80::1")).toBe(true);
    expect(looksLikeIPAddress("abc")).toBe(false);
    expect(looksLikeIPAddress("http://1.2.3.4")).toBe(false);
    expect(looksLikeIPAddress("1.2.3.4 x")).toBe(false);
  });

  it("parseScopeLine：domain/ip/cidr 分类与护栏", () => {
    expect(parseScopeLine("example.com")).toEqual({ kind: "domain", domain: "example.com", raw: "example.com" });
    expect(parseScopeLine("www.Example.COM.").domain).toBe("www.example.com"); // 存原样主机，不折叠到根
    expect(parseScopeLine("https://example.com/login").domain).toBe("example.com");
    expect(parseScopeLine("例子.公司.cn").domain).toBe("xn--fsqu00a.xn--55qx5d.cn"); // IDNA 转写
    expect(parseScopeLine("1.2.3.4")).toEqual({ kind: "ip", net: "1.2.3.4/32", raw: "1.2.3.4" });
    expect(parseScopeLine("fe80::1").net).toBe("fe80::1/128");
    expect(parseScopeLine("10.0.0.0/24")).toEqual({ kind: "cidr", net: "10.0.0.0/24", raw: "10.0.0.0/24" });
    expect(parseScopeLine("10.0.0.0/16").net).toBe("10.0.0.0/16"); // /16 恰好放行
    expect(parseScopeLine("2001:db8::/32").net).toBe("2001:db8::/32");
    // 护栏
    expect(() => parseScopeLine("10.0.0.0/15")).toThrow("网段过宽");
    expect(() => parseScopeLine("2001:db8::/31")).toThrow("网段过宽");
    expect(() => parseScopeLine("co.uk")).toThrow("不能用裸 TLD");
    expect(() => parseScopeLine("公司.cn")).toThrow("不能用裸 TLD");
    expect(() => parseScopeLine("")).toThrow("空行");
    expect(() => parseScopeLine("1.2.3.999")).toThrow("无效 IP");
    expect(() => parseScopeLine("1.2.3.4-1.2.3.9")).toThrow("IP 段请用 CIDR");
  });

  it("parseAutoScopeLine：无类型行自动分类", () => {
    expect(parseAutoScopeLine("京ICP备12345678号-1").kind).toBe("icp");
    expect(parseAutoScopeLine("京ICP备12345678号-1").value).toBe("京icp备12345678号-1");
    expect(parseAutoScopeLine("腾讯云计算")).toEqual({ kind: "keyword", value: "腾讯云计算", raw: "腾讯云计算" });
    expect(parseAutoScopeLine("example company ltd").kind).toBe("keyword");
    expect(parseAutoScopeLine("icp.example.com").kind).toBe("domain"); // 带点优先按域名
    expect(parseAutoScopeLine("fe80::1").kind).toBe("ip");
    expect(() => parseAutoScopeLine("999.1.1.1")).toThrow("无效 IP");
    expect(() => parseAutoScopeLine("10.0.0.999/24")).toThrow("无效 CIDR");
    expect(() => parseAutoScopeLine("10.0.0.0/8")).toThrow("网段过宽"); // 有效 CIDR 交给 ParseScopeLine 校验
    expect(() => parseAutoScopeLine("   ")).toThrow("空行");
  });

  it("parseScopeInput：显式类型 + manual 路径", () => {
    expect(parseScopeInput({ kind: "domain", value: "example.com" }).kind).toBe("domain");
    expect(() => parseScopeInput({ kind: "ip", value: "example.com" })).toThrow("不是有效的 ip 范围");
    expect(parseScopeInput({ kind: "icp", value: " 京 ICP 备 1 号 " }).value).toBe("京icp备1号");
    expect(() => parseScopeInput({ kind: "icp", value: "  " })).toThrow("ICP 不能为空");
    expect(parseScopeInput({ kind: "keyword", value: "Foo  Bar" }).value).toBe("foo bar");
    expect(() => parseScopeInput({ kind: "weird", value: "x" })).toThrow("不支持的范围类型");
    // manual：URL/证书不强制分类，垃圾文本落 keyword
    expect(parseScopeInput({ value: "Example.com ", manual: true })).toEqual({
      kind: "domain",
      domain: "example.com",
      raw: "Example.com",
    });
    expect(parseScopeInput({ value: "10.0.0.0/24", manual: true }).kind).toBe("cidr");
    expect(parseScopeInput({ value: "https://x.com/a", manual: true }).kind).toBe("keyword");
    expect(parseScopeInput({ value: "-----BEGIN CERT-----", manual: true }).kind).toBe("keyword");
    expect(parseScopeInput({ value: "not a domain!!", manual: true }).kind).toBe("keyword");
  });
});

// ─── PG 集成（upsert 去重合并 / 公司归属）─────────────────────────────────────

const TEST_DSN = process.env.SERIES_TEST_PG_DSN ?? "postgres://series:series@127.0.0.1:5433/series_test?sslmode=disable";

let haveDB = true;
let db: Database | null = null;
let s: AssetStore | null = null;
let taskA = 0, taskB = 0;
const fixtureExps: number[] = [];

// 每次运行独立的一组资产：自定义 TLD ".test" 下 eTLD+1 = tcorp<run>.test，
// 与其他运行/其他公司的 domain 规则互不干扰（eTLD+1 会折叠到 example.com，无法隔离）。
const RUN = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const ROOT = `tcorp${RUN}.test`;
const IP_A = "198.51.100.10";
const IP_B = "198.51.100.11";
const IP_C = "198.51.100.20";
const IP_LATE = "203.0.113.5";
const IP6_LATE = "2001:db8:aa::5";
const ICP_ROOT = `京ICP备${RUN}号-1`;
const ICP_APP = `京ICP备${RUN}号-2`;

let companyB = 0;

async function cleanup(database: Database): Promise<void> {
  await database.query(
    `DELETE FROM assets WHERE root_domain = $1 OR domain LIKE '%' || $1 || '%' OR url LIKE '%' || $1 || '%'
       OR ip = ANY($2::text[])`,
    [ROOT, [IP_A, IP_B, IP_C, IP_LATE, IP6_LATE]],
  );
  await database.query(`DELETE FROM companies WHERE nkey LIKE 'ts assets%'`);
}

// 本地开发库与正在运行的 server 共享：资产 upsert 可能撞上 server 侧写入造成的死锁（40P01）。
// PG 的标准做法是重试被选为牺牲者的事务。
async function retryOnDeadlock<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || (err as { code?: string }).code !== "40P01") throw err;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
}

beforeAll(async () => {
  process.env.SERIES_PG_DSN = TEST_DSN;
  try {
    db = await openDatabase();
  } catch {
    haveDB = false;
    return;
  }
  await cleanup(db);
  s = new AssetStore(db);
  for (const name of ["asset-fixture-a", "asset-fixture-b"]) {
    const task = await db.tasks().createTaskWithOptions(name, name, {});
    fixtureExps.push(task.exploration_id);
    if (!taskA) taskA = task.id; else taskB = task.id;
  }
});

afterAll(async () => {
  if (db) await cleanup(db).catch(() => undefined);
  if (db) {
    await db.query(`DELETE FROM tasks WHERE id=ANY($1::bigint[])`, [[taskA, taskB]]);
    await db.query(`DELETE FROM explorations WHERE id=ANY($1::bigint[])`, [fixtureExps]);
  }
  await db?.close().catch(() => undefined);
});

describe.skipIf(!haveDB)("asset store upsert & attribution (PG)", () => {
  it("companies upsert：nkey 归一去重", async () => {
    const first = await retryOnDeadlock(() => s!.companies.upsertCompany("TS Assets 归属甲", ""));
    expect(first.created).toBe(true);
    const again = await retryOnDeadlock(() => s!.companies.upsertCompany("TS   assets   归属甲", "http://logo/x.png"));
    expect(again.created).toBe(false);
    expect(again.id).toBe(first.id);
    const got = await s!.companies.getCompanyByName(" ts  assets 归属甲 ");
    expect(got!.id).toBe(first.id);
    expect(got!.logo).toBe("http://logo/x.png");
  });

  it("createCompanyWithScope：混合行分类（domain/cidr/icp 入库，护栏行记 invalid）", async () => {
    const res = await retryOnDeadlock(() =>
      s!.companies.createCompanyWithScope(
      "TS Assets 归属乙",
      "",
      [{ value: ROOT }, { value: "198.51.100.0/24" }, { kind: "icp", value: ` 京 ICP 备 ${RUN} 号 ` }, { value: "10.0.0.0/8" }],
      "测试",
    ));
    expect(res.added).toBe(3);
    expect(res.invalid).toBe(1);
    expect(res.validationErrors.length).toBe(1);
    companyB = res.id;
    const scope = await s!.companies.getScope(companyB);
    expect(scope.map((r) => r.kind).sort()).toEqual(["cidr", "domain", "icp"]);
    expect(scope.find((r) => r.kind === "domain")!.domain).toBe(ROOT);
    expect(scope.find((r) => r.kind === "cidr")!.net).toBe("198.51.100.0/24");
    expect(scope.find((r) => r.kind === "icp")!.value).toBe(`京icp备${RUN}号`);
  });

  it("upsertRootDomain：幂等合并 + task_ids 并集 + 域名 scope 归属", async () => {
    const id1 = await retryOnDeadlock(() => s!.upsertRootDomain({ domain: ` ${ROOT.toUpperCase()}. `, taskID: taskA }));
    const id2 = await retryOnDeadlock(() => s!.upsertRootDomain({ domain: ROOT, icp: ICP_ROOT, taskID: taskB }));
    expect(id2).toBe(id1);
    const res = await db!.query<{ task_ids: string; company_id: string | null; icp: string | null }>(
      `SELECT array_to_json(task_ids)::text AS task_ids, company_id::text, icp FROM assets WHERE id=$1`,
      [id1],
    );
    const row = res.rows[0]!;
    expect([...JSON.parse(row.task_ids)].sort((a: number, b: number) => a - b)).toEqual([taskA, taskB]);
    expect(Number(row.company_id)).toBe(companyB);
    expect(row.icp).toBe(ICP_ROOT); // COALESCE 保留后写入的非空值
  });

  it("upsertSubdomain：A 记录副作用（根域 + IP 资产 + 绑定域名）+ /24 c_segment", async () => {
    // RecordValue 单元素内逗号分隔（legacy 格式）
    const subID = await retryOnDeadlock(() =>
      s!.upsertSubdomain({
      domain: `a.${ROOT}`,
      recordType: "a",
      recordValue: [`${IP_A},${IP_B}`],
      taskID: taskA,
    }));
    const sub = (await s!.getByIDs([subID]))[0]!;
    expect(sub.type).toBe("subdomain");
    expect(sub.domain).toBe(`a.${ROOT}`);
    expect(sub.root_domain).toBe(ROOT);
    expect(sub.ip).toBe(IP_A);
    expect(sub.c_segment).toBe("198.51.100.0/24");
    expect(sub.company_id).toBe(companyB);
    expect(sub.record_value).toEqual([`${IP_A},${IP_B}`]);

    // 副作用：IP 资产建行并绑定子域
    const ips = await db!.query<{ id: string; bd: string; company_id: string | null }>(
      `SELECT id, array_to_json(bound_domains)::text AS bd, company_id::text
       FROM assets WHERE type='ip' AND ip = ANY($1::text[]) ORDER BY ip`,
      [[IP_A, IP_B]],
    );
    expect(ips.rows.length).toBe(2);
    for (const r of ips.rows) {
      expect(JSON.parse(r.bd)).toContain(`a.${ROOT}`);
      expect(Number(r.company_id)).toBe(companyB); // IP/CIDR scope 归属
    }
  });

  it("upsertIP：open_ports/bound_domains 合并 + task_ids 并集", async () => {
    const ip1 = await retryOnDeadlock(() =>
      s!.upsertIP({
      ip: IP_C,
      boundDomains: [`x.${ROOT}`],
      openPorts: [
        { port: 443, service: "https" },
        { port: 22, service: "ssh" },
      ],
      taskID: 201,
    }));
    const ip2 = await retryOnDeadlock(() =>
      s!.upsertIP({
      ip: IP_C,
      boundDomains: [`y.${ROOT}`],
      openPorts: [{ port: 80, service: "http" }],
      taskID: 202,
    }));
    expect(ip2).toBe(ip1);
    const a = (await s!.getByIDs([ip1]))[0]!;
    expect([...a.task_ids].sort((x, y) => x - y)).toEqual([201, 202]);
    expect(a.c_segment).toBe("198.51.100.0/24");
    expect(a.open_ports.map((p) => Number(p["port"])).sort((x, y) => x - y)).toEqual([22, 80, 443]);
    expect(a.bound_domains).toContain(`x.${ROOT}`);
    expect(a.bound_domains).toContain(`y.${ROOT}`);
    expect(a.company_id).toBe(companyB);
  });

  it("upsertHTTPService：URL 归一去重 + 字段合并 + 主机/IP 副作用", async () => {
    const h1 = await retryOnDeadlock(() =>
      s!.upsertHTTPService({
      url: `HTTP://A.${ROOT}:8443/`, // 裸根尾斜杠会被 normalizeURL 剥掉
      technologies: ["nginx"],
      ip: IP_A,
      taskID: 301,
    }));
    const h2 = await retryOnDeadlock(() =>
      s!.upsertHTTPService({
      url: `http://a.${ROOT}:8443`,
      statusCode: 200,
      contentLength: 1234,
      pageTitle: "登录页",
      technologies: ["nginx", "openssl"],
      taskID: 302,
    }));
    expect(h2).toBe(h1);
    const svc = (await s!.getByIDs([h1]))[0]!;
    expect(svc.url).toBe(`http://a.${ROOT}:8443`);
    expect(svc.service_type).toBe("http");
    expect(svc.service_name).toBe("HTTP"); // scheme=http → 服务名 HTTP（Go 同规则）
    expect(svc.domain).toBe(`a.${ROOT}`);
    expect(svc.root_domain).toBe(ROOT);
    expect(svc.port).toBe(8443);
    expect(svc.status_code).toBe(200);
    expect(svc.content_length).toBe(1234);
    expect(svc.page_title).toBe("登录页");
    expect(svc.technologies).toEqual(["nginx", "openssl"]);
    expect(svc.company_id).toBe(companyB);

    // IP 副作用：8443 端口与绑定域名写回 ip 资产
    const ipRow = (await db!.query<{ id: string }>(`SELECT id FROM assets WHERE type='ip' AND ip=$1`, [IP_A])).rows[0]!;
    const ipAsset = (await s!.getByIDs([Number(ipRow.id)]))[0]!;
    expect(ipAsset.open_ports.map((p) => Number(p["port"]))).toContain(8443);
    expect(ipAsset.bound_domains).toContain(`a.${ROOT}`);
  });

  it("upsertOtherService：service_name 小写去重 + linkHostAssets 联动", async () => {
    const o1 = await retryOnDeadlock(() => s!.upsertOtherService({ domain: `b.${ROOT}`, port: 22, serviceName: "SSH", taskID: 401 }));
    const o2 = await retryOnDeadlock(() => s!.upsertOtherService({ domain: `B.${ROOT}`, port: 22, serviceName: "ssh", taskID: 402 }));
    expect(o2).toBe(o1);
    const other = (await s!.getByIDs([o1]))[0]!;
    expect(other.service_type).toBe("other");
    expect(other.service_name).toBe("ssh");
    expect(other.company_id).toBe(companyB);
    // 主机联动：b.<root> 子域资产入图
    const sub = await db!.query<{ id: string }>(`SELECT id FROM assets WHERE type='subdomain' AND domain=$1`, [
      `b.${ROOT}`,
    ]);
    expect(sub.rows.length).toBe(1);
  });

  it("upsertEndpoint：method 归一 + params 按 (location,name) 合并去重", async () => {
    const e1 = await retryOnDeadlock(() =>
      s!.upsertEndpoint({
      url: `https://a.${ROOT}/api/v1/users`,
      method: "post",
      params: [{ location: "query", name: "id", value: "1" }],
      taskID: 501,
    }));
    const e2 = await retryOnDeadlock(() =>
      s!.upsertEndpoint({
      url: `https://a.${ROOT}/api/v1/users`,
      method: "POST",
      params: [
        { location: "query", name: "id", value: "2" },
        { location: "header", name: "X-Token", value: "abc" },
      ],
      taskID: 502,
    }));
    expect(e2).toBe(e1);
    const ep = (await s!.getByIDs([e1]))[0]!;
    expect(ep.method).toBe("POST");
    expect([...ep.task_ids].sort((x, y) => x - y)).toEqual([501, 502]);
    expect(ep.params.length).toBe(2);
    const idParam = ep.params.find((p) => p["name"] === "id")!;
    expect(idParam["value"]).toBe("2"); // elem::text DESC 取最新值
    expect(ep.params.some((p) => p["name"] === "X-Token")).toBe(true);
    expect(ep.company_id).toBe(companyB);
  });

  it("upsertApp：bundle_id/app_name 双键去重 + ICP 精确归属", async () => {
    const appCo = await retryOnDeadlock(() =>
      s!.companies.createCompanyWithScope("TS Assets 归属丙", "", [
      { kind: "icp", value: ICP_APP },
    ], ""));
    const a1 = await retryOnDeadlock(() =>
      s!.upsertApp({
      name: "测试应用",
      bundleID: `com.tsassets.${RUN}`,
      category: "工具",
      icp: ICP_APP,
      taskID: 601,
    }));
    const a2 = await retryOnDeadlock(() => s!.upsertApp({ name: "测试应用", bundleID: `com.tsassets.${RUN}`, taskID: 602 }));
    expect(a2).toBe(a1);
    const app = (await s!.getByIDs([a1]))[0]!;
    expect(app.app_name).toBe("测试应用");
    expect(app.category).toBe("工具"); // 空 COALESCE 保留旧值
    expect(app.app_icp).toBe(ICP_APP);
    expect(app.company_id).toBe(appCo.id); // ICP 自动归属
    expect([...app.task_ids].sort((x, y) => x - y)).toEqual([601, 602]);

    // 无 bundle_id → app_name 冲突键
    const n1 = await retryOnDeadlock(() => s!.upsertApp({ name: `无包名应用${RUN}`, taskID: 601 }));
    const n2 = await retryOnDeadlock(() => s!.upsertApp({ name: `无包名应用${RUN}`, description: "补描述", taskID: 602 }));
    expect(n2).toBe(n1);
    const nApp = (await s!.getByIDs([n1]))[0]!;
    expect(nApp.app_description).toBe("补描述");
    expect(nApp.bundle_id).toBe("");
  });

  it("scope 后补触发 recompute：已存在资产被补归属（v4/v6 CIDR）", async () => {
    const preID = await retryOnDeadlock(() => s!.upsertIP({ ip: IP_LATE }));
    const pre6ID = await retryOnDeadlock(() => s!.upsertIP({ ip: IP6_LATE.toUpperCase() })); // 大写十六进制 → 规范化
    expect((await s!.getByIDs([preID]))[0]!.company_id).toBeUndefined();
    expect((await s!.getByIDs([pre6ID]))[0]!.company_id).toBeUndefined();
    expect((await s!.getByIDs([pre6ID]))[0]!.ip).toBe(IP6_LATE);

    const res = await retryOnDeadlock(() => s!.companies.addScope(companyB, ["203.0.113.0/25", "2001:db8:aa::/48"], "后补"));
    expect(res.added).toBe(2);
    expect(res.invalid).toBe(0);

    expect((await s!.getByIDs([preID]))[0]!.company_id).toBe(companyB);
    expect((await s!.getByIDs([pre6ID]))[0]!.company_id).toBe(companyB);
    // 重复添加同一规则 → skipped
    const dup = await retryOnDeadlock(() => s!.companies.addScope(companyB, ["203.0.113.0/25"], "重复"));
    expect(dup.added).toBe(0);
    expect(dup.skipped).toBe(1);
  });

  it("resolveCompanyWithICP 优先级：domain > IP/CIDR > ICP", async () => {
    const other = await s!.companies.upsertByName(`TS Assets 归属丁`); // 无任何 scope
    // domain 命中优先于 ICP
    expect(await s!.companies.resolveCompanyWithICP(ROOT, "", ICP_APP)).toBe(companyB);
    // IP 命中
    expect(await s!.companies.resolveCompanyWithICP("", IP_A, "")).toBe(companyB);
    // 无匹配 → null
    expect(await s!.companies.resolveCompanyWithICP("nomatch.invalid", "192.0.2.99", "无备案")).toBeNull();
    expect(other).toBeGreaterThan(0);
  });

  it("hostsByTask + countsByType + queryByCompany", async () => {
    const hosts = await s!.hostsByTask(taskA);
    expect(hosts).toContain(ROOT);
    expect(hosts).toContain(`a.${ROOT}`);
    expect(hosts).toContain(IP_A);
    expect(hosts).toContain(IP_B);

    const counts = await s!.countsByType();
    expect(counts.get("ip") ?? 0).toBeGreaterThanOrEqual(3);
    expect(counts.get("root_domain") ?? 0).toBeGreaterThanOrEqual(1);

    const byCompany = await s!.queryByCompany(companyB, "ip", 10, 0);
    expect(byCompany.length).toBeGreaterThan(0);
    expect(byCompany.every((a) => a.type === "ip" && a.company_id === companyB)).toBe(true);
  });
});
