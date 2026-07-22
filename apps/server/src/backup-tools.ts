import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
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
