ALTER TABLE administrative_audit_events
  ADD COLUMN IF NOT EXISTS operation text NOT NULL DEFAULT 'legacy';

ALTER TABLE administrative_audit_events
  ADD COLUMN IF NOT EXISTS target_id text NOT NULL DEFAULT 'world';

CREATE INDEX IF NOT EXISTS administrative_audit_events_world_tick_idx
  ON administrative_audit_events(world_id, tick DESC, created_at DESC);
