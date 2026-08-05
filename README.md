# Kings of Glory

Kings of Glory is an isometric PvE strategy game that runs in the browser. It combines:

- Factorio-style automation and production chains
- The Settlers-style settlement building and resource management
- Civilization-style exploration, expansion, and strategic progression

Players build, automate, trade, and overcome environmental challenges and threats together in a persistent multiplayer world.

## Multiplayer

Multiplayer takes place in one persistent global world. There are no separate matches, lobbies, or matchmaking. Players enter the same world at their settlement or last known position and cooperate against server-controlled enemies and world events.

The global server owns the authoritative state: clients submit commands, the server validates them, advances the simulation, and sends relevant changes back to connected players.

## Architecture

```text
Browser client
+ Canvas 2D world renderer
+ React interface
+ Input and camera controls
+ WebSocket connection
          |
          | Player commands and relevant world updates
          v
Global world server
+ Node.js
+ Authoritative fixed-tick simulation
+ Production, logistics, and settlement systems
+ PvE enemies and world events
+ Chunk management and pathfinding
+ Snapshot persistence
          |
          v
PostgreSQL
+ Players and world metadata
+ Periodic world and chunk snapshots
+ Important transactions and events
```

The world is divided into chunks internally, but multiplayer chunks are not separate worlds or shards. Chunking limits rendering, network updates, pathfinding, simulation detail, and persistence work while preserving one seamless global world.

## Technology

- **Language:** TypeScript for the client, server, simulation, and shared types
- **World rendering:** Canvas 2D
- **Interface:** React
- **Browser tooling:** Vite
- **Server runtime:** Node.js
- **Network transport:** WebSockets using `ws`
- **Persistence:** PostgreSQL
- **Workspace and testing:** pnpm workspaces and Vitest

Redis, a separate caching layer, microservices, matchmaking, and Docker are not required for the initial implementation.

## Design principles

- Run the simulation at a fixed tick rate, initially around 5-10 ticks per second.
- Keep simulation code independent of browser, Node.js, networking, and database APIs.
- Use seeded random-number generation and serializable simulation state.
- Send player commands to the simulation rather than allowing clients to modify multiplayer state directly.
- Send multiplayer clients only the chunks and changes relevant to them.
- Keep the active multiplayer world in server memory and save dirty chunks and periodic snapshots to PostgreSQL.
- Resume the same global world after a server restart.
- Render independently from simulation ticks and interpolate visual movement where appropriate.

## Proposed repository structure

```text
apps/
  client/           Browser client using Canvas 2D and React
  server/           Authoritative global-world server

packages/
  simulation/       Platform-independent game simulation
  protocol/         Commands, events, and serialized state
  content/          Buildings, resources, units, and technologies
  pathfinding/      Navigation and logistics algorithms
  server-runtime/   WebSocket and PostgreSQL integration
```

## Local development

Prerequisites: Node.js 22.16.0 (see `.nvmrc`) and pnpm 10.14.0. Install the pinned package manager with `npm install --global pnpm@10.14.0`. GitHub Actions runs the same locked install, format, lint, build, and test gate on pull requests and `main`. The npm scripts select `pnpm.cmd` automatically on Windows, so `npm run dev` works even when PowerShell blocks `pnpm.ps1`.

```powershell
npm install --global pnpm@10.14.0
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm lint
```

After dependencies are installed, you can also start both applications with:

```powershell
npm run dev
```

Start the authoritative world host in one terminal and the browser client in another without
calling `pnpm` directly:

```powershell
npm --prefix apps/server run dev
npm --prefix apps/client run dev
```

Or start both with `npm run dev`; the npm wrapper uses the Windows command shim when needed.

The server listens on `http://127.0.0.1:3001/health` and WebSocket clients connect on port 3001. Vite serves the client at `http://127.0.0.1:5173`. By default the client connects to the same hostname as the page, so local `127.0.0.1` and LAN development addresses work; set `VITE_SERVER_URL` to override it. Development can fall back to a stable per-tab identity. Production obtains an anonymous account through `POST /session`; the server issues a signed, 30-day, HTTP-only, `SameSite=Strict`, `Secure` cookie and derives WebSocket identity from that cookie instead of trusting the client-supplied player ID.

The current JSON WebSocket protocol is version 6. A client sends `hello`, then receives a `welcome` handshake acknowledgement and a filtered `worldBootstrap`. Newly relevant viewport chunks receive a replacement `chunkSnapshot`; ordinary changes use ordered `stateDelta` messages. Commands receive either `commandAcknowledged` or `commandRejected`, while `ping`/`pong`, `resync`, `maintenance`, and `error` cover connection health and recovery.

Players can contribute tools from separate settlements to the global Frontier Beacon objective. The
server records every contribution, completes the objective at its exact target, and permits one
idempotent fixed reward claim per contributor. Global progress is public, while contributor maps and
history are filtered to the requesting player.

Settlement owners and builders can also start a shared storage project on selected valid land. Members fund its authoritative material ledger one item at a time; exact contribution history remains settlement-private, and full funding creates one settlement-owned construction site. The cooperation panel includes a bounded public directory for discovering player and settlement identifiers without publishing positions, inventories, territory, roles, or hidden-world state.

Players and settlements have normalized, case-insensitively unique display names that are searchable in the public directory. The cooperation panel also provides global and settlement chat. Chat is authoritatively rate-limited and content-filtered; players can block senders and report retained messages. Settlement messages are visible only to current members, block lists are private to their owner, and report records remain server-side for moderation.

Settlement owners can atomically transfer ownership to a current member, after which former owners may leave. Account deletion requires an exact confirmation and is rejected while the player owns any settlement. A confirmed deletion removes private player state, owned entities, land, memberships, invitations, block metadata, and display names; bounded transaction and moderation ledgers retain server-side integrity records, while a private tombstone prevents the deleted identity from being recreated. Existing inactivity protection remains deterministic: inactivity starts after 300 ticks without an accepted command, limits unattended damage, and ends immediately on the next accepted command.

New starter land and nearby resource reservations are temporary until the player completes a smelter. Each accepted command renews the 36,000-tick onboarding lease. If that lease expires while the player still has only the untouched solo starter settlement, the simulation deterministically removes its land, buildings, scout, settlement, and private social state so the plot and nearby resources can be allocated again. Completing the smelter or joining a cooperative settlement permanently secures the reservation. Returning development clients discard the reclaimed identity and create a fresh one after the server confirms that no player state remains.

The deterministic headless load clients exercise the complete progression loop: gathering, construction, both research tiers, inter-player trade, territory expansion, snapshot reconnect/restore, automated production, watchtower defense, and repairs in response to damage. Load output includes per-behavior action counts so a scenario cannot silently stop covering one of those paths while still producing ticks.

Runtime safety limits are explicit and tested: inbound messages are capped at 64 KiB, each viewport may subscribe to at most 64 chunks, each player may have at most 64 active construction jobs, shared settlements may have three active projects, the global threat path budget is 128 visits per tick, the server accepts at most 256 pending commands, and connections exceeding 1 MiB of buffered outbound data are closed for backpressure. Authoritative world ledgers are bounded so a permanent world reaches a steady state: the duplicate-command window retains the newest 1,024 accepted command IDs and the transfer ledger the newest 1,000 transfers. Retries older than the idempotency window are still rejected, by the per-player command sequence rather than as duplicates. World snapshot schema 28 trims both ledgers when restoring an older world. Carrier route planning shares a budget of 128 path visits per tick with the same shape as the threat budget, and one link's stored route is capped at 96 tiles. Concurrent joins and commands share one authoritative mutation queue; a 20-client hot-chunk test covers simultaneous observation and writes.

Conflicting world commands are serialized through one authoritative queue. Regression matrices cover both command orderings for transfer-capacity contention, duplicate transfer retries, permission revocation, invitation acceptance/removal, and ownership transfer/removal. The resulting state conserves resources, applies at most one duplicate retry, observes the permissions valid at each command's linearization point, clears invitations consistently, and retains exactly one settlement owner.

To exercise the durable-world adapter, run PostgreSQL 16 or newer and start the server with a connection string. Startup applies the forward-only initial schema and restores the newest completed checkpoint before accepting clients.

```powershell
$env:PERSISTENCE = 'postgres'
$env:DATABASE_URL = 'postgres://kings:kings@localhost:5432/kings_of_glory'
npm --prefix apps/server run dev
```

Development runs migrations on startup by default. Staging and production must set
`MIGRATE_ON_STARTUP=false`, run `npm --prefix apps/server run migrate` with the dedicated migration
credential, and start the world host with a separate runtime credential. Production startup rejects
`MIGRATE_ON_STARTUP=true`; see [the deployment architecture](docs/deployment.md).

Every snapshot records the content version it was written for, and `deserializeWorld` refuses one that
does not match its schema's row in `SNAPSHOT_CONTENT_VERSIONS` rather than reinterpreting it under
different rules. Additive content is migrated: content version 5 added the masonry chain, building
tiers, and walking carriers without moving a single tile, so a version 29 world is lifted forward.
A content change that moves deterministic world generation cannot be, and mountains have done that
twice — version 2 added mountains, and version 3 moved them onto Perlin ridge noise with taller peaks.
The correct response to another such change is to drop the rows for every earlier schema, so those
worlds are rejected instead of having terrain shifted underneath their settlements; development worlds
must then be reset, which the reset policy permits.

`PERSISTENCE=memory` remains the default for local UI work. PostgreSQL mode journals accepted commands before applying them, saves a completed checkpoint every 300 ticks, retains the newest three completed checkpoints with replayable journal history, and writes one final checkpoint during graceful shutdown. See [001_initial.sql](packages/server-runtime/migrations/001_initial.sql) for the initial schema.

New worlds are peaceful by default, so no PvE threats spawn; start the server with `PEACEFUL=false` to create a world with raids enabled. The flag is stored in world state, so it applies when a world is first created — with `PERSISTENCE=memory` that is every restart, while a persisted PostgreSQL world keeps whatever value it was created with. PvE protection is deterministic and replayable: new settlements are protected for 300 ticks, and after 300 ticks without an accepted command inactive settlements remain under limited pressure but cannot be damaged below half health. Settlement access lanes, foreign plot buffers, nearest-plot spawn resources, and fixed threat targets prevent players from redirecting PvE pressure or enclosing another settlement.

Operational procedures for failed deployments, storage failures, runaway ticks, client floods, and
world rollback are in the [operations runbook](docs/runbooks/operations.md).

Operators can inspect world, player, settlement, transaction, moderation, and audit state through the PostgreSQL-backed administrative CLI. Its narrow correction operations validate the complete resulting world and atomically persist a completed checkpoint plus actor, reason, operation, target, before/after state, and tick. Mutations require the game server to be stopped and an explicit offline confirmation. See the [administrative governance runbook](docs/runbooks/administrative-governance.md).

The server exposes `/health`, `/ready`, and a Prometheus-compatible `/metrics` endpoint. `/health` reports whether the process is live; `/ready` returns `503` during maintenance so traffic can drain before the final checkpoint. Metrics include per-phase tick timing, active path workload, full-state and delta message/byte totals, state-build time, the latest checkpoint tick, restore duration, journal lag, pending commands, and total buffered outbound bytes. The browser performance panel reports FPS, render-object count, active chunks, estimated atlas memory, message rate, and state-update application time. The first-slice recovery objective is zero accepted-command data loss and a five-minute verified recovery; see the [checkpoint recovery runbook](docs/runbooks/checkpoint-recovery.md). Structured connection, disconnect, and command-failure logs include a correlation ID but never include a command payload, session cookie, or secret. In production set `NODE_ENV=production`, `TRUST_PROXY=true`, a comma-separated `ALLOWED_ORIGINS` list, and a randomly generated `SESSION_SECRET` of at least 32 characters. The trusted edge proxy must overwrite `X-Forwarded-Proto`; session and WebSocket authentication reject requests unless it reports HTTPS. Connections from other origins are rejected. Each connection is rate-limited to 30 messages per second, each authenticated account to 60 messages per second across concurrent connections, heartbeats every 15 seconds, and is disconnected when its buffered outbound data exceeds 1 MB or it remains silent for 45 seconds. See the [session-secret rotation runbook](docs/runbooks/session-secret-rotation.md).

To inspect a serialized checkpoint state without changing it, build the workspace and run `npm --prefix apps/server run inspect -- path/to/checkpoint.json`. The inspector reports invalid owners, overlapping buildings, invalid inventories, malformed populations, dangling threat targets, incomplete checkpoints, and mismatched checkpoint hashes.

Create PostgreSQL custom-format backups with `npm --prefix apps/server run backup` and verify them in
an explicitly confirmed isolated database with `npm --prefix apps/server run restore:drill`. See the
[backup and restore drill runbook](docs/runbooks/backup-restore-drill.md) for required environment
variables, retention, safety checks, and evidence. A successful real-database drill remains mandatory
before any public persistent test.

Set `POSTGRES_TEST_URL` to run the migration suite against a disposable schema in a real PostgreSQL
instance; without it, the external-database migration test is reported as skipped while adapter tests
still exercise ordering, rollback, and compatibility rejection.

Run the continuous world soak with `npm --prefix apps/server run soak:world -- [minutes] [players] [buildings-per-player] [tick-hz]`. It advances one world against a wall clock at the design tick rate and exits nonzero on tick overruns, event-loop stalls, dropped ticks, snapshot hash drift, invariant failures, or sustained heap growth. Growth is the least-squares slope of post-warmup samples and is reported as unmeasured for runs shorter than the growth window.

Run the deterministic bot baseline with `npm --prefix apps/server run load -- [players] [ticks] [buildings-per-player]`. It reports duration, tick throughput, command count, entity count, final state hash, and end-of-run memory with deltas; record these values when evaluating performance changes.
For a dense logistics fixture, run `npm --prefix apps/server run profile -- [pairs>=1000] [ticks]`; it reports total and per-tick time for each authoritative simulation phase.
See [the current first-slice baseline](docs/performance-baseline.md) for a reproducible 20-player run.

## Current vertical slice

This increment provides a strict TypeScript workspace, a platform-independent deterministic simulation, a versioned JSON WebSocket handshake, a single authoritative world host, durable checkpoint/journal foundations, and a React/Canvas 2D isometric map. Players gather finite ore deposits (gray map tiles) and timber groves (brown map tiles), quarry stone from the mountain ranges, construct smelters, workshops, brickworks, quarries, storage, housing, hearths, and walls, turn ore into ingots, ingots plus wood into tools, and stone plus wood into brick, and build recipe-validated links whose carriers walk their deliveries between buildings. Brick pays for walls and for a permanent second tier on the buildings a settlement depends on. The HUD explains a producer's actual recipe duration at its current tier and its missing inputs; housing, jobs, and a completed hearth determine settlement wellbeing. Players repair damage from acid rain or raiders. Tests cover deterministic replay, command rejection, resource conservation including items in flight, content validation, protocol shape validation, snapshot migration, and checkpoint recovery.

### Automated extraction

Mines, lumber camps, and quarries automate the gathering step. Place one within four tiles of a deposit
that still has yield and, while a settler is assigned to it, it takes one ore, wood, or stone into its
own inventory every few ticks. Extractors spend the same finite deposits as a manual gather, respect the
same starting-plot resource reservations, share the settlement worker pool and job priorities with
smelters, workshops, and brickworks, and can be the source of a logistics link. Linking a mine to a
smelter and a smelter to a workshop runs the whole ore → ingot → tool chain without a single gather
click, and a quarry into a brickworks does the same for stone → brick. Storage is also a valid link
target so raw output can be buffered; storage-to-storage links are rejected. Placing an extractor where
no deposit with remaining yield is in range is rejected with `no-deposit-in-range`, and the build menu
disables the button and explains why before the command is sent.

### Masonry, walls, and building tiers

Masonry research opens a second raw material out of terrain the map already had. Every mountain tile is
a finite stone deposit, so a quarry placed on open ground beside a range cuts stone without any tile
moving and without ranges becoming passable or buildable. A brickworks fires two stone and one timber
into a brick, and brick is what durability costs: a wall has well over twice a watchtower's health and
blocks raider routes the same way every building does.

Brick and tools also buy a permanent second tier for a smelter, workshop, brickworks, mine, lumber camp,
quarry, or storage. An upgrade re-enters the ordinary construction pipeline — the building stops working,
a builder delivers its materials over several worker ticks, and it comes back faster, roomier, tougher,
and at full health — so a tier is paid for in downtime as well as materials. Upgrades wait for a running
batch rather than discarding consumed inputs, are charged to the building owner's stock, and refund in
full if cancelled, which leaves the tier-one building working instead of removing it.

### Carriers that walk

Each logistics link owns one carrier. It loads up to four items, walks the link's route tile by tile,
unloads what the target has room for, and walks home before the link can dispatch again, so a link's
throughput follows distance rather than a flat per-tick rate. Routes are planned once from the world seed
and the two building tiles, over open ground only, so a range between two buildings forces a real detour
and a pair with no way through reports `no-route` instead of quietly idling. A paved step costs one
movement point against the two an unpaved one costs, and Engineering research raises the per-tick
movement budget from four to six — which is what makes roads worth their timber. Items in flight belong
to the carrier alone: they leave the source when it loads and reappear only when it unloads, and
demolishing an endpoint or removing the link hands them back rather than destroying them. The logistics
overlay draws the route the carrier actually walks, and the map shows each carrier with its load.

### Mountains and terrain height

The map has relief, and only mountains carry it. Ridged fractal Perlin noise raises 13-15% of tiles to
heights 1 through 5 and marks them `mountain`; every other tile, including every ore deposit and timber
grove, stays at height zero. Folding the noise at zero turns its crossings into crest lines, so ranges
come out as connected chains that climb from level-one foothills to a summit, and roughly two thirds of
mountain tiles stand above level one. The noise cell is deliberately coarse — 32 tiles — because at a
fine cell the same coverage breaks into isolated speckle instead of ranges.
Mountains block construction and movement through the same `isOpenTile` rule that blocks
water, so ranges wall off raider paths and scout routes while all production, logistics, population,
research, and combat continue on flat ground. A starter plot must be at least 87.5% open ground, so a
range may edge into a new player's plot but can never wall them in.

Height is a pure function of the world seed. Because clients never receive the seed, the server sends
`elevation` per tile beside `terrain`, filtered to explored chunks, so unexplored relief cannot be
reconstructed. The renderer raises each tile by its height, draws the cliff walls facing the viewer down
to whatever the lower neighbour is, caps the tallest level with snow, and scatters deterministic rock
facets so a plateau does not read as one slab. One height level rises half a tile block, a quarter of the
tile width in this 2:1 projection, so levels stack into real relief and a five-level summit reads as a
mountain while a range beside a settlement stays low enough not to swallow it. Ranges are drawn in the same depth-sorted pass as
buildings and raiders, so a range hides what is behind it and is hidden by what stands in front of it.

Picking follows the relief: a tile raised `L` levels is drawn `L` steps higher, so the tile whose top
face covers a point is the flat tile that many steps below it, tested from the tallest level down.
Cliff walls are deliberately not pickable — they belong to a tile whose top is elsewhere. One exception
keeps play sane: when the ground tile under the pointer holds a building or raider, that entity wins the
click even if rock is drawn in front of it. A mountain accepts no command, so nothing is lost.

### World rendering

The map is drawn from one texture atlas authored in 64×64 design cells and stored at 2×, so sprites
stay crisp on high-density displays; every frame declares its ground-contact origin, and the renderer
scales atlas pixels down to design pixels when drawing. Terrain shading is picked from a per-terrain
palette by a coordinate hash, which gives organic variation that is identical on every client and
reload. Ponds and deposits are drawn as surfaces inset into the tile so a ring of ground remains
visible around them instead of a hard-edged tile of another colour, and each deposit carries clutter —
boulders or conifers — whose stage shows the remaining yield on the map rather than only in the hover
tooltip. A range only carries stone clutter once a quarry has started working it, so untouched relief
still reads as terrain rather than as a resource pile. Sector ownership is drawn as a border along the
sides where the owner changes, in green for your own claim, so the terrain underneath stays readable.
Buildings, raiders, and carriers get a contact shadow, damaged buildings and wounded raiders get a health
bar, a loaded carrier states how much it is hauling, and tile markers are painted on the ground so
sprites occlude them correctly.

### Interface layout

The HUD keeps identity, connection status, the resource bar, and the next onboarding step in a header
that stays visible, and groups everything else into keyboard-navigable **Build**, **Settlement**,
**World**, **Co-op**, and **Settings** tabs. Build is the default so construction and building management
are the first thing a new player sees; accessibility options, control rebinding, renderer diagnostics,
and performance counters live under Settings. The tab strip is a standard ARIA tablist: arrow keys move
between tabs and Home/End jump to the ends. The build menu is generated from content definitions and
states the exact reason a placement is unavailable — missing materials of any kind, a locked technology,
no selected tile, or no deposit in range. Each completed building also offers its tier upgrade beside
repair and demolish, stating the cost, what the tier buys, and the downtime it will cost.
