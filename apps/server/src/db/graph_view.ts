import type { Database } from './index.js';
import type { Node } from './exploration.js';

/** One-level, read-only inheritance. The owning task remains the authorization authority. */
export async function graphSources(db: Database, taskID: number): Promise<Array<{ taskID: number; expID: number }>> {
  const r = await db.query(`SELECT t.id,t.exploration_id FROM task_relations r JOIN tasks t ON t.id=r.source_task_id
    WHERE r.task_id=$1 AND t.deleted_at IS NULL ORDER BY t.id`, [taskID]);
  return r.rows.map(r => ({ taskID: Number(r.id), expID: Number(r.exploration_id) }));
}
export async function authorizedNodes(db: Database, taskID: number, expID: number, nodes: Node[], worker = false): Promise<Node[]> {
  const anchors = await db.exploration(expID).lineageAnchorAssetIDsForNodes(nodes.map(n => n.id));
  const ids = [...new Set([...anchors.values()].flat())];
  const states = await db.taskScope().taskAssetApprovalStates(taskID, ids);
  return nodes.filter(n => (anchors.get(n.id) ?? []).every(id => states.get(id) === 'approved' || (worker && states.get(id) === 'pending')));
}
export async function resolveGraphNode(db: Database, taskID: number, expID: number, nodeID: number, worker = false) {
  for (const owner of [{ taskID, expID }, ...await graphSources(db, taskID)]) {
    const node = await db.exploration(owner.expID).getNode(nodeID);
    if (!node) continue;
    if (!(await authorizedNodes(db, owner.taskID, owner.expID, [node], worker)).length) throw new Error('节点关联资产未获授权或已封禁');
    return { node, ...owner, inherited: owner.taskID !== taskID };
  }
  throw new Error(`节点 #${nodeID} 不存在或不属于本任务及直接来源任务`);
}
