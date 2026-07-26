import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { verifyAndRecordRestoredDatabase } from '@kings/server-runtime';
import {
  assertSafeRestoreTarget,
  databaseIdentity,
  postgresToolEnvironment,
  requireEnvironment,
  runPostgresTool,
  sha256File,
} from './backup-tools.js';

interface BackupManifest {
  readonly createdAt: string;
  readonly sha256: string;
  readonly checkpoint: { readonly id: string; readonly tick: number; readonly stateHash: string };
}

export const parseBackupManifest = (raw: string): BackupManifest => {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw new Error('Backup manifest must be an object');
  const manifest = value as Partial<BackupManifest>;
  const checkpoint = manifest.checkpoint;
  if (
    typeof manifest.createdAt !== 'string' ||
    Number.isNaN(Date.parse(manifest.createdAt)) ||
    typeof manifest.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
    !checkpoint ||
    typeof checkpoint.id !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(checkpoint.id) ||
    !Number.isSafeInteger(checkpoint.tick) ||
    checkpoint.tick < 0 ||
    typeof checkpoint.stateHash !== 'string' ||
    !/^[0-9a-f]{8}$/.test(checkpoint.stateHash)
  )
    throw new Error('Backup manifest has an invalid shape');
  return manifest as BackupManifest;
};

export const runRestoreDrill = async (environment: NodeJS.ProcessEnv) => {
  const startedAt = performance.now();
  const sourceUrl = requireEnvironment(environment, 'DATABASE_URL');
  const targetUrl = requireEnvironment(environment, 'RESTORE_DATABASE_URL');
  const confirmedDatabase = requireEnvironment(environment, 'RESTORE_CONFIRM_DATABASE');
  const operator = requireEnvironment(environment, 'RESTORE_OPERATOR');
  const backupFile = resolve(requireEnvironment(environment, 'BACKUP_FILE'));
  const target = assertSafeRestoreTarget(sourceUrl, targetUrl, confirmedDatabase);
  const manifest = parseBackupManifest(await readFile(`${backupFile}.json`, 'utf8'));
  const actualSha256 = await sha256File(backupFile);
  if (actualSha256 !== manifest.sha256)
    throw new Error('Backup SHA-256 does not match its manifest');

  await runPostgresTool(
    environment.PG_RESTORE ?? 'pg_restore',
    ['--clean', '--if-exists', '--no-owner', '--no-privileges', backupFile],
    postgresToolEnvironment(targetUrl),
  );
  const source = databaseIdentity(sourceUrl);
  const checkpoint = await verifyAndRecordRestoredDatabase({
    connectionString: targetUrl,
    expected: manifest.checkpoint,
    backupCreatedAt: manifest.createdAt,
    backupSha256: actualSha256,
    sourceDatabase: source.database,
    targetDatabase: target.database,
    operator,
  });
  const report = {
    formatVersion: 1,
    verifiedAt: new Date().toISOString(),
    operator,
    source,
    target,
    backupSha256: actualSha256,
    checkpoint,
    durationMs: performance.now() - startedAt,
    verified: true,
  } as const;
  await writeFile(`${backupFile}.restore.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
};

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href)
  runRestoreDrill(process.env)
    .then((report) =>
      process.stdout.write(`${JSON.stringify({ event: 'restore.verified', ...report })}\n`),
    )
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
