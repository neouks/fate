import {assetContextCTE} from './asset-query.js';

/** The exact coverage projection used by assetCoverage. No model-provided counts. */
export const goalIntegritySQL = `
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK(status IN ('created','running','paused','done','failed','timeout','needs_attention'));
CREATE TABLE IF NOT EXISTS goal_acceptance (
 id BIGSERIAL PRIMARY KEY,
 task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, goal_id BIGINT NOT NULL,
 goal_hash TEXT NOT NULL, goal_text TEXT NOT NULL,
 evidence_id BIGINT NOT NULL, evidence_hash TEXT NOT NULL,
 method TEXT NOT NULL CHECK(method IN ('coverage','manual')),
 status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
 coverage JSONB, note TEXT NOT NULL DEFAULT '', source_call TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), reviewed_at TIMESTAMPTZ,
 reviewed_by TEXT
);
CREATE INDEX IF NOT EXISTS goal_acceptance_latest ON goal_acceptance(goal_id,id DESC);
DROP TRIGGER IF EXISTS goal_acceptance_projection ON goal_acceptance;
CREATE TRIGGER goal_acceptance_projection AFTER INSERT OR UPDATE OR DELETE ON goal_acceptance FOR EACH ROW EXECUTE FUNCTION invalidate_graph_projection();
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS status_reason TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS task_state_corrections (
 id BIGSERIAL PRIMARY KEY,task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 old_status TEXT NOT NULL,new_status TEXT NOT NULL,reason TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE exploration_nodes ADD COLUMN IF NOT EXISTS acceptance_revision BIGINT NOT NULL DEFAULT 1;
CREATE OR REPLACE FUNCTION advance_goal_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='goal' AND (OLD.payload->>'text',OLD.payload->>'vulnclass') IS DISTINCT FROM (NEW.payload->>'text',NEW.payload->>'vulnclass') THEN
  NEW.acceptance_revision:=OLD.acceptance_revision+1;
  NEW.state:='open';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS goal_acceptance_revision ON exploration_nodes;
CREATE TRIGGER goal_acceptance_revision BEFORE UPDATE OF payload ON exploration_nodes FOR EACH ROW EXECUTE FUNCTION advance_goal_revision();
CREATE OR REPLACE FUNCTION goal_text_hash(p_id BIGINT) RETURNS TEXT LANGUAGE sql STABLE AS $$
 SELECT md5(jsonb_build_array(acceptance_revision,payload->>'text',payload->>'vulnclass')::text)
 FROM exploration_nodes WHERE id=p_id AND kind='goal';
$$;
CREATE OR REPLACE FUNCTION goal_evidence_hash(p_id BIGINT) RETURNS TEXT LANGUAGE sql STABLE AS $$
 SELECT md5(jsonb_build_array(n.payload,n.state,n.content_version,f.evidence,f.status)::text)
 FROM exploration_nodes n LEFT JOIN findings f ON f.node_id=n.id WHERE n.id=p_id;
$$;
CREATE OR REPLACE FUNCTION goal_coverage_snapshot(p_task BIGINT) RETURNS JSONB LANGUAGE sql STABLE AS $$
 WITH ${assetContextCTE.replaceAll('$1','p_task')}
 SELECT jsonb_build_object('enabled',COALESCE((SELECT coverage_enabled FROM tasks WHERE id=p_task),false),
  'denominator',count(*),'tested',count(*) FILTER(WHERE a.id IN(SELECT asset_id FROM tested)),
  'evidence_fingerprint',(SELECT md5(COALESCE(string_agg(jsonb_build_array(n.id,goal_evidence_hash(n.id),e.asset_id)::text,',' ORDER BY n.id,e.asset_id),'')) FROM exploration_nodes n JOIN exploration_anchors e ON e.node_id=n.id JOIN context_tasks c ON c.exploration_id=n.exploration_id WHERE n.kind IN('fact','finding') AND e.asset_id IN(SELECT id FROM target)),
  'fingerprint',md5(COALESCE(string_agg(jsonb_build_array(a.id,a.content_version,a.id IN(SELECT asset_id FROM tested))::text,',' ORDER BY a.id),'')))
 FROM assets a JOIN target t ON t.id=a.id;
$$;
CREATE OR REPLACE FUNCTION goal_acceptance_valid(p_id BIGINT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
 SELECT COALESCE((SELECT p.status='approved' AND p.goal_hash=goal_text_hash(p.goal_id)
  AND p.evidence_hash=goal_evidence_hash(p.evidence_id)
  AND g.kind='goal' AND g.state='met' AND g.exploration_id=t.exploration_id AND t.deleted_at IS NULL
  AND e.kind IN('fact','finding') AND e.state='confirmed'
  AND COALESCE(e.payload->>'observation_type','observed') NOT IN('negative','inferred','unknown')
  AND COALESCE(e.payload->>'acceptance_status','')<>'unverified'
  AND exploration_node_readable(t.exploration_id,e.id)
  AND (e.exploration_id=t.exploration_id OR EXISTS(SELECT 1 FROM task_relations r JOIN tasks s ON s.id=r.source_task_id
    WHERE r.task_id=t.id AND s.exploration_id=e.exploration_id AND s.deleted_at IS NULL))
  AND (p.method='manual' OR (p.coverage=goal_coverage_snapshot(p.task_id)
    AND p.coverage->>'enabled'='true' AND (p.coverage->>'denominator')::bigint>0
    AND (p.coverage->>'tested')::bigint=(p.coverage->>'denominator')::bigint))
 FROM goal_acceptance p JOIN tasks t ON t.id=p.task_id JOIN exploration_nodes g ON g.id=p.goal_id
 JOIN exploration_nodes e ON e.id=p.evidence_id WHERE p.id=p_id),false);
$$;
CREATE OR REPLACE FUNCTION task_goal_progress(p_exp BIGINT)
RETURNS TABLE(total BIGINT,met BIGINT,ready BOOLEAN) LANGUAGE sql STABLE AS $$
 WITH counts AS (
  SELECT count(*) total,count(*) FILTER(WHERE goal_acceptance_valid((SELECT id FROM goal_acceptance p WHERE p.goal_id=g.id ORDER BY id DESC LIMIT 1))) met
  FROM exploration_nodes g WHERE exploration_id=p_exp AND kind='goal'
 )
 SELECT counts.total,counts.met,counts.total>0 AND NOT EXISTS(
  SELECT 1 FROM tasks t JOIN goals_bootstrap b ON b.task_id=t.id WHERE t.exploration_id=p_exp AND b.phase<>'completed') FROM counts;
$$;
CREATE OR REPLACE FUNCTION goal_display_state(p_goal BIGINT) RETURNS TEXT LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN goal_acceptance_valid(p.id) THEN 'met'
 WHEN p.status='pending' AND p.goal_hash=goal_text_hash(p.goal_id) AND p.evidence_hash=goal_evidence_hash(p.evidence_id) THEN 'pending_confirmation'
 ELSE 'open' END FROM (SELECT 1) placeholder LEFT JOIN LATERAL
 (SELECT * FROM goal_acceptance WHERE goal_id=p_goal ORDER BY id DESC LIMIT 1) p ON true;
$$;
-- Final authority, including direct legacy setters. Never accept a bare met flag.
CREATE OR REPLACE FUNCTION guard_task_success() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='done' AND NOT EXISTS(
  SELECT 1 FROM task_goal_progress(NEW.exploration_id) WHERE ready AND total>0 AND total=met)
 THEN RAISE EXCEPTION '全部有效目标尚未核验，不能将任务标记为已完成' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS task_success_guard ON tasks;
CREATE TRIGGER task_success_guard BEFORE INSERT OR UPDATE OF status ON tasks FOR EACH ROW EXECUTE FUNCTION guard_task_success();
CREATE OR REPLACE FUNCTION invalidate_completed_task_goals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eid BIGINT;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.payload->>'text',OLD.payload->>'vulnclass') IS NOT DISTINCT FROM (NEW.payload->>'text',NEW.payload->>'vulnclass') THEN RETURN NEW; END IF;
 eid:=CASE WHEN TG_OP='DELETE' THEN OLD.exploration_id ELSE NEW.exploration_id END;
 IF (CASE WHEN TG_OP='DELETE' THEN OLD.kind ELSE NEW.kind END)<>'goal' THEN RETURN NULL; END IF;
 WITH previous AS (SELECT id,status FROM tasks WHERE exploration_id=eid AND status IN ('done','failed','timeout')), changed AS (
  UPDATE tasks SET status='needs_attention',status_reason='目标已变更，旧完成结论失效；等待重新核验',paused=false,queued=false,completed_at=NULL
  WHERE exploration_id=eid AND status IN ('done','failed','timeout') AND deleted_at IS NULL RETURNING id
 ) INSERT INTO task_state_corrections(task_id,old_status,new_status,reason)
 SELECT changed.id,previous.status,'needs_attention','目标变更，不自动恢复执行' FROM changed JOIN previous USING(id);
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS goal_change_invalidates_success ON exploration_nodes;
CREATE TRIGGER goal_change_invalidates_success AFTER INSERT OR UPDATE OF payload OR DELETE ON exploration_nodes
 FOR EACH ROW EXECUTE FUNCTION invalidate_completed_task_goals();
CREATE OR REPLACE FUNCTION task_display_status(p_task BIGINT) RETURNS TEXT LANGUAGE sql STABLE AS $$
 SELECT CASE
 WHEN EXISTS(SELECT 1 FROM runtime_task_commands c WHERE c.task_id=t.id AND c.command='pause' AND c.status='pending') THEN 'pausing'
 WHEN t.paused THEN 'paused'
 WHEN t.status='done' AND NOT EXISTS(SELECT 1 FROM task_goal_progress(t.exploration_id) WHERE ready AND total>0 AND total=met) THEN 'needs_attention'
 WHEN t.status IN ('done','failed','timeout','needs_attention') THEN t.status
 WHEN t.queued THEN 'queued'
 WHEN t.status='running' AND NOT EXISTS(SELECT 1 FROM engine_task_leases l WHERE l.task_id=t.id AND l.expires_at>now()) THEN 'needs_attention'
 ELSE t.status END FROM tasks t WHERE t.id=p_task;
$$;
CREATE OR REPLACE FUNCTION task_display_reason(p_task BIGINT) RETURNS TEXT LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN task_display_status(t.id)='needs_attention' THEN COALESCE(NULLIF(t.status_reason,''),
  CASE WHEN t.status='done' THEN '旧完成标记缺少当前有效证明，等待核验' ELSE '当前没有有效执行租约，等待处理' END) ELSE '' END
 FROM tasks t WHERE t.id=p_task;
$$;
`;
