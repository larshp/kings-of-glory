export interface ServerEnvironment {
  port: number;
  worldSeed: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  persistence: 'memory' | 'postgres';
  production: boolean;
  trustProxy: boolean;
  peaceful: boolean;
  allowedOrigins: readonly string[];
  databaseUrl?: string;
  sessionSecret?: string;
  previousSessionSecret?: string;
}
export const parseEnvironment = (env: Record<string, string | undefined>): ServerEnvironment => {
  const port = Number(env.PORT ?? '3001');
  const worldSeed = Number(env.WORLD_SEED ?? '1');
  const logLevel = env.LOG_LEVEL ?? 'info';
  const persistence = env.PERSISTENCE ?? 'memory';
  const production = env.NODE_ENV === 'production';
  const trustProxy = env.TRUST_PROXY === 'true';
  const peaceful = env.PEACEFUL !== 'false';
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
  if (production && (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32))
    throw new Error('SESSION_SECRET of at least 32 characters is required in production.');
  if (env.SESSION_SECRET_PREVIOUS && env.SESSION_SECRET_PREVIOUS.length < 32)
    throw new Error('SESSION_SECRET_PREVIOUS must be at least 32 characters when set.');
  if (production && !trustProxy)
    throw new Error('TRUST_PROXY=true is required for production TLS enforcement.');
  return {
    port,
    worldSeed,
    logLevel: logLevel as ServerEnvironment['logLevel'],
    persistence,
    production,
    trustProxy,
    peaceful,
    allowedOrigins,
    ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}),
    ...(env.SESSION_SECRET ? { sessionSecret: env.SESSION_SECRET } : {}),
    ...(env.SESSION_SECRET_PREVIOUS ? { previousSessionSecret: env.SESSION_SECRET_PREVIOUS } : {}),
  };
};
