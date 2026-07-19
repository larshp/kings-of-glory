# First-slice performance baseline

This is a reproducible development baseline, not a production capacity claim. It records the
headless 20-player target from the first-slice design budget before additional content or
simulation systems are added.

## 2026-07-19

Run from the repository root after building:

```powershell
npm.cmd --prefix apps/server run soak -- 20 1000 50 2
```

The two rounds in the development environment produced the same final state hash. The scenario
uses 50 buildings per bot to reach the 1,000-entity design target, with a researched watchtower
for every bot. It exercises the basic PvE defense loop, logistics, and the complete ore -> ingot
-> tool production chain.

```json
{
  "players": 20,
  "ticksPerRound": 1000,
  "buildingsPerPlayer": 50,
  "rounds": 2,
  "totalTicks": 2000,
  "totalDurationMs": 35273.3881,
  "averageRoundDurationMs": 17636.69405,
  "slowestRoundDurationMs": 19556.912,
  "ticksPerSecond": 56.69996866561282,
  "stateHash": "95708f9b",
  "entities": 1000,
  "peakRssBytes": 82948096,
  "peakHeapUsedBytes": 18849208,
  "finalRssBytes": 82964480,
  "finalHeapUsedBytes": 18849464,
  "rssDeltaBytes": 45285376,
  "heapUsedDeltaBytes": 14015024
}
```

Compare future measured runs against this command, state hash, entity count, throughput, and memory
shape. Heap and RSS values vary with the Node.js runtime and machine; investigate sustained growth or
material regressions before raising the target entity count or adding per-tick work.

## Per-phase infrastructure profile

The dense 1,000-pair logistics fixture profiles each authoritative phase without putting a clock in
the deterministic simulation. Run it after building:

```powershell
npm.cmd --prefix apps/server run profile -- 1000 100
```

On 2026-07-19, this produced 2,001 buildings and 1,000 links with final hash `b0b61d16`.
Construction and production was the largest phase at 3.560 ms per tick, followed by logistics at
1.994 ms. The production recipe lookup has therefore been indexed by recipe ID, replacing a
per-building linear recipe scan in that measured hot phase.

```json
{
  "perTickMs": {
    "advance-clock": 0.000948,
    "research-and-population": 1.126743,
    "construction-and-production": 3.559986,
    "environmental-events": 0.036476,
    "logistics": 1.99377,
    "threat-spawning": 0.000878,
    "threat-navigation-and-combat": 1.59519,
    "emit-events-and-mark-changes": 0.000339
  }
}
```

Treat this as a comparative local baseline: absolute timings vary by machine and Node.js version,
while the per-phase shape identifies where subsequent optimization work should start.

## Repeated soak check

Run repeated deterministic scenarios to catch state-hash drift, invariant failures, latency spikes, and
memory growth. The last argument is the number of rounds; raise it for a longer release-candidate run.

```powershell
npm.cmd --prefix apps/server run soak -- 20 1000 50 10
```

The command returns a nonzero exit code on any invariant failure or hash drift and records peak/final
heap and RSS values for the complete run.
