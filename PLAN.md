# Kings of Glory Implementation Plan

This document is the ordered implementation plan for Kings of Glory. It starts from an empty codebase and ends with a production-ready browser game running one persistent global multiplayer world.

The order is intentional: build and validate a thin end-to-end multiplayer slice before expanding the production, settlement, civilization, and PvE systems. A phase is complete only when its exit criteria pass.

## Fixed project constraints

- The game runs in a browser.
- The world is rendered from an isometric perspective.
- Multiplayer takes place in one persistent global world.
- There are no matches, lobbies, matchmaking, shards, or player-versus-player combat.
- The server is authoritative. Browsers send commands, not state changes.
- Gameplay combines automation and production chains, settlement simulation, exploration, expansion, and technological progression.
- Players cooperate against PvE enemies and environmental threats.
- TypeScript is the primary language for the client, server, simulation, tools, and shared types.
- The initial implementation uses PixiJS, React, Vite, Node.js, `ws`, PostgreSQL, pnpm workspaces, and Vitest.
- Redis, a separate cache, microservices, and Docker are out of scope initially.
- The active world lives in the server's simulation memory. This is authoritative runtime state, not a cache. PostgreSQL is the durable source used to restore the world.

## Delivery strategy

Each milestone must produce a playable or verifiable result. New systems should first be implemented with the smallest useful content set, tested, and only then expanded.

| Milestone | Playable result |
| --- | --- |
| Foundation | Client and server build, test, and run from one workspace |
| Connected world | Multiple browsers enter the same world and receive synchronized state |
| Vertical slice | Players gather resources, construct a building, produce an item, and survive a basic threat |
| Automation | Production chains and logistics operate continuously |
| Settlement | Population, jobs, needs, and construction form a working settlement loop |
| Civilization | Exploration, territory, research, and progression unlock new capabilities |
| PvE world | Cooperative threats, enemies, defenses, and world events create pressure |
| Production readiness | The global world survives restarts, load, failures, and upgrades safely |

## Phase 0: Resolve product and technical decisions

These decisions affect saved data and most later systems, so settle them before significant implementation.

- [ ] Create `GAME_DESIGN.md` with the core player loop and explicit non-goals for the first playable release.
- [ ] Decide whether the global map is finite, expandable, or procedurally unbounded.
- [ ] Define tile dimensions, elevation rules, chunk dimensions, coordinate limits, and maximum buildable footprint.
- [ ] Decide which logistics model the first release uses: carriers, roads, belts, or a deliberately limited combination.
- [ ] Define the initial population model: individual settlers, aggregated workers, or a hybrid.
- [ ] Define the first production chain from raw resource to useful finished item.
- [ ] Define how players acquire territory and what prevents construction griefing.
- [ ] Define the cooperative model: private ownership, settlement groups, shared projects, and resource-transfer permissions.
- [ ] Define how new players receive a safe starting location without creating a separate world.
- [ ] Decide what happens to abandoned settlements and inactive accounts.
- [ ] Define whether simulation continues at full fidelity in areas with no nearby players.
- [ ] Define fair behavior during server downtime and maintenance. Do not silently grant or remove production unless it is a deliberate game rule.
- [ ] Define the first PvE threat, its trigger, its target-selection rules, and the conditions for recovery after defeat.
- [ ] Define a data-reset policy for development, alpha, beta, and public launch. A global persistent world makes resets materially disruptive.
- [ ] Select supported desktop and mobile browsers and the minimum viewport and hardware targets.
- [ ] Establish measurable budgets for client frame time, server tick time, memory, initial download size, reconnect time, and bandwidth per player.
- [ ] Establish an initial target for concurrent players and simulated entities. Treat it as a test target, not an architectural promise.
- [ ] Record architecture decisions that affect compatibility in `docs/decisions/` using short architecture decision records.

Exit criteria:

- The first release has a bounded feature list.
- World geometry, logistics, population, ownership, inactivity, and persistence semantics are documented.
- Performance budgets and supported browsers have numeric targets.

## Phase 1: Bootstrap the workspace

- [ ] Pin a Node.js version and the pnpm package-manager version.
- [ ] Create `pnpm-workspace.yaml` and a root `package.json` with scripts for development, building, testing, linting, type-checking, and formatting.
- [ ] Add a shared strict TypeScript configuration. Enable strict null checking and disallow unchecked indexed access.
- [ ] Create `apps/client` with Vite, React, and PixiJS.
- [ ] Create `apps/server` with Node.js and `ws`.
- [ ] Create initial packages for `simulation`, `protocol`, `content`, `pathfinding`, and `server-runtime`.
- [ ] Configure package boundaries so `simulation` cannot import browser, Node.js, networking, or persistence APIs.
- [ ] Add ESLint and formatting rules without allowing them to rewrite unrelated files automatically.
- [ ] Configure Vitest for unit and integration tests.
- [ ] Add environment-variable validation for the server. Fail at startup with actionable errors when required settings are missing.
- [ ] Add structured server logging with levels and stable event names.
- [ ] Add continuous integration that installs locked dependencies and runs formatting checks, linting, type-checking, tests, and production builds.
- [ ] Document local prerequisites and startup commands in the README.

Exit criteria:

- A fresh checkout can be installed and run from documented commands.
- The browser shows a placeholder canvas and React interface.
- The server exposes health information and accepts a WebSocket connection.
- CI validates both applications and all packages.

## Phase 2: Build the deterministic simulation kernel

- [ ] Define branded types for entity IDs, player IDs, world IDs, chunk coordinates, tile coordinates, and simulation ticks.
- [ ] Define isometric world coordinates independently from screen coordinates.
- [ ] Use integers or fixed-point numbers for state that must remain stable across ticks and replays.
- [ ] Implement a seeded pseudo-random number generator whose state is serializable.
- [ ] Implement the fixed-timestep simulation loop without networking or rendering dependencies.
- [ ] Define an explicit tick pipeline, for example: accept commands, validate, move, transport, produce, satisfy needs, run AI, resolve combat, emit events, and mark persistence changes.
- [ ] Define a command envelope containing command ID, player ID, client sequence, intended tick if needed, command type, and payload.
- [ ] Define domain events separately from network messages.
- [ ] Implement command validation with stable rejection codes suitable for UI messages.
- [ ] Implement entity registries and component data using plain serializable data. Do not adopt an ECS framework unless profiling or system complexity justifies it.
- [ ] Implement chunk addressing, neighboring-chunk lookup, and entity membership.
- [ ] Implement dirty tracking for changed entities and chunks.
- [ ] Implement snapshot serialization and deserialization with an explicit schema version.
- [ ] Implement a stable state hash for replay and desynchronization tests.
- [ ] Add tests proving identical initial state and command sequences produce identical hashes.
- [ ] Add invariant tests for unique IDs, valid ownership, non-negative inventory, valid coordinates, and entity-to-chunk membership.
- [ ] Add a headless simulation runner that can advance thousands of ticks quickly for testing.

Exit criteria:

- The simulation can run headlessly and deterministically.
- State can be snapshotted, restored, and advanced to the same hash.
- Invalid commands cannot mutate state.

## Phase 3: Implement the isometric browser client

- [ ] Bootstrap one PixiJS application inside the React shell. React owns menus and HUD; PixiJS owns the world canvas.
- [ ] Implement world-to-screen and screen-to-world projection functions with round-trip tests.
- [ ] Render a small tile grid with placeholder terrain assets.
- [ ] Implement camera pan, zoom, viewport resize, bounds, and configurable input bindings.
- [ ] Implement accurate tile and entity picking under the pointer.
- [ ] Implement sprite layering for terrain, buildings, units, effects, and selection markers.
- [ ] Avoid sorting the entire world every frame. Sort visible objects by stable isometric depth keys and update only when required.
- [ ] Implement chunk-based render containers, viewport culling, and object pooling where measurements justify it.
- [ ] Add selection, hover, placement preview, valid/invalid placement feedback, and cancellation controls.
- [ ] Add a React HUD shell with connection status, selected-object details, resources, notifications, and a build menu placeholder.
- [ ] Create an asset manifest and loading screen with progress and error handling.
- [ ] Use texture atlases and establish asset naming, scale, origin, and animation conventions.
- [ ] Add debug overlays for coordinates, chunks, entity IDs, paths, frame time, and visible-object count.
- [ ] Add rendering tests for projection math and lightweight browser tests for camera and selection behavior.

Exit criteria:

- A user can navigate an isometric map, select tiles and entities, and preview building placement.
- Only visible chunks are rendered.
- The debug overlay reports performance and world coordinates correctly.

## Phase 4: Connect every player to the global world

- [ ] Define a versioned network protocol in `packages/protocol`.
- [ ] Start with inspectable JSON messages. Move high-volume messages to binary encoding only after measurement.
- [ ] Define handshake, authentication, world bootstrap, chunk snapshot, state delta, command, acknowledgement, rejection, heartbeat, resync, maintenance, and server-error messages.
- [ ] Implement one global world host in the server. Do not implement room selection or matchmaking.
- [ ] Add development authentication that assigns stable test players. Replace it before public access.
- [ ] Implement monotonically increasing server tick and state-version numbers.
- [ ] Implement per-connection command sequence numbers and idempotency so retries do not apply a command twice.
- [ ] Validate message shape, size, frequency, permissions, coordinates, and game preconditions on the server.
- [ ] Implement interest management based on visible chunks plus explicitly relevant owned or observed entities.
- [ ] Send a complete snapshot when a chunk becomes relevant, then versioned deltas while it remains relevant.
- [ ] Handle entities moving between chunks without duplication or disappearance.
- [ ] Add acknowledgements and user-facing rejection reasons for player commands.
- [ ] Implement heartbeat, timeout, disconnect cleanup, exponential reconnect, and full resynchronization.
- [ ] Implement backpressure limits. Disconnect or degrade slow clients before their outgoing queues exhaust server memory.
- [ ] Ensure reconnecting players return to the same global world and regain their player state.
- [ ] Add protocol compatibility checks so an incompatible client receives an upgrade message instead of corrupted state.
- [ ] Add integration tests with multiple simulated clients, duplicate commands, reordered responses, disconnects, and reconnects.

Exit criteria:

- Two or more browsers enter the same world directly and see relevant synchronized changes.
- Invalid, duplicated, oversized, unauthorized, and stale commands are safely rejected.
- A disconnected browser can reconnect and resynchronize without creating a duplicate player.

## Phase 5: Add durable global-world persistence

- [ ] Select and document a PostgreSQL version supported in development and production.
- [ ] Add a migration tool and make schema migrations part of server startup or an explicit deployment step.
- [ ] Create tables for accounts, sessions, players, the single production world, settlements, completed checkpoints, chunk snapshots, command journal entries, and administrative audit events.
- [ ] Store schema versions with all serialized snapshots.
- [ ] Build a persistence interface outside `simulation` and a PostgreSQL implementation inside `server-runtime`.
- [ ] Create the single world exactly once and reject accidental creation of a second production world.
- [ ] Implement dirty-chunk checkpointing at a completed simulation tick.
- [ ] Write checkpoints under a new checkpoint ID and mark them complete only after all required records are durable. Restore only completed checkpoints.
- [ ] Journal accepted external commands with their target tick before they are considered durable.
- [ ] Ensure all nondeterministic administrative or wall-clock inputs enter the simulation as journaled commands or events.
- [ ] On startup, load the latest completed checkpoint and replay later journal entries.
- [ ] Persist player identity, ownership, last position, settlement references, and reconnect information.
- [ ] Define retention and compaction for old checkpoints and journal entries.
- [ ] Add graceful shutdown that stops accepting commands, completes a checkpoint, closes connections with a maintenance reason, and exits within a bounded time.
- [ ] Add crash-recovery tests that terminate the server during checkpoint creation and verify the previous completed checkpoint remains valid.
- [ ] Add migration tests using a database created from the oldest supported schema.
- [ ] Automate PostgreSQL backups and perform a documented restore drill before any public persistent test.
- [ ] Record and monitor recovery point and recovery time objectives.

Exit criteria:

- Server restarts restore the same world, players, ownership, and inventories.
- An interrupted checkpoint cannot corrupt the last recoverable state.
- A backup has been restored into a clean database and verified by state hashes and smoke tests.

## Phase 6: Deliver the first end-to-end gameplay vertical slice

- [ ] Generate deterministic terrain and one mineable resource type by chunk.
- [ ] Implement collision and buildability data for terrain tiles.
- [ ] Create a safe player-spawn algorithm that reserves space in the one global world.
- [ ] Give each new player a minimal settlement center and starting inventory.
- [ ] Implement one gathering action with server-side range, ownership, capacity, and availability checks.
- [ ] Implement one placeable production building.
- [ ] Implement construction cost, build time, completion, cancellation, and demolition.
- [ ] Implement inventories with item definitions, stack limits, transfer rules, and capacity checks.
- [ ] Implement one recipe that converts a gathered resource into a useful item over time.
- [ ] Display building state, recipe progress, inventory, and errors in the browser.
- [ ] Add one simple PvE hazard or enemy that damages a building and can be stopped or repaired.
- [ ] Persist and restore the complete slice.
- [ ] Add a scripted two-player scenario covering gathering, building, production, cooperation, threat response, disconnect, and restart.
- [ ] Profile the slice before adding more systems and record the first baseline metrics.

Exit criteria:

- Two players can join the global world, gather, construct, produce, and respond to a threat.
- All actions are authoritative, visible to relevant players, and durable across restart.
- The slice can be played for at least 30 minutes without manual database repair or server restart.

## Phase 7: Expand automation and production

- [ ] Define data schemas for items, resources, recipes, buildings, producers, storage, and logistics links.
- [ ] Validate all content at build time and server startup, including references and recipe cycles.
- [ ] Implement multiple resource nodes with finite or renewable behavior according to the game design.
- [ ] Implement the chosen logistics model from Phase 0.
- [ ] Implement input and output buffers, reservation rules, throughput, congestion, and blocked-machine states.
- [ ] Implement storage buildings and controlled resource-transfer priorities.
- [ ] Implement producer configuration and recipe switching without item duplication or loss.
- [ ] Implement construction logistics rather than creating completed buildings immediately where the design requires it.
- [ ] Add resource, logistics, production-rate, and bottleneck overlays.
- [ ] Add copy, upgrade, repair, pause, demolition, and configuration actions where appropriate.
- [ ] Define deterministic update order so production results do not depend on entity insertion order.
- [ ] Add property-based tests for inventory conservation, recipe conservation, capacity, and transport reservations.
- [ ] Add stress scenarios with thousands of buildings and transported items.
- [ ] Profile simulation cost per system and optimize measured bottlenecks.

Exit criteria:

- A multi-stage production chain can operate continuously and recover from blocked inputs or outputs.
- No tested sequence can duplicate or silently destroy resources outside explicit recipes and costs.
- The target-sized production settlement stays within the server tick budget.

## Phase 8: Implement the settlement simulation

- [ ] Implement the population model selected in Phase 0.
- [ ] Add housing, population capacity, growth or arrival, and departure or death rules.
- [ ] Add jobs, workplace assignment, availability, and priority controls.
- [ ] Add basic settler needs and a transparent satisfaction model.
- [ ] Add walking or transport behavior between homes, workplaces, storage, construction, and services where required.
- [ ] Implement hierarchical pathfinding: local paths inside chunks and higher-level routes across chunks.
- [ ] Add path invalidation when buildings, terrain, or threats change accessibility.
- [ ] Spread expensive path searches across ticks with explicit per-tick budgets.
- [ ] Implement construction workers and material delivery if not completed in the production phase.
- [ ] Add service buildings and settlement-level statistics.
- [ ] Add alerts for homelessness, unemployment, shortages, inaccessible destinations, and stalled construction.
- [ ] Add deterministic scheduling and fairness so low-ID entities do not permanently receive preferential service.
- [ ] Add headless long-duration tests for population stability, deadlocks, and pathfinding failures.

Exit criteria:

- A settlement can grow, assign work, satisfy basic needs, construct buildings, and visibly respond to shortages.
- Pathfinding cannot consume an unbounded fraction of a tick.
- Players can understand why a worker, building, or construction project is idle.

## Phase 9: Implement exploration and civilization progression

- [ ] Add unexplored, explored, and currently visible states for world chunks or tiles.
- [ ] Decide and implement which exploration information is private, settlement-shared, or globally shared.
- [ ] Ensure hidden entities and resources are never sent to unauthorized clients.
- [ ] Add exploration units or mechanics and safe server-authoritative movement commands.
- [ ] Add territory acquisition, borders, settlement influence, and construction permissions.
- [ ] Resolve border contention without PvP and provide fair, understandable outcomes.
- [ ] Add research resources, research production, prerequisites, and a data-driven technology graph.
- [ ] Validate the technology graph for missing references and unintended cycles.
- [ ] Implement unlocks for buildings, recipes, upgrades, exploration, and defenses.
- [ ] Add era or progression milestones if included in the game design.
- [ ] Add a technology interface, progression overview, and clear explanations of locked content.
- [ ] Add a strategic world-map view that requests aggregated data rather than every entity.
- [ ] Persist exploration, territory, and research state and migrate it safely when content changes.
- [ ] Add tests for fog-of-war information leaks and technology prerequisites.

Exit criteria:

- Players can explore the global world, claim valid territory, research technologies, and unlock a meaningful next tier.
- Clients receive no hidden-world information through snapshots, deltas, logs, or error messages.

## Phase 10: Build the cooperative PvE game

- [ ] Define a threat model connecting player expansion or world time to environmental pressure.
- [ ] Implement server-controlled enemy or hazard spawning with safe-distance and population rules.
- [ ] Implement PvE perception, target selection, navigation, attacks, damage, armor or resistance, and death.
- [ ] Implement defensive buildings, repair, replacement, and warning systems.
- [ ] Add environmental events that affect production or settlement decisions rather than only dealing damage.
- [ ] Add cooperative objectives or global events that allow multiple settlements to contribute.
- [ ] Make rewards deterministic, auditable, and safe against duplicate claims.
- [ ] Explicitly reject player-issued attacks against other players, allied units, or protected settlements.
- [ ] Add anti-griefing rules for blocking paths, surrounding settlements, consuming spawn resources, and dragging enemies onto others.
- [ ] Define threat behavior for offline players so leaving the game is neither an exploit nor guaranteed destruction.
- [ ] Add difficulty telemetry and content configuration without embedding balance constants throughout code.
- [ ] Add AI behavior tests, combat conservation tests, pathfinding stress tests, and long-running threat simulations.

Exit criteria:

- PvE creates escalating, understandable pressure and meaningful reasons to cooperate.
- There is no supported player-versus-player damage path.
- Offline, new, and defeated players have documented and tested protection or recovery rules.

## Phase 11: Add cooperation, trade, and global-world governance

- [ ] Implement settlement membership and roles with least-privilege defaults.
- [ ] Define permissions for building, configuring production, withdrawing resources, inviting players, and contributing to projects.
- [ ] Implement direct resource transfers or trade offers as atomic server transactions.
- [ ] Prevent duplication through retries, disconnects, concurrent acceptance, and inventory-capacity changes.
- [ ] Add shared construction projects and contribution history if included in the first release.
- [ ] Add player and settlement discovery without exposing private or hidden information.
- [ ] Add chat or another minimal cooperation channel with rate limits, blocking, reporting, and moderation controls.
- [ ] Implement names with normalization, uniqueness rules, length limits, and content-moderation support.
- [ ] Implement ownership transfer, settlement departure, account deletion, and inactive-player policies.
- [ ] Add administrative tools for inspecting players, settlements, transactions, and world state without direct database editing.
- [ ] Audit all administrative mutations with actor, reason, before/after state, and tick.
- [ ] Add conflict and concurrency tests for trades, permissions, membership, and ownership changes.

Exit criteria:

- Players can cooperate and exchange resources without trusting client calculations.
- Permission and trade operations remain correct under retries and concurrent requests.
- Moderators can investigate and correct serious issues through audited tools.

## Phase 12: Complete UX, onboarding, and accessibility

- [ ] Build an onboarding flow that teaches camera movement, gathering, construction, production, logistics, settlement needs, research, and threats in the global world.
- [ ] Ensure onboarding cannot reserve unlimited land or resources through abandoned accounts.
- [ ] Build searchable construction, recipe, inventory, population, research, defense, and alert interfaces.
- [ ] Provide actionable explanations for rejected commands and stalled systems.
- [ ] Add notification grouping and severity so large settlements do not overwhelm players.
- [ ] Add keyboard navigation and remappable controls for primary actions.
- [ ] Avoid relying on color alone and provide readable contrast and scalable UI text.
- [ ] Add reduced-motion and volume controls where relevant.
- [ ] Provide loading, reconnecting, maintenance, version-mismatch, and unrecoverable-error screens.
- [ ] Persist client preferences locally without treating them as authoritative game data.
- [ ] Test supported viewport sizes, zoom levels, input methods, and browsers.
- [ ] Conduct playtests with new players and revise interfaces based on observed confusion rather than only stated preferences.

Exit criteria:

- A new player can reach the first working production chain without developer assistance.
- Important game states and failures are discoverable and understandable.
- The supported accessibility and browser targets from Phase 0 are verified.

## Phase 13: Meet performance and scale budgets

- [ ] Add server metrics for tick duration by subsystem, command latency, connected players, entity count, active chunks, path queue, snapshot time, journal lag, memory, and outgoing queue size.
- [ ] Add client metrics for frame time, render-object count, active chunks, asset memory, message rate, and update-application time.
- [ ] Build headless bot clients that gather, build, expand, research, trade, reconnect, and react to threats.
- [ ] Build reproducible load scenarios at the target player and entity counts.
- [ ] Test hot spots where many players observe or modify the same chunks.
- [ ] Profile before optimizing and record benchmark inputs with every performance claim.
- [ ] Optimize interest management, delta construction, spatial indexes, dirty tracking, and serialization based on profiles.
- [ ] Add level-of-detail simulation for inactive regions only if the game design permits equivalent outcomes.
- [ ] Batch or budget pathfinding, AI planning, world generation, persistence, and large administrative operations.
- [ ] Consider Node.js worker threads only for measured CPU-heavy tasks with clear ownership and bounded message costs.
- [ ] Move high-volume protocol messages from JSON to a versioned binary format only if bandwidth or parsing exceeds its budget.
- [ ] Establish hard safety limits for message size, subscriptions, queued paths, construction commands, and outbound buffers.
- [ ] Run multi-hour soak tests and investigate memory growth, event-loop stalls, tick overruns, and state-hash failures.
- [ ] Document the measured threshold at which one Node.js process no longer meets the world target. Do not introduce sharding prematurely; any future partition must preserve one logical world.

Exit criteria:

- Client, server, network, and persistence budgets from Phase 0 pass under the target load.
- A soak test completes without unbounded memory growth, unrecoverable tick drift, or simulation corruption.
- Degradation and safety limits fail visibly and safely rather than crashing the global world.

## Phase 14: Secure the public service

- [ ] Produce a threat model covering command forgery, hidden-state extraction, resource duplication, account takeover, spam, griefing, denial of service, dependency compromise, and administrator misuse.
- [ ] Replace development identity with production authentication and secure session management.
- [ ] Use secure, HTTP-only, same-site cookies or an equivalently reviewed token design.
- [ ] Require TLS in production and validate WebSocket origins.
- [ ] Validate every untrusted HTTP, WebSocket, content, administrative, and database boundary.
- [ ] Enforce server-side authorization for every command and query.
- [ ] Add per-connection and per-account rate limits without introducing a separate cache service.
- [ ] Add request and message size limits before parsing large payloads.
- [ ] Prevent clients from selecting arbitrary player IDs, ticks, entity ownership, costs, rewards, or outcomes.
- [ ] Keep secrets out of the repository and logs. Define rotation procedures.
- [ ] Use separate least-privilege database roles for migrations, runtime access, and backups.
- [ ] Add dependency scanning, lockfile review, and a documented update cadence.
- [ ] Sanitize user-generated text and configure browser security headers.
- [ ] Avoid logging session secrets, private messages, or hidden-world payloads.
- [ ] Conduct abuse tests and a focused security review before public registration.

Exit criteria:

- The threat model has mitigations and owners for all high-risk paths.
- Authentication, authorization, protocol fuzzing, rate limits, and duplication attempts have automated tests.
- Runtime and backup credentials have only the permissions they require.

## Phase 15: Add operations and safe deployment

- [ ] Define development, test, staging, and production configuration. Production still contains exactly one player-facing global world; non-production worlds are disposable test environments.
- [ ] Choose a hosting approach for the static browser assets, Node.js process, and PostgreSQL without requiring Docker.
- [ ] Add liveness and readiness endpoints that distinguish process health from world readiness.
- [ ] Add structured logs with correlation IDs for connections, commands, players, checkpoints, and failures.
- [ ] Create dashboards and alerts for tick overruns, crashes, database failures, failed checkpoints, journal lag, connection spikes, memory pressure, and backup failure.
- [ ] Add graceful restart and maintenance mode with clear browser messaging.
- [ ] Make deployments reject incompatible database, snapshot, content, or protocol versions before accepting players.
- [ ] Define forward-only database migrations and versioned snapshot migrations.
- [ ] Test application rollback separately from data rollback; do not assume a database schema can be safely downgraded.
- [ ] Automate production backups with retention and off-host storage.
- [ ] Schedule recurring restore drills and record their duration and verification results.
- [ ] Write runbooks for failed deployment, corrupted latest checkpoint, database outage, runaway tick time, malicious client flood, lost credentials, and world rollback.
- [ ] Add a world-consistency inspection command that can run read-only against a checkpoint.
- [ ] Define maintenance windows and player communication procedures.

Exit criteria:

- The service can be deployed, observed, placed into maintenance, restarted, and restored using documented procedures.
- Operators can detect a stuck or unhealthy world before players are the monitoring system.
- A failed deployment can be contained without improvising direct database changes.

## Phase 16: Test and release the global world

- [ ] Maintain unit tests for pure rules, invariants, coordinates, recipes, permissions, AI decisions, and serialization.
- [ ] Maintain property-based tests for conservation, bounds, idempotency, and concurrency-sensitive systems.
- [ ] Maintain integration tests for WebSockets, PostgreSQL, checkpoints, journal replay, reconnect, migrations, and authentication.
- [ ] Add browser end-to-end tests for onboarding and the critical gather-build-produce-research-defend loop.
- [ ] Maintain deterministic replay scenarios and compare final state hashes in CI.
- [ ] Run compatibility tests in every supported browser.
- [ ] Run load, soak, crash, restart, backup, restore, and interrupted-deployment tests against release candidates.
- [ ] Run a private internal world and fix all world-corrupting, duplication, authorization, and recovery defects before inviting external players.
- [ ] Run a closed alpha focused on comprehension, simulation correctness, persistence, and cooperative behavior.
- [ ] Decide and communicate whether the alpha world will reset.
- [ ] Run a beta at the planned concurrency target and tune progression, resource distribution, onboarding placement, and PvE pressure using telemetry and playtests.
- [ ] Freeze incompatible save and protocol changes before declaring the production world permanent.
- [ ] Prepare support, moderation, incident, privacy, terms, and data-deletion processes appropriate to the chosen authentication and communication features.
- [ ] Perform a final restore drill and full release checklist immediately before launch.

Exit criteria:

- No open defect can corrupt the world, duplicate resources, bypass authorization, expose hidden state, or prevent recovery.
- The release candidate passes supported-browser, target-load, soak, restart, and restore tests.
- Reset policy, maintenance expectations, and player support channels are public before the persistent world opens.

## Suggested test pyramid

1. **Pure unit tests:** simulation rules, projections, content validation, commands, AI decisions, and state migrations.
2. **Property and invariant tests:** resource conservation, capacity, unique ownership, valid references, replay determinism, and bounded coordinates.
3. **Package integration tests:** simulation plus protocol, persistence adapters, snapshot recovery, and command journal replay.
4. **Server integration tests:** real WebSocket clients and a real PostgreSQL test database.
5. **Browser tests:** camera, selection, placement, HUD, reconnect, and the critical gameplay loop.
6. **Load and soak tests:** bot players, large settlements, concentrated activity, long runtimes, and repeated reconnects.
7. **Recovery tests:** process termination, incomplete checkpoint, database unavailability, migration failure, backup restore, and application rollback.

Every defect that can affect persistent state should receive a regression test at the lowest practical level plus a replay or integration test when appropriate.

## Content implementation order

Do not create a large content catalog before the systems are proven. Add content in this order:

1. One terrain set, one resource, one gatherer, one producer, one recipe, one storage building, and one threat.
2. One complete multi-stage production chain with a meaningful output.
3. Housing, workers, one need, and one service building.
4. One research branch that unlocks a production upgrade and a defense.
5. One exploration mechanic, one territory expansion mechanic, and one cooperative objective.
6. Enough alternative recipes, buildings, technologies, and threats to support strategic choice.
7. Balance passes, visual variety, audio, narrative framing, and long-term progression.

Each content definition must have a stable identifier, schema validation, localization-ready display text, migration policy, and automated reference checks.

## Overall definition of done

Kings of Glory is ready for its first public persistent release when all of the following are true:

- Players can open the game in a supported browser and enter the one global world without matchmaking.
- The isometric client remains responsive at the target settlement and entity scale.
- Multiple players can build, automate, manage settlements, explore, research, trade, and cooperate.
- PvE enemies and environmental events create a sustainable challenge without enabling PvP.
- The server rejects invalid and unauthorized commands and does not trust client-calculated outcomes.
- Relevant state synchronizes correctly through normal play, reconnects, and slow connections.
- The world, ownership, inventories, progression, and player positions survive crashes, restarts, migrations, and deployments.
- Backups are automatic and a clean restore has been demonstrated within the recovery objective.
- The target load and soak tests pass within client, server, database, and network budgets.
- Operators have monitoring, alerts, maintenance controls, audit trails, and incident runbooks.
- New players can learn the core loop and join the established global world without being blocked or immediately destroyed.
- No known critical issue can corrupt persistent state, duplicate resources, expose hidden state, bypass permissions, or make the world unrecoverable.

## First implementation sequence

When development begins, take these first steps in order:

1. Complete the Phase 0 decisions and freeze the first vertical-slice scope.
2. Bootstrap the pnpm workspace and CI.
3. Implement and test world coordinates, chunks, fixed ticks, commands, snapshots, and deterministic replay.
4. Render and navigate a placeholder isometric map.
5. Connect two browsers to the single authoritative world.
6. Add versioned chunk snapshots, deltas, command acknowledgements, and reconnect.
7. Add PostgreSQL checkpoints and crash recovery.
8. Implement the gather-build-produce-threat vertical slice.
9. Profile and correct the architecture before expanding content.
10. Continue through automation, settlement, civilization, PvE, cooperation, hardening, and release phases in dependency order.
