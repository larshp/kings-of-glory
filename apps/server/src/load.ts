import { performance } from 'node:perf_hooks';
import { runBotScenario } from '@kings/simulation';

const players = Number(process.argv[2] ?? '20');
const ticks = Number(process.argv[3] ?? '1000');
if (!Number.isInteger(players) || players < 1 || !Number.isInteger(ticks) || ticks < 1)
  throw new Error('Usage: pnpm --filter @kings/server load [players] [ticks]');
const startedAt = performance.now();
const result = runBotScenario(players, ticks);
const durationMs = performance.now() - startedAt;
if (result.invariantErrors.length > 0) throw new Error(result.invariantErrors.join('; '));
console.log(
  JSON.stringify({
    players,
    ticks,
    durationMs,
    ticksPerSecond: ticks / (durationMs / 1_000),
    commandCount: result.commandCount,
    stateHash: result.hash,
    entities: Object.keys(result.state.buildings).length,
    logisticsLinks: Object.keys(result.state.logisticsLinks).length,
  }),
);
