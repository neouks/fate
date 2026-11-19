import type { Database } from "./index.js";
import { assetContextCTE } from "./asset-query.js";
import { extractComponents, groupComponents, type ComponentSource, type ProfileAsset } from "./profile-components.js";

type SourceRow = ComponentSource & { stamp: string; anchors: string[] };
export async function profileSources(db: Database, exp: number) {
  const result = await db.query<SourceRow & Record<string, unknown>>(
    `
    SELECT 'activity' kind,a.id::text,a.xmin::text stamp,a.created_at seen,
      CASE WHEN a.kind='user' THEN '用户' WHEN a.worker IN ('main','mainagent') THEN 'Main'
        WHEN a.worker='planner' THEN 'Planner' ELSE 'Worker' END role,
      CASE WHEN a.worker IN ('main','mainagent') THEN 'main:'||coalesce(a.main_seg,0)
        WHEN a.worker='planner' THEN 'plan' ELSE 'intent:'||a.node_id END session, '{}'::text[] anchors
    FROM activity a WHERE a.exploration_id=$1 AND NOT a.is_error
      AND exploration_activity_readable($1,a.node_id,a.metadata)
      AND NOT (a.metadata @> '{"raw_source_only":true}' OR a.metadata @> '{"interrupted":true}' OR a.metadata ? 'worker_feedback')
      AND a.metadata->>'event_type' IS DISTINCT FROM 'steering'
      AND ((a.kind='user' AND a.worker IN ('main','mainagent'))
        OR (a.node_id IS NOT NULL AND a.kind='result' AND a.metadata @> '{"event_type":"outcome","status":"done"}')
        OR (a.worker IN ('main','mainagent','planner') AND a.kind IN ('text','assistant')
          AND (a.metadata @> '{"final_answer":true}' OR
            (a.metadata#>>'{response,stop_reason}'='stop' AND a.metadata#>>'{response,has_tools}'='false'))
          AND EXISTS (SELECT 1 FROM activity t WHERE t.exploration_id=a.exploration_id AND t.worker=a.worker
            AND t.metadata->>'turn_id'=a.metadata->>'turn_id' AND t.metadata @> '{"event_type":"lifecycle","status":"completed"}')))
    UNION ALL
    SELECT 'fact',n.id::text,n.xmin::text,n.created_at,coalesce(nullif(n.origin,''),'fact'),NULL,
      ARRAY(SELECT x.asset_id::text FROM exploration_anchors x WHERE x.node_id=n.id ORDER BY x.asset_id)
    FROM exploration_nodes n WHERE n.exploration_id=$1 AND n.kind='fact' AND n.state='confirmed'
      AND coalesce(n.payload->>'observation_type','unknown') NOT IN ('negative','inferred')
      AND exploration_node_readable($1,n.id)
    ORDER BY kind,id`,
    [exp],
  );
  return result.rows.map((r) => ({ ...r, seen: new Date(r.seen).toISOString() }));
}

type Parsed = ReturnType<typeof extractComponents>;
// Cache parsed declarations only. Re-evaluate the visible source IDs, anchors and
// ownership in the current read snapshot on every request, including cache hits.
const caches = new WeakMap<object, Map<string, Parsed>>();
export async function readProfileComponents(
  db: Database,
  task: number,
  exp: number,
  sources: SourceRow[],
  cacheable: boolean,
) {
  const cache = cacheable ? (caches.get(db.pool) ?? new Map<string, Parsed>()) : new Map<string, Parsed>();
  if (cacheable) caches.set(db.pool, cache);
  const key = (s: SourceRow) => [exp, s.kind, s.id, s.stamp].join(":");
  const parsed = new Map<string, Parsed>();
  for (const kind of ["fact", "activity"] as const) {
    const missing = sources.filter((s) => {
      if (s.kind !== kind) return false;
      const found = cache.get(key(s));
      if (found) parsed.set(key(s), found);
      return !found;
    });
    for (let i = 0; i < missing.length; i += 64) {
      const batch = missing.slice(i, i + 64);
      const body =
        kind === "activity"
          ? "coalesce(nullif(detail,''),summary,'')"
          : "concat_ws(E'\\n',payload->>'summary',payload->>'detail',payload->>'evidence')";
      const table = kind === "activity" ? "activity" : "exploration_nodes";
      const rows = await db.query<{ id: string; body: string }>(
        `SELECT id::text, ${body} body FROM ${table}
        WHERE exploration_id=$1 AND id=ANY($2::bigint[])`,
        [exp, batch.map((s) => s.id)],
      );
      const byId = new Map(rows.rows.map((r) => [r.id, r.body]));
      for (const s of batch) {
        const value = extractComponents(byId.get(s.id) ?? "");
        parsed.set(key(s), value);
        if (cache.size >= 4096) cache.delete(cache.keys().next().value!);
        if (value.length <= 100 && JSON.stringify(value).length <= 4096) cache.set(key(s), value);
      }
    }
  }
  const records = sources.flatMap((s) => {
    const mentions = parsed.get(key(s)) ?? [];
    const { stamp, anchors, ...source } = s;
    return mentions.length ? [{ source, anchors, mentions }] : [];
  });
  if (!records.length) return [];
  const { rows: assets } = await db.query<ProfileAsset & Record<string, unknown>>(
    `WITH ${assetContextCTE}
    SELECT a.id::text,a.type,a.domain,a.ip,a.port,a.url FROM visible v JOIN assets a ON a.id=v.id`,
    [task],
  );
  return groupComponents(records, assets);
}
