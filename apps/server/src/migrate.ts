import { createPostgresWorldPersistence } from '@kings/server-runtime';

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error('DATABASE_URL is required for the migration job.');

const persistence = createPostgresWorldPersistence(connectionString);
try {
  await persistence.migrate();
  process.stdout.write(`${JSON.stringify({ event: 'database.migrated' })}\n`);
} finally {
  await persistence.close();
}
