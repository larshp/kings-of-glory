import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { basename, dirname, parse, resolve } from 'node:path';
import { spawn } from 'node:child_process';

export interface DatabaseIdentity {
  readonly host: string;
  readonly port: string;
  readonly database: string;
}

export const databaseIdentity = (connectionString: string): DatabaseIdentity => {
  const url = new URL(connectionString);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
    throw new Error('Database URL must use postgres:// or postgresql://');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!url.hostname || !database) throw new Error('Database URL must include a host and database');
  return { host: url.hostname, port: url.port || '5432', database };
};

export const postgresToolEnvironment = (connectionString: string): NodeJS.ProcessEnv => {
  const url = new URL(connectionString);
  const identity = databaseIdentity(connectionString);
  return {
    ...process.env,
    PGHOST: identity.host,
    PGPORT: identity.port,
    PGDATABASE: identity.database,
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
  };
};

export const requireEnvironment = (environment: NodeJS.ProcessEnv, name: string): string => {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export const prepareBackupPath = async (directory: string, now = new Date()) => {
  const absoluteDirectory = resolve(directory);
  if (parse(absoluteDirectory).root === absoluteDirectory)
    throw new Error('BACKUP_DIR must not be a filesystem root');
  await mkdir(absoluteDirectory, { recursive: true });
  const timestamp = now.toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const backupFile = resolve(absoluteDirectory, `kings-of-glory-${timestamp}.dump`);
  if (dirname(backupFile) !== absoluteDirectory) throw new Error('Invalid backup destination');
  return { backupFile, manifestFile: `${backupFile}.json` };
};

const safeBackupDirectory = async (directory: string): Promise<string> => {
  const absoluteDirectory = resolve(directory);
  if (parse(absoluteDirectory).root === absoluteDirectory)
    throw new Error('Backup storage directory must not be a filesystem root');
  await mkdir(absoluteDirectory, { recursive: true });
  return absoluteDirectory;
};

export const replicateBackupArtifacts = async (
  backupFile: string,
  manifestFile: string,
  offsiteDirectory: string,
) => {
  const destination = await safeBackupDirectory(offsiteDirectory);
  if (resolve(dirname(backupFile)) === destination)
    throw new Error('BACKUP_OFFSITE_DIR must differ from BACKUP_DIR');
  const offsiteBackupFile = resolve(destination, basename(backupFile));
  const offsiteManifestFile = resolve(destination, basename(manifestFile));
  if (dirname(offsiteBackupFile) !== destination || dirname(offsiteManifestFile) !== destination)
    throw new Error('Invalid off-site backup destination');
  await copyFile(backupFile, offsiteBackupFile);
  await copyFile(manifestFile, offsiteManifestFile);
  return { offsiteBackupFile, offsiteManifestFile };
};

export interface RetainedBackup {
  readonly backupFile: string;
  readonly manifestFile: string;
  readonly createdAt: Date;
}

/** Keeps every recent backup, then one weekly and one monthly recovery point. */
export const expiredBackups = (
  backups: readonly RetainedBackup[],
  now = new Date(),
): RetainedBackup[] => {
  const weekly = new Set<string>();
  const monthly = new Set<string>();
  const expired: RetainedBackup[] = [];
  for (const backup of [...backups].sort(
    (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
  )) {
    const ageDays = (now.getTime() - backup.createdAt.getTime()) / 86_400_000;
    if (!Number.isFinite(ageDays) || ageDays < 0) continue;
    if (ageDays < 14) continue;
    if (ageDays < 70) {
      const week = `${backup.createdAt.getUTCFullYear()}-${Math.floor(
        (backup.createdAt.getTime() - Date.UTC(backup.createdAt.getUTCFullYear(), 0, 1)) /
          (7 * 86_400_000),
      )}`;
      if (!weekly.has(week)) {
        weekly.add(week);
        continue;
      }
    } else if (ageDays < 435) {
      const month = `${backup.createdAt.getUTCFullYear()}-${backup.createdAt.getUTCMonth()}`;
      if (!monthly.has(month)) {
        monthly.add(month);
        continue;
      }
    }
    expired.push(backup);
  }
  return expired;
};

export const pruneExpiredBackups = async (directory: string, now = new Date()) => {
  const absoluteDirectory = await safeBackupDirectory(directory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const backups: RetainedBackup[] = [];
  for (const manifestName of [...files]
    .filter((name) => name.startsWith('kings-of-glory-') && name.endsWith('.dump.json'))
    .sort()) {
    const manifestFile = resolve(absoluteDirectory, manifestName);
    const parsed = JSON.parse(await readFile(manifestFile, 'utf8')) as {
      createdAt?: unknown;
      backupFile?: unknown;
    };
    const expectedBackupName = manifestName.slice(0, -'.json'.length);
    if (
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.backupFile !== 'string' ||
      parsed.backupFile !== expectedBackupName ||
      !files.has(expectedBackupName)
    )
      throw new Error(`Invalid backup retention manifest ${manifestName}`);
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime()))
      throw new Error(`Invalid backup creation time in ${manifestName}`);
    backups.push({
      backupFile: resolve(absoluteDirectory, expectedBackupName),
      manifestFile,
      createdAt,
    });
  }
  const expired = expiredBackups(backups, now);
  for (const backup of expired) {
    await rm(backup.backupFile);
    await rm(backup.manifestFile);
  }
  return expired.map((backup) => basename(backup.backupFile));
};

export const latestBackupFile = async (directory: string): Promise<string> => {
  const absoluteDirectory = await safeBackupDirectory(directory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const latest = [...files]
    .filter(
      (name) =>
        name.startsWith('kings-of-glory-') && name.endsWith('.dump') && files.has(`${name}.json`),
    )
    .sort()
    .at(-1);
  if (!latest) throw new Error('No complete off-site backup pair is available for a restore drill');
  return resolve(absoluteDirectory, latest);
};

export const sha256File = async (file: string): Promise<string> =>
  new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(file);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolveHash(hash.digest('hex')));
  });

export const runPostgresTool = async (
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, [...args], {
      stdio: 'inherit',
      windowsHide: true,
      env: environment,
    });
    child.on('error', (error) => reject(new Error(`Could not start ${command}: ${error.message}`)));
    child.on('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else
        reject(new Error(`${command} failed with ${signal ? `signal ${signal}` : `exit ${code}`}`));
    });
  });

export const assertSafeRestoreTarget = (
  sourceUrl: string,
  targetUrl: string,
  confirmedDatabase: string,
): DatabaseIdentity => {
  const source = databaseIdentity(sourceUrl);
  const target = databaseIdentity(targetUrl);
  if (
    source.host === target.host &&
    source.port === target.port &&
    source.database === target.database
  )
    throw new Error('Restore target must not be the source database');
  if (confirmedDatabase !== target.database)
    throw new Error(
      `RESTORE_CONFIRM_DATABASE must exactly match target database ${target.database}`,
    );
  return target;
};

export const displayPath = (file: string) => basename(file);
