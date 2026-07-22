import { parse } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSafeRestoreTarget,
  databaseIdentity,
  postgresToolEnvironment,
  prepareBackupPath,
  requireEnvironment,
} from '../src/backup-tools.js';

describe('PostgreSQL backup safety', () => {
  it('parses a database identity without retaining credentials', () => {
    expect(databaseIdentity('postgres://user:secret@db.example:5433/kings%20world')).toEqual({
      host: 'db.example',
      port: '5433',
      database: 'kings world',
    });
    expect(postgresToolEnvironment('postgres://user:secret@db.example:5433/kings')).toMatchObject({
      PGHOST: 'db.example',
      PGPORT: '5433',
      PGDATABASE: 'kings',
      PGUSER: 'user',
      PGPASSWORD: 'secret',
    });
  });

  it('requires explicit configuration and an isolated, confirmed restore database', () => {
    expect(() => requireEnvironment({}, 'DATABASE_URL')).toThrow('DATABASE_URL is required');
    expect(() =>
      assertSafeRestoreTarget(
        'postgres://db.example/kings',
        'postgres://db.example/kings',
        'kings',
      ),
    ).toThrow('must not be the source');
    expect(() =>
      assertSafeRestoreTarget(
        'postgres://db.example/kings',
        'postgres://db.example/kings_restore',
        'wrong',
      ),
    ).toThrow('must exactly match');
    expect(
      assertSafeRestoreTarget(
        'postgres://db.example/kings',
        'postgres://db.example/kings_restore',
        'kings_restore',
      ).database,
    ).toBe('kings_restore');
  });

  it('refuses to write backups at a filesystem root', async () => {
    await expect(prepareBackupPath(parse(process.cwd()).root)).rejects.toThrow('filesystem root');
  });
});
