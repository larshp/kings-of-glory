# First playable release

## Player loop

Players enter one shared, persistent world at a protected settlement plot. They gather **ore**, place a **smelter**, turn ore into **ingots**, and cooperatively repair their buildings when a small environmental hazard damages them. The first slice is deliberately limited to prove the authoritative command, simulation, rendering, and synchronization paths.

## Fixed decisions

- The world is procedurally generated and conceptually unbounded. Coordinates are signed 32-bit tile coordinates; generation is deterministic from a world seed.
- Tiles are diamond isometric tiles, 64 by 32 screen pixels, with no elevation in the first slice. Chunks are 16 by 16 tiles; buildings may occupy at most 2 by 2 tiles.
- Logistics starts with internal building inventories plus deterministic storage-to-smelter links that move one ore per tick. Carriers, roads, belts, congestion, and routing come after the vertical slice.
- Population uses an aggregated-worker model. A settlement starts with two settlers; completed housing increases its capacity, settlers arrive gradually when capacity is available, and active producers consume deterministic worker slots according to player-set priorities. Satisfaction is derived from shelter and assigned work; employment, available-worker counts, and actionable housing/work alerts are visible in the HUD.
- The initial chain is ore -> ingot in a smelter. Each player starts with enough wood to build one smelter.
- New players receive a non-overlapping 8 by 8 protected plot on a deterministic spiral around the origin. Owners may build only in their own plot. Every player starts as the owner of a private settlement; owners can invite members, who must accept, and transfer settlement ownership to a current member before leaving. Builders may configure, repair, and deconstruct shared buildings; logistics members may load and withdraw items; ordinary members have no building authority. Direct resource transfers are atomic and retained as participant-visible history.
- Exploration is private until players explicitly cooperate. The server sends each client terrain only for its explored chunks and never sends the deterministic world seed. Territory uses 8 by 8 tile sectors: a player may claim an explored sector adjacent to their existing territory after researching the Territorial Charter. Claimed sectors are public; building inventories and unexplored sectors are private.
- Inactive settlements remain in the world. Simulation runs at the same fidelity for all loaded state in the first slice.
- On planned downtime, simulation pauses at a completed checkpoint. No offline production is granted.
- The first threat is a repairable acid-rain event that damages an owned building; it never targets players or enables PvP.
- The first active PvE threat is a deterministic raider swarm. It spawns away from its selected completed non-center building, navigates through passable terrain, and only damages an asset once adjacent. Nearby watchtowers engage it automatically; it never accepts player-issued attack targets. A player can recover by rebuilding and repairing after a raid.
- Development worlds may be reset freely. Persistent alpha, beta, and public worlds require an announced reset policy.

## Non-goals

This increment does not include production accounts, combat, terrain elevation, roads, belt logistics, trade offers, chat, or mobile support. It targets current desktop Chrome, Firefox, Edge, and Safari at a minimum 1024 by 768 viewport.

## Initial budgets

| Measure                  | Target                                              |
| ------------------------ | --------------------------------------------------- |
| Simulation tick          | 100 ms (10 Hz), below 20 ms for the first slice     |
| Client frame             | below 16.7 ms on the placeholder map                |
| Reconnect                | below 5 seconds on a healthy local network          |
| Protocol message         | 64 KiB maximum                                      |
| Initial players/entities | 20 players / 1,000 entities for the first load test |
