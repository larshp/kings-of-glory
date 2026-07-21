import { readFile } from 'node:fs/promises';
import { inspectCheckpoint } from './checkpoint-inspection.js';

const filePath = process.argv[2];
if (!filePath)
  throw new Error('Usage: npm --prefix apps/server run inspect -- <checkpoint-state.json>');
const raw = JSON.parse(await readFile(filePath, 'utf8')) as { state?: unknown } | unknown;
const inspection = inspectCheckpoint(raw);
const { errors, world, hash } = inspection;
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else if (world && hash)
  console.log(`World tick ${world.tick} is consistent (state hash ${hash}).`);
