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

The server listens on `http://127.0.0.1:3001/health` and WebSocket clients connect on port 3001. Vite serves the client at `http://127.0.0.1:5173`. By default the client connects to the same hostname as the page, so local `127.0.0.1` and LAN development addresses work; set `VITE_SERVER_URL` to override it. The client uses a stable per-tab development identity; production authentication is intentionally deferred.

The current JSON WebSocket protocol is version 2. A client sends `hello`, then receives a `welcome` handshake acknowledgement and a filtered `worldBootstrap`. Newly relevant viewport chunks receive a replacement `chunkSnapshot`; ordinary changes use ordered `stateDelta` messages. Commands receive either `commandAcknowledged` or `commandRejected`, while `ping`/`pong`, `resync`, `maintenance`, and `error` cover connection health and recovery.

To exercise the durable-world adapter, run PostgreSQL 16 or newer and start the server with a connection string. Startup applies the forward-only initial schema and restores the newest completed checkpoint before accepting clients.

```powershell
$env:PERSISTENCE = 'postgres'
$env:DATABASE_URL = 'postgres://kings:kings@localhost:5432/kings_of_glory'
npm --prefix apps/server run dev
```

`PERSISTENCE=memory` remains the default for local UI work. PostgreSQL mode journals accepted commands before applying them, saves a completed checkpoint every 300 ticks, retains the newest three completed checkpoints with replayable journal history, and writes one final checkpoint during graceful shutdown. See [001_initial.sql](packages/server-runtime/migrations/001_initial.sql) for the initial schema.

New worlds are peaceful by default, so no PvE threats spawn; start the server with `PEACEFUL=false` to create a world with raids enabled. The flag is stored in world state, so it applies when a world is first created — with `PERSISTENCE=memory` that is every restart, while a persisted PostgreSQL world keeps whatever value it was created with.

Operational procedures for failed deployments, storage failures, runaway ticks, client floods, and
world rollback are in the [operations runbook](docs/runbooks/operations.md).

The server exposes `/health`, `/ready`, and a Prometheus-compatible `/metrics` endpoint. `/health` reports whether the process is live; `/ready` returns `503` during maintenance so traffic can drain before the final checkpoint. Metrics include full-state and delta message/byte totals, state-build time, the latest checkpoint tick, restore duration, journal lag, pending commands, and total buffered outbound bytes, so snapshot and slow-client regressions are observable. The first-slice recovery objective is zero accepted-command data loss and a five-minute verified recovery; see the [checkpoint recovery runbook](docs/runbooks/checkpoint-recovery.md). Structured connection, disconnect, and command-failure logs include a correlation ID but never include a command payload. In production set `NODE_ENV=production` and a comma-separated `ALLOWED_ORIGINS` list; WebSocket connections from other origins are rejected. Each connection is rate-limited to 30 messages per second, heartbeats every 15 seconds, and is disconnected when its buffered outbound data exceeds 1 MB or it remains silent for 45 seconds.

To inspect a serialized checkpoint state without changing it, build the workspace and run `npm --prefix apps/server run inspect -- path/to/checkpoint.json`. The inspector reports invalid owners, overlapping buildings, invalid inventories, malformed populations, dangling threat targets, incomplete checkpoints, and mismatched checkpoint hashes.

Run the deterministic bot baseline with `npm --prefix apps/server run load -- [players] [ticks] [buildings-per-player]`. It reports duration, tick throughput, command count, entity count, final state hash, and end-of-run memory with deltas; record these values when evaluating performance changes.
For a dense logistics fixture, run `npm --prefix apps/server run profile -- [pairs>=1000] [ticks]`; it reports total and per-tick time for each authoritative simulation phase.
See [the current first-slice baseline](docs/performance-baseline.md) for a reproducible 20-player run.

## Current vertical slice

This increment provides a strict TypeScript workspace, a platform-independent deterministic simulation, a versioned JSON WebSocket handshake, a single authoritative world host, durable checkpoint/journal foundations, and a React/Canvas 2D isometric map. Players gather finite ore deposits (gray map tiles) and timber groves (brown map tiles), construct smelters, workshops, storage, housing, and hearths, turn ore into ingots and ingots plus wood into tools, and build recipe-validated links that automate storage-to-smelter and smelter-to-workshop delivery. The HUD explains a producer's actual recipe duration and missing inputs; housing, jobs, and a completed hearth determine settlement wellbeing. Players repair damage from acid rain or raiders. Tests cover deterministic replay, command rejection, resource conservation, content validation, protocol shape validation, snapshot migration, and checkpoint recovery.
