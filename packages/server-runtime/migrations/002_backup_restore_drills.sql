-- Records evidence from isolated restore drills. Applied forward-only after 001_initial.sql.
CREATE TABLE IF NOT EXISTS backup_restore_drills (
  id uuid PRIMARY KEY,
  backup_created_at timestamptz NOT NULL,
  restored_at timestamptz NOT NULL DEFAULT now(),
  source_database text NOT NULL,
  target_database text NOT NULL,
  checkpoint_id uuid NULL,
  checkpoint_tick bigint NULL,
  state_hash text NULL,
  backup_sha256 text NOT NULL,
  verified boolean NOT NULL,
  operator text NOT NULL,
  notes text NULL
);
