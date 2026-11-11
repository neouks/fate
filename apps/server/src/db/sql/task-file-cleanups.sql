CREATE TABLE IF NOT EXISTS task_file_cleanups (
  id UUID PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  candidates JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  result JSONB NOT NULL DEFAULT '{}',
  expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() + interval '10 minutes'
);
CREATE INDEX IF NOT EXISTS task_file_cleanups_expiry_idx ON task_file_cleanups(expires_at);
