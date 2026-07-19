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

## Repeated soak check

Run repeated deterministic scenarios to catch state-hash drift, invariant failures, latency spikes, and
memory growth. The last argument is the number of rounds; raise it for a longer release-candidate run.

```powershell
npm.cmd --prefix apps/server run soak -- 20 1000 50 10
```

The command returns a nonzero exit code on any invariant failure or hash drift and records peak/final
heap and RSS values for the complete run.
