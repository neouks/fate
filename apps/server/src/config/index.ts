// 运行时配置：JSON 文件 + 环境变量覆盖（SERIES_CONFIG / SERIES_PG_DSN / SERIES_SKILL_DIR）。
// 平移自 Go 版 config 包；BaseDir 语义简化为进程工作目录（Node 部署形态下配置随 CWD 解析）。

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export interface DatabaseConfig {
  dsn?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  dbname?: string;
  sslmode?: string;
}

export interface SeriesConfig {
  database?: DatabaseConfig;
  skill_dir?: string;
}

/** 配置文件路径。优先级：SERIES_CONFIG > ./config.json（CWD）。首个存在的文件胜出。 */
export function configPath(): string {
  const env = process.env.SERIES_CONFIG?.trim();
  if (env) return resolve(env);
  const cwdCandidate = join(process.cwd(), "config.json");
  if (existsSync(cwdCandidate)) return cwdCandidate;
  return cwdCandidate;
}

/** 读取并解析配置文件。缺失/损坏返回空对象（调用方回退默认值），不抛错。 */
export function loadConfig(): SeriesConfig {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) as SeriesConfig;
  } catch {
    return {};
  }
}

/** skill 根目录：SERIES_SKILL_DIR > 配置文件 skill_dir > ./skills。目录不存在则创建。 */
export function skillDir(): string {
  const env = process.env.SERIES_SKILL_DIR?.trim();
  const cfg = loadConfig().skill_dir?.trim();
  const dir = env || cfg || join(process.cwd(), "skills");
  mkdirSync(dir, { recursive: true });
  return resolve(dir);
}

function buildDSN(db: DatabaseConfig): string {
  const params = new URLSearchParams();
  if (db.sslmode && db.sslmode !== "disable") params.set("sslmode", db.sslmode);
  const qs = params.toString();
  const auth = db.user ? `${encodeURIComponent(db.user)}${db.password ? ":" + encodeURIComponent(db.password) : ""}@` : "";
  const hostPart = db.host ?? "127.0.0.1";
  const portPart = db.port ? `:${db.port}` : "";
  return `postgres://${auth}${hostPart}${portPart}/${db.dbname ?? ""}${qs ? "?" + qs : ""}`;
}

export interface DSNResult {
  dsn: string;
  source: string;
}

/** PostgreSQL 连接串。SERIES_PG_DSN > 配置文件（dsn 或分字段）。两者皆无则报错。 */
export function postgresDSN(): DSNResult {
  const env = process.env.SERIES_PG_DSN?.trim();
  if (env) return { dsn: env, source: "环境变量 SERIES_PG_DSN" };
  const db = loadConfig().database ?? {};
  if (db.dsn?.trim()) {
    return { dsn: db.dsn.trim(), source: `配置文件 ${configPath()} (database.dsn)` };
  }
  if (db.host || db.dbname || db.user) {
    return { dsn: buildDSN(db), source: `配置文件 ${configPath()} (database 字段)` };
  }
  throw new Error(
    `未找到数据库配置：环境变量 SERIES_PG_DSN 未设置，且配置文件 ${configPath()} 未提供 database（dsn 或 host/user/dbname）。请创建该配置文件或设置环境变量后重试`,
  );
}

/** 日志脱敏：保留 DSN 结构，抹掉密码。 */
export function redactDSN(dsn: string): string {
  return dsn.replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/, "$1***@");
}
