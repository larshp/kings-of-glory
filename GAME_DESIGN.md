# First playable release

## Player loop

Players enter one shared, persistent world at a protected settlement plot. They gather **ore**, place a **smelter**, turn ore into **ingots**, and cooperatively repair their buildings when a small environmental hazard damages them. The first slice is deliberately limited to prove the authoritative command, simulation, rendering, and synchronization paths.

## Fixed decisions

- The world is procedurally generated and conceptually unbounded. Coordinates are signed 32-bit tile coordinates; generation is deterministic from a world seed.
- Tiles are diamond isometric tiles, 64 by 32 screen pixels, with no elevation in the first slice. Chunks are 16 by 16 tiles; buildings may occupy at most 2 by 2 tiles.
- Logistics in the first slice is an internal building inventory. Carriers, roads, and belts come after the vertical slice.
- Population is deferred. A player owns a settlement and its buildings directly in the first slice.
- The initial chain is ore -> ingot in a smelter. Each player starts with enough wood to build one smelter.
- New players receive a non-overlapping 8 by 8 protected plot on a deterministic spiral around the origin. Owners may build only in their own plot. Shared ownership and trade are deferred.
- Inactive settlements remain in the world. Simulation runs at the same fidelity for all loaded state in the first slice.
- On planned downtime, simulation pauses at a completed checkpoint. No offline production is granted.
- The first threat is a repairable acid-rain event that damages an owned building; it never targets players or enables PvP.
- Development worlds may be reset freely. Persistent alpha, beta, and public worlds require an announced reset policy.

## Non-goals

This increment does not include accounts, PostgreSQL persistence, combat, population, research, terrain elevation, roads, belt logistics, trade, chat, or mobile support. It targets current desktop Chrome, Firefox, Edge, and Safari at a minimum 1024 by 768 viewport.

## Initial budgets

| Measure | Target |
| --- | --- |
| Simulation tick | 100 ms (10 Hz), below 20 ms for the first slice |
| Client frame | below 16.7 ms on the placeholder map |
| Reconnect | below 5 seconds on a healthy local network |
| Protocol message | 64 KiB maximum |
| Initial players/entities | 20 players / 1,000 entities for the first load test |

