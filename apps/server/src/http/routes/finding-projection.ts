/** Read projection only: old graph findings remain visible without creating a second record. */
export const READABLE_FINDINGS = `(
 SELECT f.id,f.node_id,f.task_id,f.name,f.vulnclass,f.severity,f.status,f.summary,f.evidence,f.report,
 f.asset_ids,f.created_at,f.evidence_version,f.report_evidence_version
 FROM findings f WHERE finding_readable(f.id)
 UNION ALL
 SELECT -n.id,n.id,t.id,COALESCE(n.payload->>'name',''),COALESCE(n.payload->>'vulnclass',''),
 COALESCE(n.payload->>'severity','medium'),COALESCE(n.payload->>'status','pending'),
 COALESCE(n.payload->>'summary',''),COALESCE(n.payload->>'evidence',''),COALESCE(n.payload->>'report',''),
 COALESCE((SELECT jsonb_agg(a.asset_id) FROM exploration_anchors a WHERE a.node_id=n.id),'[]'::jsonb),
 n.created_at,0,0
 FROM exploration_nodes n JOIN tasks t ON t.exploration_id=n.exploration_id
 WHERE n.kind='finding' AND t.deleted_at IS NULL AND exploration_node_readable(n.exploration_id,n.id)
 AND NOT EXISTS(SELECT 1 FROM findings f WHERE f.node_id=n.id)
)`;
