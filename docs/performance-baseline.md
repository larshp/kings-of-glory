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

## 2026-07-26 release-scenario check

After adding the explicit content version and making threat response mandatory at target density, a
three-round local check produced a stable `70bfdb9c` hash at 275.16 ticks/second, with 1,000 entities,
90.5 MB peak RSS, and 28.1 MB peak heap. The paired load run reported seven accepted repairs, proving
the dense scenario no longer passes while skipping defense. This is a short regression check, not the
required multi-hour release soak; the manual release-candidate workflow records that longer evidence.

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

## 2026-07-22 ownership/visibility index

The same `1000 100` infrastructure profile was captured immediately before and after replacing
per-player full-registry ownership scans and a duplicate visibility pass with one deterministic
building/scout owner index per tick. Both runs produced state hash `d5626d89`. The measured
`research-and-population` phase fell from 3.962013 ms/tick to 2.004458 ms/tick, a 49.4% reduction.
The next-largest phase was then construction/production at 2.168711 ms/tick. This optimization also
benefits viewport-interest state because visible chunks now derive from the same owner-local entity
sets rather than rescanning every building for every player.

## Measured single-process threshold bracket

These are local development measurements, not hosting promises. The first-slice tick budget is
20 ms. The full progression workload remained inside it at 50 players and 2,500 buildings:

| Workload                                   | Result         |
| ------------------------------------------ | -------------- |
| 20 players / 1,000 buildings / 1,000 ticks | 276.64 ticks/s |
| 40 players / 2,000 buildings / 1,000 ticks | 84.67 ticks/s  |
| 50 players / 2,500 buildings / 1,000 ticks | 54.18 ticks/s  |

The dense infrastructure profile brackets the entity-only threshold more closely. With one owner,
6,001 buildings and 3,000 logistics links consumed 19.879 ms/tick across all phases; 6,401 buildings
and 3,200 links consumed 23.061 ms/tick. On this machine, one process therefore stops meeting the
20 ms first-slice simulation budget between those fixtures. Player fan-out, persistence, client-state
filtering, and network serialization can lower the production threshold, so the supported target
remains 20 players / 1,000 entities until an end-to-end deployment benchmark proves otherwise.

## Scale decisions from the measurements

- Inactive regions keep full deterministic simulation fidelity. No level-of-detail simulation is
  enabled because equivalent outcomes have not been demonstrated.
- Worker threads are not introduced: the supported workload is comfortably inside budget, while
  splitting authoritative state would add ownership and synchronization costs without a measured
  CPU bottleneck that requires it.
- Path searches share a fixed per-tick visit budget, plot allocation has a fixed candidate budget,
  checkpoints persist dirty chunks at bounded intervals, retained/audit queries are capped, and
  command/outbound queues reject excess work rather than growing without bound.
- JSON remains the measured transport for the first release. The target fan-out workload projects
  720 bytes/s/player at 10 Hz, well below the 32 KiB/s/player budget, and total simulation, filtering,
  serialization, and delivery remains below the server tick budget. A binary protocol is therefore
  not justified by the current evidence.

## End-to-end fan-out profile

The fan-out profile restores a progressed bot world, connects every player, advances the authoritative
host, builds each private interest-filtered view, constructs JSON deltas, and delivers them to measured
in-memory connections:

```powershell
npm.cmd --prefix apps/server run profile:fanout -- 20 50 40
```

The initial selective-state implementation took 124.564 ms/tick at 20 players and 1,000 buildings.
Cloning only authorized state reduced that to 41.982 ms/tick. Reusing unchanged terrain alone measured
60.648 ms/tick in a separate 20-tick run and did not solve the dominant full-registry scan. A single
per-broadcast building ownership/spatial index reduced a subsequent run to 26.900 ms/tick. Finally,
fingerprinting each client subtree once and retaining immutable copies of unchanged subtrees reduced
the 40-tick run to:

```json
{
  "players": 20,
  "entities": 1000,
  "ticks": 40,
  "tickDurationMs": 11.021795,
  "bytesPerPlayerPerTick": 72,
  "projectedBytesPerSecondPerPlayerAt10Hz": 720,
  "lastStateBuildDurationMs": 0.293
}
```

This local end-to-end result is 45% of the 20 ms server budget and 2.2% of the per-player bandwidth
budget. The state hash and privacy tests remain the correctness gates for these optimizations; absolute
timings remain machine-dependent.

## Repeated soak check

Run repeated deterministic scenarios to catch state-hash drift, invariant failures, latency spikes, and
memory growth. The last argument is the number of rounds; raise it for a longer release-candidate run.

```powershell
npm.cmd --prefix apps/server run soak -- 20 1000 50 10
```

The command returns a nonzero exit code on any invariant failure or hash drift and records peak/final
heap and RSS values for the complete run.
