import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GlobalWorldHost,
  INITIAL_MIGRATION_SQL,
  PostgresWorldPersistence,
  type Connection,
} from '../src/index.js';
import { nearestOreTile } from '@kings/simulation';

const connectionString = process.env.POSTGRES_TEST_URL;
const schemas: string[] = [];

describe.skipIf(!connectionString)('PostgreSQL forward migrations', () => {
  afterEach(async () => {
    const admin = new Pool({ connectionString });
    try {
      for (const schema of schemas.splice(0))
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  });

  it('upgrades a database created from the oldest supported schema', async () => {
    const schema = `migration_${randomUUID().replaceAll('-', '')}`;
    schemas.push(schema);
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    for (const statement of INITIAL_MIGRATION_SQL) await pool.query(statement);
    await pool.query('INSERT INTO schema_migrations(version) VALUES (1)');

    const persistence = new PostgresWorldPersistence(pool);
    await persistence.migrate();
    const versions = await pool.query<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(versions.rows.map(({ version }) => version)).toEqual([1, 2, 3]);
    const table = await pool.query<{ table_name: string | null }>(
      `SELECT to_regclass('backup_restore_drills')::text AS table_name`,
    );
    expect(table.rows[0]?.table_name).toBe('backup_restore_drills');
    await persistence.close();
  });

  it('restores a checkpoint and replays a later accepted command from PostgreSQL', async () => {
    const schema = `recovery_${randomUUID().replaceAll('-', '')}`;
    schemas.push(schema);
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();

    const poolOptions = { connectionString, options: `-c search_path=${schema}` } as const;
    const persistence = new PostgresWorldPersistence(new Pool(poolOptions));
    const host = new GlobalWorldHost(73, persistence);
    await host.restore();
    const messages: string[] = [];
    const client: Connection = {
      send(message) {
        messages.push(message);
      },
      close() {},
    };
    await host.connect(client, 'postgres-player');
    const player = host.world.players['postgres-player']!;
    const ore = nearestOreTile(
      host.world.seed,
      player.plot.x + Math.floor(player.plot.size / 2),
      player.plot.y + Math.floor(player.plot.size / 2),
      8,
    );
    expect(ore).toBeDefined();
    await host.command(client, {
      id: 'postgres-gather',
      playerId: player.id,
      sequence: 1,
      type: 'gather',
      x: ore!.x,
      y: ore!.y,
    });
    expect(host.world.players['postgres-player']?.inventory.ore).toBe(10);
    await persistence.close();

    const restoredPersistence = new PostgresWorldPersistence(new Pool(poolOptions));
    const restored = new GlobalWorldHost(999, restoredPersistence);
    await restored.restore({ migrate: false });
    expect(restored.world.seed).toBe(73);
    expect(restored.world.players['postgres-player']?.inventory.ore).toBe(10);
    expect(restored.world.players['postgres-player']?.lastSequence).toBe(1);
    await restoredPersistence.close();
  });
});
