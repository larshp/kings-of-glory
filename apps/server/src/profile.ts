import { performance } from 'node:perf_hooks';
import { profileInfrastructureStressScenario } from '@kings/simulation';

const pairs = Number(process.argv[2] ?? '1000');
const ticks = Number(process.argv[3] ?? '10');
if (!Number.isInteger(pairs) || pairs < 1_000 || !Number.isInteger(ticks) || ticks < 1)
  throw new Error('Usage: npm --prefix apps/server run profile -- [pairs>=1000] [ticks>=1]');

const profile = profileInfrastructureStressScenario(() => performance.now(), pairs, ticks);
if (profile.result.invariantErrors.length > 0)
  throw new Error(profile.result.invariantErrors.join('; '));
const perTickMs = Object.fromEntries(
  Object.entries(profile.phaseDurationsMs).map(([phase, durationMs]) => [
    phase,
    durationMs / ticks,
  ]),
);
const slowestPhase = Object.entries(perTickMs).reduce((slowest, entry) =>
  entry[1] > slowest[1] ? entry : slowest,
);

console.log(
  JSON.stringify(
    {
      pairs,
      ticks,
      buildings: Object.keys(profile.result.state.buildings).length,
      logisticsLinks: Object.keys(profile.result.state.logisticsLinks).length,
      stateHash: profile.result.hash,
      phaseDurationsMs: profile.phaseDurationsMs,
      perTickMs,
      slowestPhase: { name: slowestPhase[0], perTickMs: slowestPhase[1] },
    },
    null,
    2,
  ),
);
