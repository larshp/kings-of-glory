import { spawn } from 'node:child_process';
import process from 'node:process';

// Thin cross-platform launcher for pnpm used by the one-shot root scripts
// (build, test, lint, typecheck). The long-running dev server has its own
// orchestrator in dev.mjs, which is where CTRL+C / port-release handling lives.
const isWindows = process.platform === 'win32';
const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm';

const child = spawn(pnpm, process.argv.slice(2), {
  stdio: 'inherit',
  shell: isWindows, // required to launch the `.cmd` shim on Windows
});

child.once('error', (error) => {
  console.error(`Unable to start ${pnpm}: ${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
