export interface ServerEnvironment {
  port: number;
  worldSeed: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  persistence: 'memory' | 'postgres';
  production: boolean;
  allowedOrigins: readonly string[];
  databaseUrl?: string;
}
export const parseEnvironment = (env: Record<string, string | undefined>): ServerEnvironment => {
  const port = Number(env.PORT ?? '3001');
  const worldSeed = Number(env.WORLD_SEED ?? '1');
  const logLevel = env.LOG_LEVEL ?? 'info';
  const persistence = env.PERSISTENCE ?? 'memory';
  const production = env.NODE_ENV === 'production';
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be an integer between 1 and 65535.');
  if (!Number.isSafeInteger(worldSeed)) throw new Error('WORLD_SEED must be a safe integer.');
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel))
    throw new Error('LOG_LEVEL must be debug, info, warn, or error.');
  if (persistence !== 'memory' && persistence !== 'postgres')
    throw new Error('PERSISTENCE must be memory or postgres.');
  if (persistence === 'postgres' && !env.DATABASE_URL)
    throw new Error('DATABASE_URL is required when PERSISTENCE=postgres.');
  if (production && allowedOrigins.length === 0)
    throw new Error('ALLOWED_ORIGINS is required in production.');
  return {
    port,
    worldSeed,
    logLevel: logLevel as ServerEnvironment['logLevel'],
    persistence,
    production,
    allowedOrigins,
    ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}),
  };
};
