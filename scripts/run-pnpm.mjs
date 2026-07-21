import { spawn } from 'node:child_process';
import process from 'node:process';

const isWindows = process.platform === 'win32';
const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm';

// On POSIX the child runs in its own process group so we can signal the whole
// tree at once. On Windows `shell: true` is required to launch the `.cmd` shim,
// but CTRL+C is not reliably propagated through cmd.exe and `pnpm --parallel`
// to descendants, so long-running workers (vite, tsx watch, the game server)
// would otherwise be orphaned and keep holding their dev ports.
const child = spawn(pnpm, process.argv.slice(2), {
  stdio: 'inherit',
  shell: isWindows,
  detached: !isWindows,
});

let terminating = false;
const terminate = (signal) => {
  if (terminating || child.pid === undefined) return;
  terminating = true;
  if (isWindows) {
    // `/t` kills the whole tree and `/f` forces it; without this the workers
    // survive and the dev ports stay taken after CTRL+C.
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  } else {
    // The negative pid targets the detached process group created above.
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }
};

// SIGINT is CTRL+C and SIGHUP fires when the console window closes on both
// platforms; SIGBREAK (CTRL+Break) is Windows-only and SIGTERM is POSIX-only,
// so registering the wrong one for the platform throws "Unknown signal".
const signals = isWindows ? ['SIGINT', 'SIGHUP', 'SIGBREAK'] : ['SIGINT', 'SIGHUP', 'SIGTERM'];
for (const signal of signals) process.on(signal, () => terminate(signal));

child.once('error', (error) => {
  console.error(`Unable to start ${pnpm}: ${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
