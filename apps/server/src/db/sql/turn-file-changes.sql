CREATE TABLE IF NOT EXISTS turn_file_changes (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT REFERENCES tasks(id) ON DELETE CASCADE,
  conversation_id BIGINT REFERENCES conversations(id) ON DELETE CASCADE,
  intent_id BIGINT REFERENCES exploration_nodes(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  path TEXT NOT NULL,
  base_hash TEXT,
  base_text TEXT,
  base_status TEXT NOT NULL,
  last_hash TEXT,
  status TEXT NOT NULL,
  additions INTEGER,
  deletions INTEGER,
  patch TEXT,
  CHECK (num_nonnulls(task_id, conversation_id) = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS turn_file_changes_task_idx
  ON turn_file_changes(task_id, turn_id, path) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS turn_file_changes_conversation_idx
  ON turn_file_changes(conversation_id, turn_id, path) WHERE conversation_id IS NOT NULL;
