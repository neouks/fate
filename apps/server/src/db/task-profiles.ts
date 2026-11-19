import { isIP } from "node:net";
import { assetContextCTE } from "./asset-query.js";
import type { Database } from "./index.js";

interface Observation {
  asset_id: string;
  domain: string | null;
  service: string | null;
  bound_domains: string[];
  technologies: string[];
  title: string | null;
  fingerprint: string | null;
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

export async function taskProfiles(db: Database, taskId: number, page: number, limit: number) {
  // paginate distinct sockets before joining observations or activities. Host names and
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
      SELECT s.*,a.type,a.domain,a.bound_domains,a.technologies,a.page_title,a.favicon_mmh3,a.last_seen,
        CASE WHEN a.type<>'ip' THEN a.extra->'waf' END waf,
        CASE WHEN a.type<>'ip' THEN a.extra->'source_ip_block' END source_ip_block
      FROM page_keys k JOIN sockets s USING(addr,port) JOIN assets a ON a.id=s.id
    ), observations AS (
      SELECT DISTINCT ON (addr,port,domain,service,bound_domains,technologies,page_title,favicon_mmh3,waf,source_ip_block)
        * FROM members
      ORDER BY addr,port,domain,service,bound_domains,technologies,page_title,favicon_mmh3,waf,source_ip_block,last_seen DESC,id DESC
    ), checks AS (
      SELECT DISTINCT m.addr,m.port,n.id,n.state,left(COALESCE(NULLIF(n.payload->>'summary',''),n.payload->>'text'),240) AS summary
      FROM members m JOIN exploration_anchors x ON x.asset_id=m.id
      JOIN exploration_nodes n ON n.id=x.node_id AND n.kind='intent'
      JOIN context_tasks t ON t.task_id=$1 AND t.exploration_id=n.exploration_id
      WHERE m.type<>'ip' AND exploration_node_readable(t.exploration_id,n.id)
    )
    SELECT host(k.addr) ip,k.port,tally.total,
      (SELECT jsonb_agg(jsonb_build_object('asset_id',o.id::text,'domain',o.domain,'service',o.service,
        'bound_domains',o.bound_domains,'technologies',o.technologies,'title',o.page_title,
        'fingerprint',o.favicon_mmh3,'seen',o.last_seen,'waf',o.waf,'source_ip_block',o.source_ip_block)
        ORDER BY o.last_seen DESC,o.id DESC) FROM observations o WHERE (o.addr,o.port)=(k.addr,k.port)) observations,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('intent_id',c.id::text,'state',c.state,'summary',c.summary,
        'activity', (SELECT a.id::text FROM activity a JOIN context_tasks t ON t.exploration_id=a.exploration_id AND t.task_id=$1
         WHERE a.node_id=c.id AND a.kind<>'round' AND exploration_activity_readable(a.exploration_id,a.node_id,a.metadata)
         ORDER BY a.id DESC LIMIT 1)) ORDER BY c.id DESC)
        FROM checks c WHERE (c.addr,c.port)=(k.addr,k.port)), '[]') checks
    FROM (SELECT count(*)::int total FROM keys) tally LEFT JOIN page_keys k ON true ORDER BY k.addr,k.port`, [taskId, limit, (page - 1) * limit]);
  return {
    page,
    total: Number(result.rows[0]?.total ?? 0),
    items: result.rows.filter(row => row.ip != null).map(row => ({
      ip: row.ip, port: row.port, checks: row.checks,
      observations: (row.observations as Observation[]).map(o => ({
        ...o, waf: protection(o.waf, false), source_ip_block: protection(o.source_ip_block, true),
      })),
    })),
  };
}
