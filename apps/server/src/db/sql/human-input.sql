CREATE TABLE IF NOT EXISTS human_input_requests (
 id UUID PRIMARY KEY,
 task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 runtime_id TEXT NOT NULL REFERENCES runtime_role_configs(id),
 role TEXT NOT NULL CHECK(role IN ('worker','planner','mainagent')),
 turn_id TEXT NOT NULL,
 intent_id BIGINT,
 main_seg INTEGER NOT NULL DEFAULT 0,
 tool_call_id TEXT,
 activity_id BIGINT,
 owner_key TEXT NOT NULL,
 owner_token TEXT NOT NULL,
 question TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('input','select','confirm','editor')),
 options JSONB,
 placeholder TEXT,
 sensitive BOOLEAN NOT NULL DEFAULT FALSE,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','answered','cancelled','expired','interrupted')),
 answer JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ,
 delivered_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS human_input_one_pending ON human_input_requests(runtime_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS human_input_task_recent ON human_input_requests(task_id,created_at DESC);

ALTER TABLE human_input_requests ADD COLUMN IF NOT EXISTS activity_id BIGINT;
