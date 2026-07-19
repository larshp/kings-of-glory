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
+ PixiJS world renderer
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
- **World rendering:** PixiJS
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
  client/           Browser client using PixiJS and React
  server/           Authoritative global-world server

packages/
  simulation/       Platform-independent game simulation
  protocol/         Commands, events, and serialized state
  content/          Buildings, resources, units, and technologies
  pathfinding/      Navigation and logistics algorithms
  server-runtime/   WebSocket and PostgreSQL integration
```

## Local development

Prerequisites: Node.js 22.16.0 (see `.nvmrc`) and Corepack. The repository pins pnpm 10.14.0. GitHub Actions runs the same locked install, format, lint, build, and test gate on pull requests and `main`.

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm lint
```

Start the authoritative world host in one terminal and the browser client in another:

```powershell
pnpm --filter @kings/server dev
pnpm --filter @kings/client dev
```

The server listens on `http://localhost:3001/health` and WebSocket clients connect on port 3001. Vite serves the client URL it prints (normally `http://localhost:5173`). The client uses a stable per-tab development identity; production authentication is intentionally deferred.

To exercise the durable-world adapter, run PostgreSQL 16 or newer and start the server with a connection string. Startup applies the forward-only initial schema and restores the newest completed checkpoint before accepting clients.

```powershell
$env:PERSISTENCE = 'postgres'
$env:DATABASE_URL = 'postgres://kings:kings@localhost:5432/kings_of_glory'
pnpm --filter @kings/server dev
```

`PERSISTENCE=memory` remains the default for local UI work. PostgreSQL mode journals accepted commands before applying them, saves a completed checkpoint every 300 ticks, retains the newest three completed checkpoints with replayable journal history, and writes one final checkpoint during graceful shutdown. See [001_initial.sql](packages/server-runtime/migrations/001_initial.sql) for the initial schema.

The server exposes `/health`, `/ready`, and a Prometheus-compatible `/metrics` endpoint. `/health` reports whether the process is live; `/ready` returns `503` during maintenance so traffic can drain before the final checkpoint. Metrics include full-state and delta message/byte totals plus state-build time, so snapshot regressions are observable. In production set `NODE_ENV=production` and a comma-separated `ALLOWED_ORIGINS` list; WebSocket connections from other origins are rejected. Each connection is rate-limited to 30 messages per second, heartbeats every 15 seconds, and is disconnected when its buffered outbound data exceeds 1 MB or it remains silent for 45 seconds.

To inspect a serialized checkpoint state without changing it, build the workspace and run `pnpm --filter @kings/server inspect path/to/checkpoint.json`. The inspector reports invalid owners, overlapping buildings, invalid inventories, malformed populations, and dangling threat targets.

Run the deterministic bot baseline with `pnpm --filter @kings/server load [players] [ticks]`. It reports duration, tick throughput, command count, entity count, and final state hash; record these values when evaluating performance changes.

## Current vertical slice

This increment provides a strict TypeScript workspace, a platform-independent deterministic simulation, a versioned JSON WebSocket handshake, a single authoritative world host, durable checkpoint/journal foundations, and a React/PixiJS isometric map. Players can gather ore, construct smelters, storage, and housing, move items through building inventories, link storage to smelters for deterministic ore delivery, and grow an aggregated workforce. Tests cover deterministic replay, command rejection, resource conservation, content validation, protocol shape validation, and checkpoint recovery.
