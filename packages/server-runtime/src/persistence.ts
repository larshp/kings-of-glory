import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { Building, Command, Threat, WorldState } from '@kings/simulation';
import {
  chunkKeyFor,
  deserializeWorld,
  inspectWorld,
  snapshot,
  stateHash,
} from '@kings/simulation';
import type { AdministrativeAuditEvent } from './admin.js';

export const WORLD_ID = 'global';
const CHECKPOINT_RETENTION = 3;
export interface JournalEntry {
  readonly command: Command;
  readonly targetTick: number;
}
export interface CompletedCheckpoint {
  readonly checkpointId: string;
  readonly tick: number;
  readonly state: WorldState;
  readonly stateHash: string;
  /** Dirty chunks written alongside this checkpoint, when available. */
  readonly dirtyChunks?: readonly string[];
}
export interface CheckpointEvidence {
  readonly id: string;
  readonly tick: number;
  readonly stateHash: string;
}
export interface PersistedChunkSnapshot {
  readonly chunk: { readonly x: number; readonly y: number };
  readonly tick: number;
  readonly buildings: Readonly<Record<string, Building>>;
  readonly threats: Readonly<Record<string, Threat>>;
  readonly minedTiles: Readonly<Record<string, number>>;
}
export interface WorldPersistence {
  migrate(): Promise<void>;
  loadLatestCheckpoint(): Promise<CompletedCheckpoint | undefined>;
  loadJournalAfter(tick: number): Promise<readonly JournalEntry[]>;
  appendAcceptedCommand(entry: JournalEntry): Promise<void>;
  saveCheckpoint(state: WorldState, dirtyChunks?: readonly string[]): Promise<CompletedCheckpoint>;
  commitAdministrativeMutation(
    state: WorldState,
    audit: AdministrativeAuditEvent,
  ): Promise<CompletedCheckpoint>;
  loadAdministrativeAuditEvents(limit: number): Promise<readonly AdministrativeAuditEvent[]>;
  close(): Promise<void>;
}

/** Development adapter and deterministic recovery-test double. */
export class MemoryWorldPersistence implements WorldPersistence {
  #checkpoints: CompletedCheckpoint[] = [];
  #journal: JournalEntry[] = [];
  #administrativeAuditEvents: AdministrativeAuditEvent[] = [];
  async migrate(): Promise<void> {}
  async loadLatestCheckpoint(): Promise<CompletedCheckpoint | undefined> {
    return this.#checkpoints.at(-1);
  }
  async loadJournalAfter(tick: number): Promise<readonly JournalEntry[]> {
    return this.#journal
      .filter((entry) => entry.targetTick >= tick)
      .map((entry) => structuredClone(entry));
  }
  async appendAcceptedCommand(entry: JournalEntry): Promise<void> {
    this.#journal.push(structuredClone(entry));
  }
  async saveCheckpoint(
    state: WorldState,
    dirtyChunks: readonly string[] = [],
  ): Promise<CompletedCheckpoint> {
    const checkpoint: CompletedCheckpoint = {
      checkpointId: randomUUID(),
      tick: state.tick,
      state: snapshot(state),
      stateHash: stateHash(state),
      dirtyChunks: [...new Set(dirtyChunks)].sort((left, right) => left.localeCompare(right)),
    };
    this.#checkpoints.push(checkpoint);
    this.#checkpoints = this.#checkpoints.slice(-CHECKPOINT_RETENTION);
    const oldestRetainedTick = this.#checkpoints[0]?.tick ?? checkpoint.tick;
    this.#journal = this.#journal.filter((entry) => entry.targetTick > oldestRetainedTick);
    return checkpoint;
  }
  async commitAdministrativeMutation(
    state: WorldState,
    audit: AdministrativeAuditEvent,
  ): Promise<CompletedCheckpoint> {
    const checkpoint = await this.saveCheckpoint(state);
    this.#administrativeAuditEvents.push(structuredClone(audit));
    return checkpoint;
  }
  administrativeAuditEvents(): readonly AdministrativeAuditEvent[] {
    return structuredClone(this.#administrativeAuditEvents);
  }
  async loadAdministrativeAuditEvents(limit: number): Promise<readonly AdministrativeAuditEvent[]> {
    return structuredClone(this.#administrativeAuditEvents.slice(-limit).reverse());
  }
  async close(): Promise<void> {}
}

const chunkCoordinates = (chunk: string) => {
  const [xText, yText, extra] = chunk.split(':');
  const x = Number(xText);
  const y = Number(yText);
  if (extra !== undefined || !Number.isSafeInteger(x) || !Number.isSafeInteger(y))
    throw new Error(`Invalid dirty chunk key: ${chunk}`);
  return { x, y };
};

const recordsInChunk = <T extends { x: number; y: number }>(
  records: Readonly<Record<string, T>>,
  chunk: string,
) =>
  Object.fromEntries(
    Object.entries(records)
      .filter(([, entity]) => chunkKeyFor(entity.x, entity.y) === chunk)
      .sort(([left], [right]) => left.localeCompare(right)),
  ) as Record<string, T>;

/**
 * A chunk-local durable projection. Full checkpoint state remains the recovery
 * source; these records make each completed checkpoint auditable and ready for
 * incremental restoration without duplicating unrelated chunk data.
 */
export const snapshotDirtyChunk = (state: WorldState, chunk: string): PersistedChunkSnapshot => {
  const coordinates = chunkCoordinates(chunk);
  const minedTiles = Object.fromEntries(
    Object.entries(state.minedTiles)
      .filter(([tile]) => {
        const [xText, yText] = tile.split(':');
        return chunkKeyFor(Number(xText), Number(yText)) === chunk;
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    chunk: coordinates,
    tick: state.tick,
    buildings: recordsInChunk(state.buildings, chunk),
    threats: recordsInChunk(state.threats, chunk),
    minedTiles,
  };
};

export const INITIAL_MIGRATION_SQL = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());`,
  `CREATE TABLE IF NOT EXISTS worlds (id text PRIMARY KEY, seed bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now());`,
  `CREATE TABLE IF NOT EXISTS accounts (id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());`,
  `CREATE TABLE IF NOT EXISTS players (id text PRIMARY KEY, account_id uuid NULL REFERENCES accounts(id), world_id text NOT NULL REFERENCES worlds(id), state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());`,
  `CREATE TABLE IF NOT EXISTS sessions (id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id), player_id text NULL REFERENCES players(id), expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());`,
  `CREATE TABLE IF NOT EXISTS settlements (id text PRIMARY KEY, world_id text NOT NULL REFERENCES worlds(id), owner_player_id text NOT NULL REFERENCES players(id), state jsonb NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS world_checkpoints (world_id text NOT NULL REFERENCES worlds(id), id uuid PRIMARY KEY, tick bigint NOT NULL, schema_version integer NOT NULL, state jsonb NOT NULL, state_hash text NOT NULL, completed boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz NULL);`,
  `CREATE INDEX IF NOT EXISTS world_checkpoints_completed_idx ON world_checkpoints(world_id, completed, tick DESC);`,
  `CREATE TABLE IF NOT EXISTS chunk_snapshots (checkpoint_id uuid NOT NULL REFERENCES world_checkpoints(id), chunk_x integer NOT NULL, chunk_y integer NOT NULL, state jsonb NOT NULL, PRIMARY KEY(checkpoint_id, chunk_x, chunk_y));`,
  `CREATE TABLE IF NOT EXISTS command_journal (id text PRIMARY KEY, world_id text NOT NULL REFERENCES worlds(id), target_tick bigint NOT NULL, command jsonb NOT NULL, accepted_at timestamptz NOT NULL DEFAULT now());`,
  `CREATE INDEX IF NOT EXISTS command_journal_replay_idx ON command_journal(world_id, target_tick, accepted_at);`,
  `CREATE TABLE IF NOT EXISTS administrative_audit_events (id uuid PRIMARY KEY, world_id text NOT NULL REFERENCES worlds(id), actor_id text NOT NULL, reason text NOT NULL, before_state jsonb NULL, after_state jsonb NULL, tick bigint NULL, created_at timestamptz NOT NULL DEFAULT now());`,
];

export interface DatabaseMigration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

/** Ordered, forward-only migrations. Never edit a released entry; append a new version. */
export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  { version: 1, name: 'initial', statements: INITIAL_MIGRATION_SQL },
  {
    version: 2,
    name: 'backup-restore-drills',
    statements: [
      `CREATE TABLE IF NOT EXISTS backup_restore_drills (id uuid PRIMARY KEY, backup_created_at timestamptz NOT NULL, restored_at timestamptz NOT NULL DEFAULT now(), source_database text NOT NULL, target_database text NOT NULL, checkpoint_id uuid NULL, checkpoint_tick bigint NULL, state_hash text NULL, backup_sha256 text NOT NULL, verified boolean NOT NULL, operator text NOT NULL, notes text NULL);`,
    ],
  },
  {
    version: 3,
    name: 'administrative-audit-details',
    statements: [
      `ALTER TABLE administrative_audit_events ADD COLUMN IF NOT EXISTS operation text NOT NULL DEFAULT 'legacy';`,
      `ALTER TABLE administrative_audit_events ADD COLUMN IF NOT EXISTS target_id text NOT NULL DEFAULT 'world';`,
      `CREATE INDEX IF NOT EXISTS administrative_audit_events_world_tick_idx ON administrative_audit_events(world_id, tick DESC, created_at DESC);`,
    ],
  },
] as const;

const assertMigrationRegistry = () => {
  for (const [index, migration] of DATABASE_MIGRATIONS.entries()) {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion)
      throw new Error(
        `Database migration versions must be contiguous: expected ${expectedVersion}, got ${migration.version}`,
      );
    if (migration.statements.length === 0)
      throw new Error(`Database migration ${migration.version} has no statements`);
  }
};

export class PostgresWorldPersistence implements WorldPersistence {
  constructor(private readonly pool: Pool) {}
  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      assertMigrationRegistry();
      await client.query('SELECT pg_advisory_xact_lock($1)', [0x4b4f47]);
      await client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const applied = await client.query<{ version: number }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      const appliedVersions = new Set(applied.rows.map((row) => Number(row.version)));
      const newestKnownVersion = DATABASE_MIGRATIONS.at(-1)?.version ?? 0;
      const unknownVersion = [...appliedVersions].find((version) => version > newestKnownVersion);
      if (unknownVersion !== undefined)
        throw new Error(
          `Database schema version ${unknownVersion} is newer than supported version ${newestKnownVersion}`,
        );
      const appliedInOrder = [...appliedVersions].sort((left, right) => left - right);
      const invalidHistory = appliedInOrder.find((version, index) => version !== index + 1);
      if (invalidHistory !== undefined)
        throw new Error(
          `Database migration history is not contiguous at version ${invalidHistory}`,
        );
      for (const migration of DATABASE_MIGRATIONS) {
        if (appliedVersions.has(migration.version)) continue;
        for (const sql of migration.statements) await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [
          migration.version,
        ]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async loadLatestCheckpoint(): Promise<CompletedCheckpoint | undefined> {
    const result = await this.pool.query<{
      id: string;
      tick: string;
      state: WorldState;
      state_hash: string;
    }>(
      'SELECT id, tick, state, state_hash FROM world_checkpoints WHERE world_id = $1 AND completed = true ORDER BY tick DESC LIMIT 1',
      [WORLD_ID],
    );
    const row = result.rows[0];
    return row
      ? {
          checkpointId: row.id,
          tick: Number(row.tick),
          state: row.state,
          stateHash: row.state_hash,
        }
      : undefined;
  }
  async loadJournalAfter(tick: number): Promise<readonly JournalEntry[]> {
    const result = await this.pool.query<{ command: Command; target_tick: string }>(
      'SELECT command, target_tick FROM command_journal WHERE world_id = $1 AND target_tick >= $2 ORDER BY target_tick, accepted_at',
      [WORLD_ID, tick],
    );
    return result.rows.map((row) => ({
      command: row.command,
      targetTick: Number(row.target_tick),
    }));
  }
  async appendAcceptedCommand(entry: JournalEntry): Promise<void> {
    await this.pool.query(
      'INSERT INTO command_journal(id, world_id, target_tick, command) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
      [entry.command.id, WORLD_ID, entry.targetTick, entry.command],
    );
  }
  async saveCheckpoint(
    state: WorldState,
    dirtyChunks: readonly string[] = [],
  ): Promise<CompletedCheckpoint> {
    return this.persistCheckpoint(state, dirtyChunks);
  }
  async loadAdministrativeAuditEvents(limit: number): Promise<readonly AdministrativeAuditEvent[]> {
    const result = await this.pool.query<{
      id: string;
      actor_id: string;
      reason: string;
      operation: AdministrativeAuditEvent['operation'];
      target_id: string;
      before_state: unknown;
      after_state: unknown;
      tick: string;
    }>(
      'SELECT id, actor_id, reason, operation, target_id, before_state, after_state, tick FROM administrative_audit_events WHERE world_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
      [WORLD_ID, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      reason: row.reason,
      operation: row.operation,
      targetId: row.target_id,
      beforeState: row.before_state,
      afterState: row.after_state,
      tick: Number(row.tick),
    }));
  }
  async commitAdministrativeMutation(
    state: WorldState,
    audit: AdministrativeAuditEvent,
  ): Promise<CompletedCheckpoint> {
    return this.persistCheckpoint(state, [], audit);
  }
  private async persistCheckpoint(
    state: WorldState,
    dirtyChunks: readonly string[],
    audit?: AdministrativeAuditEvent,
  ): Promise<CompletedCheckpoint> {
    const checkpoint: CompletedCheckpoint = {
      checkpointId: randomUUID(),
      tick: state.tick,
      state: snapshot(state),
      stateHash: stateHash(state),
      dirtyChunks: [...new Set(dirtyChunks)].sort((left, right) => left.localeCompare(right)),
    };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureWorld(client, state.seed);
      await client.query(
        'INSERT INTO world_checkpoints(world_id, id, tick, schema_version, state, state_hash, completed) VALUES ($1, $2, $3, $4, $5, $6, false)',
        [
          WORLD_ID,
          checkpoint.checkpointId,
          checkpoint.tick,
          checkpoint.state.schemaVersion,
          checkpoint.state,
          checkpoint.stateHash,
        ],
      );
      for (const chunk of checkpoint.dirtyChunks ?? []) {
        const chunkSnapshot = snapshotDirtyChunk(checkpoint.state, chunk);
        await client.query(
          'INSERT INTO chunk_snapshots(checkpoint_id, chunk_x, chunk_y, state) VALUES ($1, $2, $3, $4)',
          [checkpoint.checkpointId, chunkSnapshot.chunk.x, chunkSnapshot.chunk.y, chunkSnapshot],
        );
      }
      await client.query(
        'UPDATE world_checkpoints SET completed = true, completed_at = now() WHERE id = $1',
        [checkpoint.checkpointId],
      );
      if (audit)
        await client.query(
          'INSERT INTO administrative_audit_events(id, world_id, actor_id, reason, operation, target_id, before_state, after_state, tick) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [
            audit.id,
            WORLD_ID,
            audit.actorId,
            audit.reason,
            audit.operation,
            audit.targetId,
            audit.beforeState,
            audit.afterState,
            audit.tick,
          ],
        );
      await client.query(
        `DELETE FROM chunk_snapshots
         WHERE checkpoint_id IN (
           SELECT id FROM world_checkpoints
           WHERE world_id = $1 AND completed = true
           ORDER BY tick DESC, completed_at DESC
           OFFSET $2
         )`,
        [WORLD_ID, CHECKPOINT_RETENTION],
      );
      await client.query(
        `DELETE FROM world_checkpoints
         WHERE world_id = $1 AND completed = true AND id IN (
           SELECT id FROM world_checkpoints
           WHERE world_id = $1 AND completed = true
           ORDER BY tick DESC, completed_at DESC
           OFFSET $2
         )`,
        [WORLD_ID, CHECKPOINT_RETENTION],
      );
      const retained = await client.query<{ oldest_tick: string }>(
        'SELECT MIN(tick) AS oldest_tick FROM world_checkpoints WHERE world_id = $1 AND completed = true',
        [WORLD_ID],
      );
      const oldestRetainedTick = retained.rows[0]?.oldest_tick;
      if (oldestRetainedTick)
        await client.query(
          'DELETE FROM command_journal WHERE world_id = $1 AND target_tick <= $2',
          [WORLD_ID, oldestRetainedTick],
        );
      await client.query('COMMIT');
      return checkpoint;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
  private async ensureWorld(client: PoolClient, seed: number): Promise<void> {
    await client.query('INSERT INTO worlds(id, seed) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [
      WORLD_ID,
      seed,
    ]);
  }
}

export const createPostgresWorldPersistence = (
  connectionString: string,
): PostgresWorldPersistence => new PostgresWorldPersistence(new Pool({ connectionString }));

export const readLatestCheckpointEvidence = async (
  connectionString: string,
): Promise<CheckpointEvidence | undefined> => {
  const pool = new Pool({ connectionString });
  try {
    const row = (
      await pool.query<{ id: string; tick: string; state_hash: string }>(
        'SELECT id, tick, state_hash FROM world_checkpoints WHERE world_id = $1 AND completed = true ORDER BY tick DESC LIMIT 1',
        [WORLD_ID],
      )
    ).rows[0];
    return row ? { id: row.id, tick: Number(row.tick), stateHash: row.state_hash } : undefined;
  } finally {
    await pool.end();
  }
};

export interface RestoreVerificationInput {
  readonly connectionString: string;
  readonly expected: CheckpointEvidence;
  readonly backupCreatedAt: string;
  readonly backupSha256: string;
  readonly sourceDatabase: string;
  readonly targetDatabase: string;
  readonly operator: string;
}

export const verifyAndRecordRestoredDatabase = async (
  input: RestoreVerificationInput,
): Promise<CheckpointEvidence> => {
  const pool = new Pool({ connectionString: input.connectionString });
  const persistence = new PostgresWorldPersistence(pool);
  try {
    await persistence.migrate();
    const row = (
      await pool.query<{ id: string; tick: string; state: unknown; state_hash: string }>(
        'SELECT id, tick, state, state_hash FROM world_checkpoints WHERE world_id = $1 AND id = $2 AND completed = true',
        [WORLD_ID, input.expected.id],
      )
    ).rows[0];
    if (!row) throw new Error('Restored database does not contain the manifest checkpoint');
    const world = deserializeWorld(row.state);
    const errors = inspectWorld(world);
    if (errors.length > 0) throw new Error(`Restored world is invalid: ${errors.join('; ')}`);
    const restored = { id: row.id, tick: Number(row.tick), stateHash: stateHash(world) };
    if (restored.stateHash !== row.state_hash || restored.stateHash !== input.expected.stateHash)
      throw new Error('Restored checkpoint state hash does not match backup evidence');
    if (restored.id !== input.expected.id || restored.tick !== input.expected.tick)
      throw new Error('Restored checkpoint identity does not match backup evidence');
    await pool.query(
      'INSERT INTO backup_restore_drills(id, backup_created_at, source_database, target_database, checkpoint_id, checkpoint_tick, state_hash, backup_sha256, verified, operator) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)',
      [
        randomUUID(),
        input.backupCreatedAt,
        input.sourceDatabase,
        input.targetDatabase,
        restored.id,
        restored.tick,
        restored.stateHash,
        input.backupSha256,
        input.operator,
      ],
    );
    return restored;
  } finally {
    await pool.end();
  }
};
