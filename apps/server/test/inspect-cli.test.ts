import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createWorld, snapshot, stateHash } from '@kings/simulation';
import { describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const tsxCli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const inspector = fileURLToPath(new URL('../src/inspect.ts', import.meta.url));

describe('checkpoint inspection CLI', () => {
  it('prints a verified result for an exported completed checkpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kings-checkpoint-'));
    const filePath = join(directory, 'checkpoint.json');
    const state = snapshot(createWorld(117));
    await writeFile(
      filePath,
      JSON.stringify({ completed: true, tick: state.tick, stateHash: stateHash(state), state }),
    );
    try {
      const { stdout } = await execFile(process.execPath, [tsxCli, inspector, filePath]);
      expect(stdout).toContain('World tick 0 is consistent');
      expect(stdout).toContain(stateHash(state));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
