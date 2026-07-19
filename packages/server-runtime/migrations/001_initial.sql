-- Applied by PostgresWorldPersistence.migrate(). Keep this file for operator review
-- and forward-only migration history; the runtime embeds the same initial schema.
CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS worlds (id text PRIMARY KEY, seed bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS accounts (id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS players (id text PRIMARY KEY, account_id uuid NULL REFERENCES accounts(id), world_id text NOT NULL REFERENCES worlds(id), state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sessions (id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id), player_id text NULL REFERENCES players(id), expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS settlements (id text PRIMARY KEY, world_id text NOT NULL REFERENCES worlds(id), owner_player_id text NOT NULL REFERENCES players(id), state jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS world_checkpoints (world_id text NOT NULL REFERENCES worlds(id), id uuid PRIMARY KEY, tick bigint NOT NULL, schema_version integer NOT NULL, state jsonb NOT NULL, state_hash text NOT NULL, completed boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz NULL);
CREATE INDEX IF NOT EXISTS world_checkpoints_completed_idx ON world_checkpoints(world_id, completed, tick DESC);
CREATE TABLE IF NOT EXISTS chunk_snapshots (checkpoint_id uuid NOT NULL REFERENCES world_checkpoints(id), chunk_x integer NOT NULL, chunk_y integer NOT NULL, state jsonb NOT NULL, PRIMARY KEY(checkpoint_id, chunk_x, chunk_y));
CREATE TABLE IF NOT EXISTS command_journal (id text PRIMARY KEY, world_id text NOT NULL REFERENCES worlds(id), target_tick bigint NOT NULL, command jsonb NOT NULL, accepted_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS command_journal_replay_idx ON command_journal(world_id, target_tick, accepted_at);
CREATE TABLE IF NOT EXISTS administrative_audit_events (id uuid PRIMARY KEY, world_id text NOT NULL REFERENCES worlds(id), actor_id text NOT NULL, reason text NOT NULL, before_state jsonb NULL, after_state jsonb NULL, tick bigint NULL, created_at timestamptz NOT NULL DEFAULT now());
