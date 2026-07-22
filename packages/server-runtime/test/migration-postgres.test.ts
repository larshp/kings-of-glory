import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { INITIAL_MIGRATION_SQL, PostgresWorldPersistence } from '../src/index.js';

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
    expect(versions.rows.map(({ version }) => version)).toEqual([1, 2]);
    const table = await pool.query<{ table_name: string | null }>(
      `SELECT to_regclass('backup_restore_drills')::text AS table_name`,
    );
    expect(table.rows[0]?.table_name).toBe('backup_restore_drills');
    await persistence.close();
  });
});
