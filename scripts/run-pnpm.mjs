import { spawn } from 'node:child_process';

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const child = spawn(pnpm, process.argv.slice(2), {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.once('error', (error) => {
  console.error(`Unable to start ${pnpm}: ${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
