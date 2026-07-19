import { performance } from 'node:perf_hooks';
import { runBotScenario } from '@kings/simulation';

const players = Number(process.argv[2] ?? '20');
const ticks = Number(process.argv[3] ?? '1000');
const buildingsPerPlayer = Number(process.argv[4] ?? '50');
const rounds = Number(process.argv[5] ?? '10');
if (
  !Number.isInteger(players) ||
  players < 1 ||
  !Number.isInteger(ticks) ||
  ticks < 1 ||
  !Number.isInteger(buildingsPerPlayer) ||
  buildingsPerPlayer < 5 ||
  !Number.isInteger(rounds) ||
  rounds < 1
)
  throw new Error(
    'Usage: npm --prefix apps/server run soak -- [players] [ticks] [buildings-per-player] [rounds]',
  );

const memoryBefore = process.memoryUsage();
const durations: number[] = [];
let expectedHash: string | undefined;
let entities = 0;
let peakRssBytes = memoryBefore.rss;
let peakHeapUsedBytes = memoryBefore.heapUsed;
for (let round = 0; round < rounds; round += 1) {
  const startedAt = performance.now();
  const result = runBotScenario(players, ticks, buildingsPerPlayer);
  const durationMs = performance.now() - startedAt;
  if (result.invariantErrors.length > 0) throw new Error(result.invariantErrors.join('; '));
  if (expectedHash && result.hash !== expectedHash)
    throw new Error(
      `Deterministic hash drift on round ${round + 1}: expected ${expectedHash}, received ${result.hash}`,
    );
  expectedHash ??= result.hash;
  durations.push(durationMs);
  entities = Object.keys(result.state.buildings).length;
  const memory = process.memoryUsage();
  peakRssBytes = Math.max(peakRssBytes, memory.rss);
  peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsed);
}
const memoryAfter = process.memoryUsage();
const totalDurationMs = durations.reduce((total, duration) => total + duration, 0);
console.log(
  JSON.stringify({
    players,
    ticksPerRound: ticks,
    buildingsPerPlayer,
    rounds,
    totalTicks: ticks * rounds,
    entities,
    stateHash: expectedHash,
    totalDurationMs,
    averageRoundDurationMs: totalDurationMs / rounds,
    slowestRoundDurationMs: Math.max(...durations),
    ticksPerSecond: (ticks * rounds) / (totalDurationMs / 1_000),
    peakRssBytes,
    peakHeapUsedBytes,
    finalRssBytes: memoryAfter.rss,
    finalHeapUsedBytes: memoryAfter.heapUsed,
    rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
    heapUsedDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
  }),
);
