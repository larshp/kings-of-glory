import { parse } from 'node:path';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  assertSafeRestoreTarget,
  databaseIdentity,
  expiredBackups,
  latestBackupFile,
  postgresToolEnvironment,
  prepareBackupPath,
  requireEnvironment,
} from '../src/backup-tools.js';
import { parseBackupManifest } from '../src/restore-drill.js';

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

  it('retains recent, weekly, and monthly recovery points while expiring duplicates', () => {
    const now = new Date('2026-07-26T12:00:00.000Z');
    const backup = (name: string, ageDays: number) => ({
      backupFile: `${name}.dump`,
      manifestFile: `${name}.dump.json`,
      createdAt: new Date(now.getTime() - ageDays * 86_400_000),
    });
    expect(
      expiredBackups(
        [
          backup('recent', 1),
          backup('weekly-newest', 20),
          backup('weekly-duplicate', 20.5),
          backup('monthly-newest', 80),
          backup('monthly-duplicate', 80.5),
          backup('too-old', 500),
        ],
        now,
      ).map(({ backupFile }) => backupFile),
    ).toEqual(['weekly-duplicate.dump', 'monthly-duplicate.dump', 'too-old.dump']);
  });

  it('selects only the newest complete off-site backup pair', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kings-backup-test-'));
    try {
      for (const name of ['kings-of-glory-2026-01-01.dump', 'kings-of-glory-2026-02-01.dump']) {
        await writeFile(join(directory, name), 'dump');
        await writeFile(join(directory, `${name}.json`), '{}');
      }
      await writeFile(join(directory, 'kings-of-glory-2026-03-01.dump'), 'incomplete');
      await expect(latestBackupFile(directory)).resolves.toBe(
        join(directory, 'kings-of-glory-2026-02-01.dump'),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects malformed restore manifests before invoking PostgreSQL tools', () => {
    const valid = JSON.stringify({
      createdAt: '2026-07-26T12:00:00.000Z',
      sha256: 'a'.repeat(64),
      checkpoint: {
        id: '12345678-1234-1234-1234-123456789abc',
        tick: 42,
        stateHash: 'deadbeef',
      },
    });
    expect(parseBackupManifest(valid).checkpoint.tick).toBe(42);
    expect(() => parseBackupManifest('{}')).toThrow('invalid shape');
    expect(() =>
      parseBackupManifest(
        JSON.stringify({
          ...JSON.parse(valid),
          checkpoint: { ...JSON.parse(valid).checkpoint, tick: -1 },
        }),
      ),
    ).toThrow('invalid shape');
  });
});
