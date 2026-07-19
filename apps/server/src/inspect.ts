import { readFile } from 'node:fs/promises';
import { deserializeWorld, inspectWorld } from '@kings/simulation';

const filePath = process.argv[2];
if (!filePath)
  throw new Error('Usage: pnpm --filter @kings/server inspect <checkpoint-state.json>');
const raw = JSON.parse(await readFile(filePath, 'utf8')) as { state?: unknown } | unknown;
const world = deserializeWorld(typeof raw === 'object' && raw && 'state' in raw ? raw.state : raw);
const errors = inspectWorld(world);
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log(`World tick ${world.tick} is consistent.`);
