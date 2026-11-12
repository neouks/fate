-- No domain/config foreign keys: retain non-content metering after deletion.
CREATE TABLE IF NOT EXISTS resource_usage (
 runtime_id TEXT NOT NULL, call_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('skill','mcp')), resource_name TEXT NOT NULL,
 server_id BIGINT, operation TEXT NOT NULL, tool_call_id TEXT NOT NULL, agent_key TEXT NOT NULL,
 task_id BIGINT, exploration_id BIGINT, conversation_id BIGINT, intent_id BIGINT, session_id TEXT, turn_id TEXT NOT NULL,
 started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
 outcome TEXT NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending','succeeded','failed')),
 PRIMARY KEY(runtime_id,call_key)
);
CREATE INDEX IF NOT EXISTS resource_usage_skill ON resource_usage(kind,resource_name,started_at DESC);
CREATE INDEX IF NOT EXISTS resource_usage_mcp ON resource_usage(server_id,started_at DESC);
CREATE INDEX IF NOT EXISTS resource_usage_task ON resource_usage(task_id,started_at DESC);
CREATE INDEX IF NOT EXISTS resource_usage_conversation ON resource_usage(conversation_id,started_at DESC);
CREATE TABLE IF NOT EXISTS resource_usage_policy (
 singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton), enabled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO resource_usage_policy(singleton) VALUES(true) ON CONFLICT DO NOTHING;

-- Results can be recovered before an older start receipt reaches the database.
CREATE TABLE IF NOT EXISTS resource_usage_results (
 runtime_id TEXT NOT NULL,call_key TEXT NOT NULL,tool_call_id TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','failed')),finished_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(runtime_id,call_key)
);
