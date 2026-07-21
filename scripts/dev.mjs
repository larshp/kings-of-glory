import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const isWindows = process.platform === 'win32';
const resolve = (relative) => fileURLToPath(new URL(relative, import.meta.url));

// Spawn the two dev services DIRECTLY as Node children — no `pnpm --parallel`
// and no shell in between. Under Git Bash, pnpm launches each worker through its
// own `bash -c`, and those processes get reparented (orphaned) and escape any
// tree-based kill when the launcher dies, leaving vite and the game server
// holding their ports. Spawning node directly keeps both worker PIDs ours to
// manage and tear down.
const workers = [
  {
    name: 'client',
    cwd: resolve('../apps/client/'),
    args: [resolve('../apps/client/node_modules/vite/bin/vite.js')],
  },
  {
    name: 'server',
    cwd: resolve('../apps/server/'),
    args: [resolve('../apps/server/node_modules/tsx/dist/cli.mjs'), 'watch', 'src/index.ts'],
  },
].map(({ name, cwd, args }) => {
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    detached: !isWindows, // own process group on POSIX so we can signal the subtree
  });
  child.once('error', (error) => console.error(`[${name}] failed to start: ${error.message}`));
  return child;
});

const workerPids = workers.map((worker) => worker.pid).filter((pid) => pid !== undefined);

let terminating = false;
const terminate = () => {
  if (terminating) return;
  terminating = true;
  clearInterval(parentWatch);
  for (const pid of workerPids) {
    if (isWindows) {
      // `/t` also kills tsx watch's server child; `/f` forces it.
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // already gone
        }
      }
    }
  }
  setTimeout(() => process.exit(0), 500).unref();
};

// Path 1 — catchable signals (PowerShell/cmd raise SIGINT on CTRL+C).
const signals = isWindows ? ['SIGINT', 'SIGHUP', 'SIGBREAK'] : ['SIGINT', 'SIGHUP', 'SIGTERM'];
for (const signal of signals) process.on(signal, terminate);

// Path 2 — parent death (Git Bash delivers CTRL+C only to the foreground group,
// which this native process is not part of; the shell kills our parent instead).
const parentPid = process.ppid;
const parentWatch = setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch {
    terminate();
  }
}, 1000);
parentWatch.unref();

// Path 3 — detached reaper (Windows). If the shell kills THIS process outright
// with no catchable signal, a process deliberately outside our tree force-kills
// the workers once we exit.
if (isWindows && workerPids.length > 0) {
  spawn(
    process.execPath,
    [resolve('./dev-reaper.mjs'), String(process.pid), ...workerPids.map(String)],
    {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    },
  ).unref();
}

// If any worker exits on its own, tear the rest down so ports never linger.
for (const worker of workers)
  worker.once('exit', (code) => {
    if (!terminating) {
      process.exitCode = code ?? 1;
      terminate();
    }
  });
