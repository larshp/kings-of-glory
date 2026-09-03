import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import {
  createBotWorkload,
  deserializeWorld,
  FixedStepRunner,
  inspectWorld,
  stateHash,
} from '@kings/simulation';
import { analyzeSoak, soakBudgets, type MemorySample } from './world-soak-report.js';

const minutes = Number(process.argv[2] ?? '5');
const players = Number(process.argv[3] ?? '20');
const buildingsPerPlayer = Number(process.argv[4] ?? '50');
const tickHz = Number(process.argv[5] ?? '10');
if (
  !Number.isFinite(minutes) ||
  minutes <= 0 ||
  !Number.isInteger(players) ||
  players < 1 ||
  !Number.isInteger(buildingsPerPlayer) ||
  buildingsPerPlayer < 5 ||
  !Number.isInteger(tickHz) ||
  tickHz < 1 ||
  1_000 % tickHz !== 0
)
  throw new Error(
    'Usage: npm --prefix apps/server run soak:world -- [minutes] [players] [buildings-per-player] [tick-hz]; tick-hz must divide 1000',
  );

const stepMs = 1_000 / tickHz;
/** Verification is expensive, so it runs on a fixed world-time cadence instead of every tick. */
const verifyIntervalTicks = tickHz * 60;
const memorySampleIntervalMs = 10_000;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
/** Optional: run node with --expose-gc so heap samples are not dominated by uncollected garbage. */
const collectGarbage = (globalThis as { gc?: () => void }).gc;
const sampleMemory = (elapsedMs: number): MemorySample => {
  collectGarbage?.();
  const memory = process.memoryUsage();
  return { elapsedMs, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed };
};

const workload = createBotWorkload({
  playerCount: players,
  targetBuildingsPerPlayer: buildingsPerPlayer,
  // A permanent world reconnects far more often than once; every ten world-minutes
  // keeps snapshot restore, not only steady-state ticking, inside the measurement.
  reconnectAfterTick: (tick) => tick > 0 && tick % (tickHz * 600) === 0,
  keepPlayersActive: true,
});

const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
const runner = new FixedStepRunner(stepMs, 5);
const startedAt = performance.now();
const deadline = startedAt + minutes * 60_000;
const tickDurationsMs: number[] = [];
const verificationDurationsMs: number[] = [];
const memorySamples: MemorySample[] = [sampleMemory(0)];
const hashFailures: string[] = [];
const invariantFailures: string[] = [];
let nextMemorySampleMs = memorySampleIntervalMs;
let nextVerificationTick = verifyIntervalTicks;
let droppedTicks = 0;
let largestSnapshotBytes = 0;

const verify = () => {
  const verificationStartedAt = performance.now();
  const restored = deserializeWorld(JSON.parse(JSON.stringify(workload.state)) as unknown);
  const expected = stateHash(workload.state);
  const actual = stateHash(restored);
  if (expected !== actual)
    hashFailures.push(
      `tick ${workload.tick}: snapshot restored to ${actual}, expected ${expected}`,
    );
  for (const error of inspectWorld(workload.state))
    invariantFailures.push(`tick ${workload.tick}: ${error}`);
  largestSnapshotBytes = Math.max(largestSnapshotBytes, JSON.stringify(workload.state).length);
  verificationDurationsMs.push(performance.now() - verificationStartedAt);
};

let lastAdvancedAt = startedAt;
while (performance.now() < deadline) {
  await sleep(Math.min(10, stepMs / 2));
  const now = performance.now();
  const elapsedMs = now - lastAdvancedAt;
  lastAdvancedAt = now;
  const availableTicks = Math.floor((runner.remainingMs + elapsedMs) / stepMs);
  const advanced = runner.advance(elapsedMs, () => {
    const tickStartedAt = performance.now();
    workload.step();
    tickDurationsMs.push(performance.now() - tickStartedAt);
  });
  droppedTicks += availableTicks - advanced;
  if (workload.tick >= nextVerificationTick) {
    verify();
    nextVerificationTick = workload.tick + verifyIntervalTicks;
  }
  const elapsedTotalMs = performance.now() - startedAt;
  if (elapsedTotalMs >= nextMemorySampleMs) {
    memorySamples.push(sampleMemory(elapsedTotalMs));
    nextMemorySampleMs = elapsedTotalMs + memorySampleIntervalMs;
  }
}
verify();
loopDelay.disable();
const durationMs = performance.now() - startedAt;
memorySamples.push(sampleMemory(durationMs));

const report = analyzeSoak({
  players,
  buildingsPerPlayer,
  tickHz,
  durationMs,
  ticks: workload.tick,
  droppedTicks,
  commandCount: workload.commandCount,
  botActions: workload.botActions,
  entities: Object.keys(workload.state.buildings).length,
  stateHash: stateHash(workload.state),
  processedCommands: workload.state.processedCommands.length,
  largestSnapshotBytes,
  tickDurationsMs,
  verificationDurationsMs,
  memorySamples,
  hashFailures,
  invariantFailures,
  eventLoopDelayMs: {
    mean: loopDelay.mean / 1e6,
    p99: loopDelay.percentile(99) / 1e6,
    max: loopDelay.max / 1e6,
  },
  garbageCollectionForced: Boolean(collectGarbage),
});
console.log(JSON.stringify(report, null, 2));
if (report.failures.length > 0) {
  for (const failure of report.failures) console.error(`soak failure: ${failure}`);
  process.exitCode = 1;
} else
  console.error(
    `soak passed ${minutes} minute(s): ${report.ticks} ticks, budgets ${soakBudgets.tickP99Ms} ms tick p99, ${soakBudgets.eventLoopP99Ms} ms loop p99`,
  );
