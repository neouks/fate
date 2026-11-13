-- Append-only provenance for in-place finding supplementation. Never merge old rows.
CREATE TABLE IF NOT EXISTS finding_write_receipts (
 task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 call_id TEXT NOT NULL, source_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 finding_id BIGINT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
 result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(task_id,call_id)
);
CREATE TABLE IF NOT EXISTS finding_evidence_amendments (
 id BIGSERIAL PRIMARY KEY,
 finding_id BIGINT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
 task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 evidence_version BIGINT NOT NULL, source_key TEXT NOT NULL, call_id TEXT,
 before_record JSONB NOT NULL, changes JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(finding_id,evidence_version)
);
CREATE INDEX IF NOT EXISTS finding_duplicate_candidates ON findings(task_id,lower(btrim(vulnclass)),id);
