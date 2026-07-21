import { spawn } from 'node:child_process';
import process from 'node:process';

// Detached watchdog for the Windows dev server. dev.mjs starts this outside its
// own process tree so it survives even when the shell kills the orchestrator
// outright (Git Bash gives native Node no catchable CTRL+C). It force-kills the
// worker subtrees the moment the orchestrator disappears, freeing the dev ports.
const [orchestratorPid, ...workerPids] = process.argv.slice(2).map(Number);

const timer = setInterval(() => {
  try {
    process.kill(orchestratorPid, 0); // existence check; throws once the orchestrator is gone
  } catch {
    clearInterval(timer);
    if (workerPids.length === 0) process.exit(0);
    let remaining = workerPids.length;
    for (const pid of workerPids)
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' }).on('exit', () => {
        remaining -= 1;
        if (remaining === 0) process.exit(0);
      });
  }
}, 500);
