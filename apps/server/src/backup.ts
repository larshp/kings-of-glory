import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readLatestCheckpointEvidence } from '@kings/server-runtime';
import {
  databaseIdentity,
  displayPath,
  postgresToolEnvironment,
  prepareBackupPath,
  pruneExpiredBackups,
  replicateBackupArtifacts,
  requireEnvironment,
  runPostgresTool,
  sha256File,
} from './backup-tools.js';

export const createDatabaseBackup = async (environment: NodeJS.ProcessEnv) => {
  const connectionString = requireEnvironment(environment, 'DATABASE_URL');
  const backupDirectory = requireEnvironment(environment, 'BACKUP_DIR');
  const { backupFile, manifestFile } = await prepareBackupPath(backupDirectory);
  const checkpoint = await readLatestCheckpointEvidence(connectionString);
  if (!checkpoint) throw new Error('Refusing to back up a world without a completed checkpoint');
  await runPostgresTool(
    environment.PG_DUMP ?? 'pg_dump',
    ['--format=custom', '--no-owner', '--no-privileges', `--file=${backupFile}`],
    postgresToolEnvironment(connectionString),
  );
  const sha256 = await sha256File(backupFile);
  const manifest = {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    source: databaseIdentity(connectionString),
    backupFile: displayPath(backupFile),
    sha256,
    checkpoint,
  } as const;
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  let offsite: Awaited<ReturnType<typeof replicateBackupArtifacts>> | undefined;
  let prunedBackups: string[] = [];
  if (environment.BACKUP_OFFSITE_DIR) {
    offsite = await replicateBackupArtifacts(
      backupFile,
      manifestFile,
      environment.BACKUP_OFFSITE_DIR,
    );
    if (environment.BACKUP_RETENTION_ENABLED === 'true')
      prunedBackups = await pruneExpiredBackups(environment.BACKUP_OFFSITE_DIR);
  } else if (environment.BACKUP_RETENTION_ENABLED === 'true') {
    throw new Error('BACKUP_OFFSITE_DIR is required when BACKUP_RETENTION_ENABLED=true');
  }
  return { backupFile, manifestFile, manifest, offsite, prunedBackups };
};

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href)
  createDatabaseBackup(process.env)
    .then(({ backupFile, manifest, offsite, prunedBackups }) => {
      process.stdout.write(
        `${JSON.stringify({ event: 'backup.completed', backupFile, offsiteBackupFile: offsite?.offsiteBackupFile, checkpoint: manifest.checkpoint, sha256: manifest.sha256, prunedBackups })}\n`,
      );
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
