import { performance } from 'node:perf_hooks';
import { runBotScenario } from '@kings/simulation';

const players = Number(process.argv[2] ?? '20');
const ticks = Number(process.argv[3] ?? '1000');
const buildingsPerPlayer = Number(process.argv[4] ?? '5');
if (
  !Number.isInteger(players) ||
  players < 1 ||
  !Number.isInteger(ticks) ||
  ticks < 1 ||
  !Number.isInteger(buildingsPerPlayer) ||
  buildingsPerPlayer < 5
)
  throw new Error(
    'Usage: npm --prefix apps/server run load -- [players] [ticks] [buildings-per-player]',
  );
const memoryBefore = process.memoryUsage();
const startedAt = performance.now();
const result = runBotScenario(players, ticks, buildingsPerPlayer);
const durationMs = performance.now() - startedAt;
const memoryAfter = process.memoryUsage();
if (result.invariantErrors.length > 0) throw new Error(result.invariantErrors.join('; '));
console.log(
  JSON.stringify({
    players,
    ticks,
    buildingsPerPlayer,
    durationMs,
    ticksPerSecond: ticks / (durationMs / 1_000),
    commandCount: result.commandCount,
    botActions: result.botActions,
    stateHash: result.hash,
    entities: Object.keys(result.state.buildings).length,
    logisticsLinks: Object.keys(result.state.logisticsLinks).length,
    rssBytes: memoryAfter.rss,
    heapUsedBytes: memoryAfter.heapUsed,
    rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
    heapUsedDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
  }),
);
