import { createHash } from "node:crypto";
import type { Database } from "../db/index.js";

export interface ColdNode { id: number; kind: string; state: string; coldSince: number | null; }
export interface ColdEdge { from: number; to: number; }
/** Original ARTEX semantics: live intents, all their ancestors and immediate children stay hot. */
export function coldBlocks(nodes: ColdNode[], edges: ColdEdge[], round: number, age = 6): { cold: Set<number>; blocks: number[][] } {
  const byID = new Map(nodes.map((n) => [n.id, n]));
  const parents = new Map<number, number[]>(), children = new Map<number, number[]>();
  for (const e of edges) {
    if (!byID.has(e.from) || !byID.has(e.to)) continue;
    parents.set(e.to, [...(parents.get(e.to) ?? []), e.from]);
    children.set(e.from, [...(children.get(e.from) ?? []), e.to]);
  }
  const live = nodes.filter((n) => n.kind === "intent" && ["open", "running", "paused"].includes(n.state));
  const hot = new Set<number>(), stack = live.map((n) => n.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (hot.has(id)) continue;
    hot.add(id); stack.push(...parents.get(id) ?? []);
  }
  for (const n of live) for (const id of children.get(n.id) ?? []) hot.add(id);
  const cold = new Set(nodes.filter((n) => ["intent", "fact"].includes(n.kind) && n.state !== "origin" && !hot.has(n.id)).map((n) => n.id));
  const eligible = new Set(nodes.filter((n) => cold.has(n.id) && n.coldSince !== null && round - n.coldSince >= age).map((n) => n.id));
  const components: number[][] = [], visited = new Set<number>();
  for (const id of eligible) {
    if (visited.has(id)) continue;
    const group: number[] = [], todo = [id];
    while (todo.length) {
      const next = todo.pop()!;
      if (visited.has(next) || !eligible.has(next)) continue;
      visited.add(next); group.push(next);
      todo.push(...parents.get(next) ?? [], ...children.get(next) ?? []);
    }
    components.push(group);
  }
  // Only rescue singleton siblings. A hot shared parent is never folded into the block.
  const singles = components.filter((g) => g.length === 1).flat();
  const roots = new Map(singles.map((id) => [id, id]));
  const root = (id: number): number => { while (roots.get(id) !== id) id = roots.get(id)!; return id; };
  const siblings = new Map<number, number>();
  for (const id of singles) for (const parent of parents.get(id) ?? []) {
    const sibling = siblings.get(parent);
    if (sibling !== undefined) roots.set(root(id), root(sibling)); else siblings.set(parent, id);
  }
  const rescued = new Map<number, number[]>();
  for (const id of singles) rescued.set(root(id), [...(rescued.get(root(id)) ?? []), id]);
  return { cold, blocks: [...components.filter((g) => g.length > 1), ...rescued.values()].filter((g) => g.length > 1).map((g) => g.sort((a, b) => a - b)) };
}

/** Extractive, deterministic compaction. No evidence is deleted and no LLM can invent digest facts. */
export async function compactColdGraph(db: Database, expID: number): Promise<void> {
  const tx = await db.pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock($1)", [expID]);
    const rounds = await tx.query(`UPDATE explorations SET round_no=round_no+1 WHERE id=$1 RETURNING round_no`, [expID]);
    const round = Number(rounds.rows[0].round_no);
    const raw = await tx.query(`SELECT id,kind,state,payload,cold_since_round FROM exploration_nodes WHERE exploration_id=$1 AND kind<>'digest' ORDER BY id FOR UPDATE`, [expID]);
    const edges = await tx.query(`SELECT src_id,dst_id FROM exploration_edges WHERE exploration_id=$1 AND rel<>'covers'`, [expID]);
    const nodes = raw.rows.map((r) => ({ id: Number(r.id), kind: String(r.kind), state: String(r.state), coldSince: r.cold_since_round === null ? null : Number(r.cold_since_round) }));
    const { cold, blocks } = coldBlocks(nodes, edges.rows.map((r) => ({ from: Number(r.src_id), to: Number(r.dst_id) })), round);
    await tx.query(`UPDATE exploration_nodes SET cold_since_round=CASE WHEN id=ANY($2::bigint[]) THEN COALESCE(cold_since_round,$3) ELSE NULL END WHERE exploration_id=$1 AND kind<>'digest'`, [expID, [...cold], round]);
    const existing = await tx.query(`SELECT id,payload FROM exploration_nodes WHERE exploration_id=$1 AND kind='digest' AND state='active'`, [expID]);
    const keep: number[] = [];
    const byID = new Map(raw.rows.map((r) => [Number(r.id), r]));
    for (const block of blocks) {
      const members = block.map((id) => byID.get(id)!);
      const fingerprint = createHash("sha256").update(JSON.stringify(members.map((n) => [n.id,n.state,n.payload]))).digest("hex");
      const same = existing.rows.find((n) => n.payload.fingerprint === fingerprint);
      if (same) { keep.push(Number(same.id)); continue; }
      const summary = members.map((n) => `#${n.id} ${n.kind}/${n.state}: ${String(n.payload.summary ?? n.payload.text ?? "").slice(0, 240)}`).join("\n").slice(0, 6000);
      const created = await tx.query(`INSERT INTO exploration_nodes(exploration_id,kind,state,payload,origin) VALUES ($1,'digest','active',$2::jsonb,'system') RETURNING id`, [expID, JSON.stringify({ summary, member_ids: block, fingerprint, mode: "extractive", round })]);
      const id = Number(created.rows[0].id); keep.push(id);
      await tx.query(`INSERT INTO exploration_edges(exploration_id,src_id,rel,dst_id) SELECT $1,$2,'covers',unnest($3::bigint[]) ON CONFLICT DO NOTHING`, [expID, id, block]);
      await tx.query(`INSERT INTO exploration_anchors(node_id,asset_id) SELECT $1,asset_id FROM exploration_anchors WHERE node_id=ANY($2::bigint[]) ON CONFLICT DO NOTHING`, [id, block]);
    }
    await tx.query(`UPDATE exploration_nodes SET state='superseded' WHERE exploration_id=$1 AND kind='digest' AND state='active' AND NOT id=ANY($2::bigint[])`, [expID, keep]);
    await tx.query("COMMIT");
  } catch (err) { await tx.query("ROLLBACK"); throw err; }
  finally { tx.release(); }
}
