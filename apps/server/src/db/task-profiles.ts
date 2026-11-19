import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { graphProjectionRevision } from "./graph-projection.js";
import { profileSources, readProfileComponents } from "./profile-sources.js";
import { assetContextCTE } from "./asset-query.js";
import type { Database } from "./index.js";

interface Observation {
  type: string;
  asset_id: string;
  domain: string | null;
  service: string | null;
  bound_domains: string[];
  technologies: string[];
  title: string | null;
  url: string | null;
  method: string | null;
  status_code: number | null;
  seen: string;
  waf: unknown;
  source_ip_block: unknown;
}

// Protection observations are optional structured evidence in assets.extra.
// Only a dated boolean observation can establish a state. Never infer it from HTTP status.
function protection(raw: unknown, requiresSourceIP: boolean) {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.detected !== "boolean" || typeof value.observed_at !== "string" ||
      !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/i.test(value.observed_at) ||
      !Number.isFinite(Date.parse(value.observed_at))) return null;
  const source = typeof value.source_ip === "string" && isIP(value.source_ip) ? value.source_ip : null;
  if (requiresSourceIP && !source) return null;
  return { detected: value.detected, observed_at: value.observed_at, source_ip: source };
}

async function socketProfiles(db: Database, taskId: number, page: number, limit: number, bound: string[]) {
  // paginate distinct sockets before joining asset observations. Host names and
  // ports on service/endpoint rows were parsed from their URLs by the asset writer.
  const result = await db.query(`
    WITH ${assetContextCTE}, scoped AS (
      SELECT a.id,a.type,a.port,a.service_name,a.open_ports,try_inet(COALESCE(NULLIF(a.ip,''),NULLIF(trim(both '[]' from a.domain),''))) AS addr
      FROM assets a JOIN visible v ON v.id=a.id WHERE a.type IN ('ip','service','endpoint')
    ), sockets AS MATERIALIZED (
      SELECT a.id,a.addr,port_info.port,port_info.service
      FROM scoped a CROSS JOIN LATERAL (
        SELECT a.port, a.service_name AS service WHERE a.type IN ('service','endpoint')
        UNION ALL
        SELECT CASE WHEN p->>'port' ~ '^[0-9]{1,5}$' THEN (p->>'port')::int END, p->>'service'
        FROM unnest(a.open_ports) p WHERE a.type='ip'
      ) port_info
      WHERE a.addr IS NOT NULL AND masklen(a.addr)=CASE family(a.addr) WHEN 4 THEN 32 ELSE 128 END
        AND port_info.port BETWEEN 1 AND 65535
    ), keys AS (
      SELECT DISTINCT addr,port FROM sockets
    ), page_keys AS (
      SELECT addr,port FROM keys
      ORDER BY addr,port LIMIT $2 OFFSET $3
    ), members AS MATERIALIZED (
      SELECT s.*,a.type,a.domain,a.bound_domains,a.technologies,a.page_title,a.url,a.method,a.status_code,a.last_seen,
        CASE WHEN a.type<>'ip' THEN a.extra->'waf' END waf,
        CASE WHEN a.type<>'ip' THEN a.extra->'source_ip_block' END source_ip_block
      FROM page_keys k JOIN sockets s USING(addr,port) JOIN assets a ON a.id=s.id
    )
    SELECT host(k.addr) ip,k.port,tally.total,
      ARRAY(SELECT b.id::text FROM unnest($4::bigint[]) b(id) WHERE NOT EXISTS (
        SELECT 1 FROM sockets s JOIN scoped a ON s.id=a.id WHERE s.id=b.id AND a.type<>'ip')) standalone,
      (SELECT jsonb_agg(jsonb_build_object('asset_id',o.id::text,'type',o.type,'domain',o.domain,'service',o.service,
        'bound_domains',o.bound_domains,'technologies',o.technologies,'title',o.page_title,
        'url',o.url,'method',o.method,'status_code',o.status_code,'seen',o.last_seen,'waf',o.waf,'source_ip_block',o.source_ip_block)
        ORDER BY o.last_seen DESC,o.id DESC) FROM members o WHERE (o.addr,o.port)=(k.addr,k.port)) observations
    FROM (SELECT count(*)::int total FROM keys) tally LEFT JOIN page_keys k ON true ORDER BY k.addr,k.port`, [taskId, limit, (page - 1) * limit, bound]);
  return {
    page,
    standalone: (result.rows[0]?.standalone ?? []) as string[],
    total: Number(result.rows[0]?.total ?? 0),
    items: result.rows.filter(row => row.ip != null).map(row => ({
      ip: row.ip, port: row.port,
      observations: (row.observations as Observation[]).map(o => ({
        ...o, waf: protection(o.waf, false), source_ip_block: protection(o.source_ip_block, true),
      })),
    })),
  };
}

export async function taskProfiles(db: Database, taskId: number, exp: number, page: number, limit: number, previous?: string) {
  return db.transaction(async tx => {
    if (!db.transactionClient) await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const graph = await graphProjectionRevision(tx, taskId, exp);
    const sources = await profileSources(tx, exp);
    const revision = createHash('sha256').update(JSON.stringify([taskId, page, limit, graph, sources])).digest('hex');
    if (previous === revision) return { revision, unchanged: true };
    const components = await readProfileComponents(tx, taskId, exp, sources, !db.transactionClient);
    const bound = [...new Set(components.flatMap(c => c.asset_id ? [c.asset_id] : []))];
    const { standalone, ...sockets } = await socketProfiles(tx, taskId, page, limit, bound);
    const pageAssets = new Set(sockets.items.flatMap(p => p.observations.filter(o => o.type !== 'ip').map(o => o.asset_id)));
    return {
      ...sockets,
      revision,
      components: components.filter(c => !c.asset_id || standalone.includes(c.asset_id) || pageAssets.has(c.asset_id)),
      standalone_asset_ids: standalone,
    };
  });
}
