-- Rebuildable global tool-call counts. Activity remains the source of truth;
-- this projection keeps only identities and counters needed by the catalog.
CREATE TABLE IF NOT EXISTS tool_call_rollup_state (
 singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
 format_version INT NOT NULL,ready BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO tool_call_rollup_state(singleton,format_version,ready) VALUES(true,1,false)
ON CONFLICT(singleton) DO UPDATE SET
 ready=tool_call_rollup_state.ready AND tool_call_rollup_state.format_version=EXCLUDED.format_version,
 format_version=EXCLUDED.format_version;

CREATE TABLE IF NOT EXISTS tool_call_rollup_calls (
 id BIGSERIAL PRIMARY KEY,tool TEXT NOT NULL,identity_hash TEXT NOT NULL,call_identity JSONB NOT NULL,
 started_members BIGINT NOT NULL DEFAULT 0,finished_members BIGINT NOT NULL DEFAULT 0,failed_members BIGINT NOT NULL DEFAULT 0,
 CHECK(started_members>=0 AND finished_members>=0 AND failed_members>=0)
);
-- Full JSON equality is checked after the hash, including the theoretical MD5
-- collision case and call identifiers too large for a B-tree key.
CREATE INDEX IF NOT EXISTS tool_call_rollup_identity ON tool_call_rollup_calls(tool,identity_hash);

CREATE TABLE IF NOT EXISTS tool_call_rollup_stats (
 tool TEXT PRIMARY KEY,calls BIGINT NOT NULL DEFAULT 0,succeeded BIGINT NOT NULL DEFAULT 0,
 failed BIGINT NOT NULL DEFAULT 0,unknown BIGINT NOT NULL DEFAULT 0,
 CHECK(calls>=0 AND succeeded>=0 AND failed>=0 AND unknown>=0)
);

CREATE OR REPLACE FUNCTION tool_call_rollup_identity(
 sc TEXT,sid BIGINT,worker_name TEXT,node BIGINT,segment INT,turn_id TEXT,call_id TEXT,meta JSONB,row_id BIGINT
) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN NULLIF(meta->'native_event'->>'runtime_id','') IS NOT NULL
   AND NULLIF(meta->'native_event'->>'call_key','') IS NOT NULL
  THEN jsonb_build_array('native',meta->'native_event'->>'runtime_id',meta->'native_event'->>'call_key')
  ELSE jsonb_build_array(sc,sid,worker_name,node,segment,turn_id,
    COALESCE(NULLIF(call_id,''),'row:'||row_id::text)) END
$$;

CREATE OR REPLACE FUNCTION change_tool_call_rollup(
 tool_name TEXT,identity JSONB,entry_kind TEXT,entry_failed BOOLEAN,delta INT
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE h TEXT; r tool_call_rollup_calls; old_started BOOLEAN; old_finished BOOLEAN; old_failed BOOLEAN;
 new_started BOOLEAN; new_finished BOOLEAN; new_failed BOOLEAN;
 starts BIGINT; finishes BIGINT; failures BIGINT;
BEGIN
 IF tool_name IS NULL OR entry_kind NOT IN ('tool_use','tool_result') OR delta NOT IN (-1,1) THEN RETURN;END IF;
 IF NOT COALESCE((SELECT ready FROM tool_call_rollup_state WHERE singleton),false) THEN RETURN;END IF;
 h:=md5(identity::text);
 PERFORM pg_advisory_xact_lock(hashtextextended('tool-call-rollup:'||tool_name||':'||h,0));
 SELECT * INTO r FROM tool_call_rollup_calls
  WHERE tool=tool_name AND identity_hash=h AND call_identity=identity FOR UPDATE;
 IF FOUND THEN
  starts:=r.started_members;finishes:=r.finished_members;failures:=r.failed_members;
 ELSE
  IF delta<0 THEN UPDATE tool_call_rollup_state SET ready=false WHERE singleton;RETURN;END IF;
  starts:=0;finishes:=0;failures:=0;
 END IF;
 old_started:=starts>0;old_finished:=finishes>0;old_failed:=failures>0;
 IF entry_kind='tool_use' THEN starts:=starts+delta;
 ELSE finishes:=finishes+delta;IF entry_failed THEN failures:=failures+delta;END IF;END IF;
 IF starts<0 OR finishes<0 OR failures<0 OR failures>finishes THEN
  UPDATE tool_call_rollup_state SET ready=false WHERE singleton;RETURN;
 END IF;
 new_started:=starts>0;new_finished:=finishes>0;new_failed:=failures>0;
 IF r.id IS NULL THEN
  INSERT INTO tool_call_rollup_calls(tool,identity_hash,call_identity,started_members,finished_members,failed_members)
   VALUES(tool_name,h,identity,starts,finishes,failures);
 ELSIF starts=0 AND finishes=0 THEN DELETE FROM tool_call_rollup_calls WHERE id=r.id;
 ELSE UPDATE tool_call_rollup_calls SET started_members=starts,finished_members=finishes,failed_members=failures WHERE id=r.id;
 END IF;
 INSERT INTO tool_call_rollup_stats(tool) VALUES(tool_name) ON CONFLICT DO NOTHING;
 UPDATE tool_call_rollup_stats SET
  calls=calls+(new_started::int)-(old_started::int),
  succeeded=succeeded+((new_started AND new_finished AND NOT new_failed)::int)-((old_started AND old_finished AND NOT old_failed)::int),
  failed=failed+((new_started AND new_failed)::int)-((old_started AND old_failed)::int),
  unknown=unknown+((new_started AND NOT new_finished)::int)-((old_started AND NOT old_finished)::int)
 WHERE tool=tool_name;
END $$;

CREATE OR REPLACE FUNCTION capture_tool_call_rollup() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE sc TEXT;identity JSONB;
BEGIN
 sc:=CASE WHEN TG_TABLE_NAME='activity' THEN 'task' ELSE 'conversation' END;
 IF TG_OP<>'INSERT' AND OLD.tool IS NOT NULL AND OLD.kind IN ('tool_use','tool_result') THEN
  IF sc='task' THEN
   identity:=tool_call_rollup_identity(sc,OLD.exploration_id,OLD.worker,OLD.node_id,OLD.main_seg,
    OLD.metadata->>'turn_id',OLD.tool_use_id,OLD.metadata,OLD.id);
  ELSE
   identity:=tool_call_rollup_identity(sc,OLD.conversation_id,OLD.worker,NULL,NULL,
    OLD.metadata->>'turn_id',OLD.tool_use_id,OLD.metadata,OLD.id);
  END IF;
  PERFORM change_tool_call_rollup(OLD.tool,identity,OLD.kind,OLD.is_error,-1);
 END IF;
 IF TG_OP<>'DELETE' AND NEW.tool IS NOT NULL AND NEW.kind IN ('tool_use','tool_result') THEN
  IF sc='task' THEN
   identity:=tool_call_rollup_identity(sc,NEW.exploration_id,NEW.worker,NEW.node_id,NEW.main_seg,
    NEW.metadata->>'turn_id',NEW.tool_use_id,NEW.metadata,NEW.id);
  ELSE
   identity:=tool_call_rollup_identity(sc,NEW.conversation_id,NEW.worker,NULL,NULL,
    NEW.metadata->>'turn_id',NEW.tool_use_id,NEW.metadata,NEW.id);
  END IF;
  PERFORM change_tool_call_rollup(NEW.tool,identity,NEW.kind,NEW.is_error,1);
 END IF;
 RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS zz_tool_call_rollup ON activity;
CREATE TRIGGER zz_tool_call_rollup AFTER INSERT OR UPDATE OR DELETE ON activity
 FOR EACH ROW EXECUTE FUNCTION capture_tool_call_rollup();
DROP TRIGGER IF EXISTS zz_conversation_tool_call_rollup ON conversation_activities;
CREATE TRIGGER zz_conversation_tool_call_rollup AFTER INSERT OR UPDATE OR DELETE ON conversation_activities
 FOR EACH ROW EXECUTE FUNCTION capture_tool_call_rollup();
