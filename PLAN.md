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
- The initial implementation uses Canvas 2D, React, Vite, Node.js, `ws`, PostgreSQL, pnpm workspaces, and Vitest.
- Redis, a separate cache, microservices, and Docker are out of scope initially.
- The active world lives in the server's simulation memory. This is authoritative runtime state, not a cache. PostgreSQL is the durable source used to restore the world.

## Delivery strategy

Each milestone must produce a playable or verifiable result. New systems should first be implemented with the smallest useful content set, tested, and only then expanded.

| Milestone            | Playable result                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------- |
| Foundation           | Client and server build, test, and run from one workspace                                   |
| Connected world      | Multiple browsers enter the same world and receive synchronized state                       |
| Vertical slice       | Players gather resources, construct a building, produce an item, and survive a basic threat |
| Automation           | Production chains and logistics operate continuously                                        |
| Settlement           | Population, jobs, needs, and construction form a working settlement loop                    |
| Civilization         | Exploration, territory, research, and progression unlock new capabilities                   |
| PvE world            | Cooperative threats, enemies, defenses, and world events create pressure                    |
| Production readiness | The global world survives restarts, load, failures, and upgrades safely                     |

## Phase 0: Resolve product and technical decisions

These decisions affect saved data and most later systems, so settle them before significant implementation.

- [x] Create `GAME_DESIGN.md` with the core player loop and explicit non-goals for the first playable release.
- [x] Decide whether the global map is finite, expandable, or procedurally unbounded.
- [x] Define tile dimensions, elevation rules, chunk dimensions, coordinate limits, and maximum buildable footprint.
- [x] Decide which logistics model the first release uses: carriers, roads, belts, or a deliberately limited combination.
- [x] Define the initial population model: individual settlers, aggregated workers, or a hybrid.
- [x] Define the first production chain from raw resource to useful finished item.
- [x] Define how players acquire territory and what prevents construction griefing.
- [x] Define the cooperative model: private ownership, settlement groups, shared projects, and resource-transfer permissions.
- [x] Define how new players receive a safe starting location without creating a separate world.
- [x] Decide what happens to abandoned settlements and inactive accounts.
- [x] Define whether simulation continues at full fidelity in areas with no nearby players.
- [x] Define fair behavior during server downtime and maintenance. Do not silently grant or remove production unless it is a deliberate game rule.
- [x] Define the first PvE threat, its trigger, its target-selection rules, and the conditions for recovery after defeat.
- [x] Define a data-reset policy for development, alpha, beta, and public launch. A global persistent world makes resets materially disruptive.
- [x] Select supported desktop and mobile browsers and the minimum viewport and hardware targets.
- [x] Establish measurable budgets for client frame time, server tick time, memory, initial download size, reconnect time, and bandwidth per player.
- [x] Establish an initial target for concurrent players and simulated entities. Treat it as a test target, not an architectural promise.
- [x] Record architecture decisions that affect compatibility in `docs/decisions/` using short architecture decision records.

Exit criteria:

- The first release has a bounded feature list.
- World geometry, logistics, population, ownership, inactivity, and persistence semantics are documented.
- Performance budgets and supported browsers have numeric targets.

## Phase 1: Bootstrap the workspace

- [x] Pin a Node.js version and the pnpm package-manager version.
- [x] Create `pnpm-workspace.yaml` and a root `package.json` with scripts for development, building, testing, linting, type-checking, and formatting.
- [x] Add a shared strict TypeScript configuration. Enable strict null checking and disallow unchecked indexed access.
- [x] Create `apps/client` with Vite, React, and a Canvas 2D renderer.
- [x] Create `apps/server` with Node.js and `ws`.
- [x] Create initial packages for `simulation`, `protocol`, `content`, `pathfinding`, and `server-runtime`.
- [x] Configure package boundaries so `simulation` cannot import browser, Node.js, networking, or persistence APIs.
- [x] Add ESLint and formatting rules without allowing them to rewrite unrelated files automatically.
- [x] Configure Vitest for unit and integration tests.
- [x] Add environment-variable validation for the server. Fail at startup with actionable errors when required settings are missing.
- [x] Add structured server logging with levels and stable event names.
- [x] Add continuous integration that installs locked dependencies and runs formatting checks, linting, type-checking, tests, and production builds.
- [x] Document local prerequisites and startup commands in the README.

Exit criteria:

- A fresh checkout can be installed and run from documented commands.
- The browser shows a placeholder canvas and React interface.
- The server exposes health information and accepts a WebSocket connection.
- CI validates both applications and all packages.

## Phase 2: Build the deterministic simulation kernel

- [x] Define branded types for entity IDs, player IDs, world IDs, chunk coordinates, tile coordinates, and simulation ticks.
- [x] Define isometric world coordinates independently from screen coordinates.
- [x] Use integers or fixed-point numbers for state that must remain stable across ticks and replays.
- [x] Implement a seeded pseudo-random number generator whose state is serializable.
- [x] Implement the fixed-timestep simulation loop without networking or rendering dependencies.
- [x] Define an explicit tick pipeline, for example: accept commands, validate, move, transport, produce, satisfy needs, run AI, resolve combat, emit events, and mark persistence changes.
- [x] Define a command envelope containing command ID, player ID, client sequence, intended tick if needed, command type, and payload.
- [x] Define domain events separately from network messages.
- [x] Implement command validation with stable rejection codes suitable for UI messages.
- [x] Implement entity registries and component data using plain serializable data. Do not adopt an ECS framework unless profiling or system complexity justifies it.
- [x] Implement chunk addressing, neighboring-chunk lookup, and entity membership.
- [x] Implement dirty tracking for changed entities and chunks.
- [x] Implement snapshot serialization and deserialization with an explicit schema version.
- [x] Implement a stable state hash for replay and desynchronization tests.
- [x] Add tests proving identical initial state and command sequences produce identical hashes.
- [x] Add invariant tests for unique IDs, valid ownership, non-negative inventory, valid coordinates, and entity-to-chunk membership.
- [x] Add a headless simulation runner that can advance thousands of ticks quickly for testing.

Exit criteria:

- The simulation can run headlessly and deterministically.
- State can be snapshotted, restored, and advanced to the same hash.
- Invalid commands cannot mutate state.

## Phase 3: Implement the isometric browser client

- [x] Bootstrap one Canvas 2D renderer inside the React shell. React owns menus and HUD; the renderer owns the world canvas.
- [x] Implement world-to-screen and screen-to-world projection functions with round-trip tests.
- [x] Render a small tile grid with placeholder terrain assets.
- [x] Implement camera pan, zoom, viewport resize, bounds, and configurable input bindings.
- [x] Implement accurate tile and entity picking under the pointer.
- [x] Implement sprite layering for terrain, buildings, units, effects, and selection markers.
- [x] Avoid sorting the entire world every frame. Sort visible objects by stable isometric depth keys and update only when required.
- [x] Implement chunk-based render containers, viewport culling, and object pooling where measurements justify it.
- [x] Add selection, hover, placement preview, valid/invalid placement feedback, and cancellation controls.
- [x] Add a React HUD shell with connection status, selected-object details, resources, notifications, and a build menu placeholder.
- [x] Create an asset manifest and loading screen with progress and error handling.
- [x] Use texture atlases and establish asset naming, scale, origin, and animation conventions.
- [x] Add debug overlays for coordinates, chunks, entity IDs, paths, frame time, and visible-object count.
- [x] Add rendering tests for projection math and lightweight browser tests for camera and selection behavior.

Exit criteria:

- A user can navigate an isometric map, select tiles and entities, and preview building placement.
- Only visible chunks are rendered.
- The debug overlay reports performance and world coordinates correctly.

## Phase 4: Connect every player to the global world

- [x] Define a versioned network protocol in `packages/protocol`.
- [x] Start with inspectable JSON messages. Move high-volume messages to binary encoding only after measurement.
- [x] Define handshake, authentication, world bootstrap, chunk snapshot, state delta, command, acknowledgement, rejection, heartbeat, resync, maintenance, and server-error messages.
- [x] Implement one global world host in the server. Do not implement room selection or matchmaking.
- [x] Add development authentication that assigns stable test players. Replace it before public access.
- [x] Implement monotonically increasing server tick and state-version numbers.
- [x] Implement per-connection command sequence numbers and idempotency so retries do not apply a command twice.
- [x] Validate message shape, size, frequency, permissions, coordinates, and game preconditions on the server.
- [x] Implement interest management based on visible chunks plus explicitly relevant owned or observed entities.
- [x] Send a complete snapshot when a chunk becomes relevant, then versioned deltas while it remains relevant.
- [x] Handle entities moving between chunks without duplication or disappearance.
- [x] Add acknowledgements and user-facing rejection reasons for player commands.
- [x] Implement heartbeat, timeout, disconnect cleanup, exponential reconnect, and full resynchronization.
- [x] Implement backpressure limits. Disconnect or degrade slow clients before their outgoing queues exhaust server memory.
- [x] Ensure reconnecting players return to the same global world and regain their player state.
- [x] Add protocol compatibility checks so an incompatible client receives an upgrade message instead of corrupted state.
- [x] Add integration tests with multiple simulated clients, duplicate commands, reordered responses, disconnects, and reconnects.

Exit criteria:

- Two or more browsers enter the same world directly and see relevant synchronized changes.
- Invalid, duplicated, oversized, unauthorized, and stale commands are safely rejected.
- A disconnected browser can reconnect and resynchronize without creating a duplicate player.

## Phase 5: Add durable global-world persistence

- [x] Select and document a PostgreSQL version supported in development and production.
- [x] Add a migration tool and make schema migrations part of server startup or an explicit deployment step.
- [x] Create tables for accounts, sessions, players, the single production world, settlements, completed checkpoints, chunk snapshots, command journal entries, and administrative audit events.
- [x] Store schema versions with all serialized snapshots.
- [x] Build a persistence interface outside `simulation` and a PostgreSQL implementation inside `server-runtime`.
- [x] Create the single world exactly once and reject accidental creation of a second production world.
- [x] Implement dirty-chunk checkpointing at a completed simulation tick.
- [x] Write checkpoints under a new checkpoint ID and mark them complete only after all required records are durable. Restore only completed checkpoints.
- [x] Journal accepted external commands with their target tick before they are considered durable.
- [x] Ensure all nondeterministic administrative or wall-clock inputs enter the simulation as journaled commands or events.
- [x] On startup, load the latest completed checkpoint and replay later journal entries.
- [x] Persist player identity, ownership, last position, settlement references, and reconnect information.
- [x] Define retention and compaction for old checkpoints and journal entries.
- [x] Add graceful shutdown that stops accepting commands, completes a checkpoint, closes connections with a maintenance reason, and exits within a bounded time.
- [x] Add crash-recovery tests that terminate the server during checkpoint creation and verify the previous completed checkpoint remains valid.
- [x] Add migration tests using a database created from the oldest supported schema.
- [x] Automate PostgreSQL backups with checksummed checkpoint evidence.
- [ ] Perform a documented restore drill before any public persistent test.
- [x] Record and monitor recovery point and recovery time objectives.

Exit criteria:

- Server restarts restore the same world, players, ownership, and inventories.
- An interrupted checkpoint cannot corrupt the last recoverable state.
- A backup has been restored into a clean database and verified by state hashes and smoke tests.

## Phase 6: Deliver the first end-to-end gameplay vertical slice

- [x] Generate deterministic terrain and one mineable resource type by chunk.
- [x] Implement collision and buildability data for terrain tiles.
- [x] Create a safe player-spawn algorithm that reserves space in the one global world.
- [x] Give each new player a minimal settlement center and starting inventory.
- [x] Implement one gathering action with server-side range, ownership, capacity, and availability checks.
- [x] Implement one placeable production building.
- [x] Implement construction cost, build time, completion, cancellation, and demolition.
- [x] Implement inventories with item definitions, stack limits, transfer rules, and capacity checks.
- [x] Implement one recipe that converts a gathered resource into a useful item over time.
- [x] Display building state, recipe progress, inventory, and errors in the browser.
- [x] Add one simple PvE hazard or enemy that damages a building and can be stopped or repaired.
- [x] Persist and restore the complete slice.
- [x] Add a scripted two-player scenario covering gathering, building, production, cooperation, threat response, disconnect, and restart.
- [x] Profile the slice before adding more systems and record the first baseline metrics.

Exit criteria:

- Two players can join the global world, gather, construct, produce, and respond to a threat.
- All actions are authoritative, visible to relevant players, and durable across restart.
- The slice can be played for at least 30 minutes without manual database repair or server restart.

## Phase 7: Expand automation and production

- [x] Define data schemas for items, resources, recipes, buildings, producers, storage, and logistics links.
- [x] Validate all content at build time and server startup, including references and recipe cycles.
- [x] Implement multiple resource nodes with finite or renewable behavior according to the game design.
- [x] Automate raw extraction with mines and lumber camps so the production chain does not depend on a manual gather command, using the same finite deposits, reservations, and worker pool.
- [x] Implement the chosen logistics model from Phase 0.
- [x] Implement input and output buffers, reservation rules, throughput, congestion, and blocked-machine states.
- [x] Implement storage buildings and controlled resource-transfer priorities.
- [x] Implement producer configuration and recipe switching without item duplication or loss.
- [x] Implement construction logistics rather than creating completed buildings immediately where the design requires it.
- [x] Add resource, logistics, production-rate, and bottleneck overlays.
- [x] Add copy, upgrade, repair, pause, demolition, and configuration actions where appropriate.
- [x] Define deterministic update order so production results do not depend on entity insertion order.
- [x] Add property-based tests for inventory conservation, recipe conservation, capacity, and transport reservations.
- [x] Add stress scenarios with thousands of buildings and transported items.
- [x] Profile simulation cost per system and optimize measured bottlenecks.

Exit criteria:

- A multi-stage production chain can operate continuously and recover from blocked inputs or outputs.
- No tested sequence can duplicate or silently destroy resources outside explicit recipes and costs.
- The target-sized production settlement stays within the server tick budget.

## Phase 8: Implement the settlement simulation

- [x] Implement the population model selected in Phase 0.
- [x] Add housing, population capacity, growth or arrival, and departure or death rules.
- [x] Add jobs, workplace assignment, availability, and priority controls.
- [x] Add basic settler needs and a transparent satisfaction model.
- [x] Add walking or transport behavior between homes, workplaces, storage, construction, and services where required.
- [x] Implement hierarchical pathfinding: local paths inside chunks and higher-level routes across chunks.
- [x] Add path invalidation when buildings, terrain, or threats change accessibility.
- [x] Spread expensive path searches across ticks with explicit per-tick budgets.
- [x] Implement construction workers and material delivery if not completed in the production phase.
- [x] Add service buildings and settlement-level statistics.
- [x] Add alerts for homelessness, unemployment, shortages, inaccessible destinations, and stalled construction.
- [x] Add deterministic scheduling and fairness so low-ID entities do not permanently receive preferential service.
- [x] Add headless long-duration tests for population stability, deadlocks, and pathfinding failures.

Exit criteria:

- A settlement can grow, assign work, satisfy basic needs, construct buildings, and visibly respond to shortages.
- Pathfinding cannot consume an unbounded fraction of a tick.
- Players can understand why a worker, building, or construction project is idle.

## Phase 9: Implement exploration and civilization progression

- [x] Add unexplored, explored, and currently visible states for world chunks or tiles.
- [x] Decide and implement which exploration information is private, settlement-shared, or globally shared.
- [x] Ensure hidden entities and resources are never sent to unauthorized clients.
- [x] Add exploration units or mechanics and safe server-authoritative movement commands.
- [x] Add territory acquisition, borders, settlement influence, and construction permissions.
- [x] Resolve border contention without PvP and provide fair, understandable outcomes.
- [x] Add research resources, research production, prerequisites, and a data-driven technology graph.
- [x] Validate the technology graph for missing references and unintended cycles.
- [x] Implement unlocks for buildings, recipes, upgrades, exploration, and defenses.
- [x] Add era or progression milestones if included in the game design.
- [x] Add a technology interface, progression overview, and clear explanations of locked content.
- [x] Add a strategic world-map view that requests aggregated data rather than every entity.
- [x] Persist exploration, territory, and research state and migrate it safely when content changes.
- [x] Add tests for fog-of-war information leaks and technology prerequisites.

Exit criteria:

- Players can explore the global world, claim valid territory, research technologies, and unlock a meaningful next tier.
- Clients receive no hidden-world information through snapshots, deltas, logs, or error messages.

## Phase 10: Build the cooperative PvE game

- [x] Define a threat model connecting player expansion or world time to environmental pressure.
- [x] Implement server-controlled enemy or hazard spawning with safe-distance and population rules.
- [x] Implement PvE perception, target selection, navigation, attacks, damage, armor or resistance, and death.
- [x] Implement defensive buildings, repair, replacement, and warning systems.
- [x] Add environmental events that affect production or settlement decisions rather than only dealing damage.
- [x] Add cooperative objectives or global events that allow multiple settlements to contribute.
- [x] Make rewards deterministic, auditable, and safe against duplicate claims.
- [x] Explicitly reject player-issued attacks against other players, allied units, or protected settlements.
- [x] Add anti-griefing rules for blocking paths, surrounding settlements, consuming spawn resources, and dragging enemies onto others.
- [x] Define threat behavior for offline players so leaving the game is neither an exploit nor guaranteed destruction.
- [x] Add difficulty telemetry and content configuration without embedding balance constants throughout code.
- [x] Add AI behavior tests, combat conservation tests, pathfinding stress tests, and long-running threat simulations.

Exit criteria:

- PvE creates escalating, understandable pressure and meaningful reasons to cooperate.
- There is no supported player-versus-player damage path.
- Offline, new, and defeated players have documented and tested protection or recovery rules.

## Phase 11: Add cooperation, trade, and global-world governance

- [x] Implement settlement membership and roles with least-privilege defaults.
- [x] Define permissions for building, configuring production, withdrawing resources, inviting players, and contributing to projects.
- [x] Implement direct resource transfers or trade offers as atomic server transactions.
- [x] Prevent duplication through retries, disconnects, concurrent acceptance, and inventory-capacity changes.
- [x] Add shared construction projects and contribution history if included in the first release.
- [x] Add player and settlement discovery without exposing private or hidden information.
- [x] Add chat or another minimal cooperation channel with rate limits, blocking, reporting, and moderation controls.
- [x] Implement names with normalization, uniqueness rules, length limits, and content-moderation support.
- [x] Implement ownership transfer, settlement departure, account deletion, and inactive-player policies.
- [x] Add administrative tools for inspecting players, settlements, transactions, and world state without direct database editing.
- [x] Audit all administrative mutations with actor, reason, before/after state, and tick.
- [x] Add conflict and concurrency tests for trades, permissions, membership, and ownership changes.

Exit criteria:

- Players can cooperate and exchange resources without trusting client calculations.
- Permission and trade operations remain correct under retries and concurrent requests.
- Moderators can investigate and correct serious issues through audited tools.

## Phase 12: Complete UX, onboarding, and accessibility

- [x] Build an onboarding flow that teaches camera movement, gathering, construction, production, logistics, settlement needs, research, and threats in the global world.
- [x] Ensure onboarding cannot reserve unlimited land or resources through abandoned accounts.
- [x] Build searchable construction, recipe, inventory, population, research, defense, and alert interfaces.
- [x] Group the interface so play actions come before settings: a persistent header with connection, resources, and the next step, plus keyboard-navigable Build, Settlement, World, Co-op, and Settings tabs.
- [x] Provide actionable explanations for rejected commands and stalled systems, including why a specific building cannot be placed on the selected tile.
- [x] Add notification grouping and severity so large settlements do not overwhelm players.
- [x] Add keyboard navigation and remappable controls for primary actions.
- [x] Avoid relying on color alone and provide readable contrast and scalable UI text.
- [x] Add reduced-motion and volume controls where relevant.
- [x] Provide loading, reconnecting, maintenance, version-mismatch, and unrecoverable-error screens.
- [x] Persist client preferences locally without treating them as authoritative game data.
- [ ] Test supported viewport sizes, zoom levels, input methods, and browsers.
- [ ] Conduct playtests with new players and revise interfaces based on observed confusion rather than only stated preferences.

Exit criteria:

- A new player can reach the first working production chain without developer assistance.
- Important game states and failures are discoverable and understandable.
- The supported accessibility and browser targets from Phase 0 are verified.

## Phase 13: Meet performance and scale budgets

- [x] Add server metrics for tick duration by subsystem, command latency, connected players, entity count, active chunks, path queue, snapshot time, journal lag, memory, and outgoing queue size.
- [x] Add client metrics for frame time, render-object count, active chunks, asset memory, message rate, and update-application time.
- [x] Build headless bot clients that gather, build, expand, research, trade, reconnect, and react to threats.
- [x] Build reproducible load scenarios at the target player and entity counts.
- [x] Test hot spots where many players observe or modify the same chunks.
- [x] Profile before optimizing and record benchmark inputs with every performance claim.
- [x] Optimize interest management, delta construction, spatial indexes, dirty tracking, and serialization based on profiles.
- [x] Add level-of-detail simulation for inactive regions only if the game design permits equivalent outcomes.
- [x] Batch or budget pathfinding, AI planning, world generation, persistence, and large administrative operations.
- [x] Consider Node.js worker threads only for measured CPU-heavy tasks with clear ownership and bounded message costs.
- [x] Move high-volume protocol messages from JSON to a versioned binary format only if bandwidth or parsing exceeds its budget. The measured target workload remains on JSON at 720 bytes/s/player and 11.0 ms/full server tick, so no binary migration is warranted.
- [x] Establish hard safety limits for message size, subscriptions, queued paths, construction commands, and outbound buffers.
- [x] Build a continuous world-soak harness that gates on memory growth, event-loop stalls, tick overruns, dropped ticks, and state-hash failures, and record a target-load reference run. It found and forced a fix for an unbounded duplicate-command ledger that also made command validation linear in world age.
- [ ] Run the multi-hour release soak with `world_soak_minutes` raised and attach its report to the release checklist.
- [x] Document the measured threshold at which one Node.js process no longer meets the world target. Do not introduce sharding prematurely; any future partition must preserve one logical world.

Exit criteria:

- Client, server, network, and persistence budgets from Phase 0 pass under the target load.
- A soak test completes without unbounded memory growth, unrecoverable tick drift, or simulation corruption.
- Degradation and safety limits fail visibly and safely rather than crashing the global world.

## Phase 14: Secure the public service

- [x] Produce a threat model covering command forgery, hidden-state extraction, resource duplication, account takeover, spam, griefing, denial of service, dependency compromise, and administrator misuse.
- [x] Replace development identity with production authentication and secure session management.
- [x] Use secure, HTTP-only, same-site cookies or an equivalently reviewed token design.
- [x] Require TLS in production and validate WebSocket origins.
- [x] Validate every untrusted HTTP, WebSocket, content, administrative, and database boundary.
- [x] Enforce server-side authorization for every command and query.
- [x] Add per-connection and per-account rate limits without introducing a separate cache service.
- [x] Add request and message size limits before parsing large payloads.
- [x] Prevent clients from selecting arbitrary player IDs, ticks, entity ownership, costs, rewards, or outcomes.
- [x] Keep secrets out of the repository and logs. Define rotation procedures.
- [ ] Use separate least-privilege database roles for migrations, runtime access, and backups.
- [x] Add dependency scanning, lockfile review, and a documented update cadence.
- [x] Sanitize user-generated text and configure browser security headers.
- [x] Avoid logging session secrets, private messages, or hidden-world payloads.
- [ ] Conduct abuse tests and a focused security review before public registration.

Exit criteria:

- The threat model has mitigations and owners for all high-risk paths.
- Authentication, authorization, protocol fuzzing, rate limits, and duplication attempts have automated tests.
- Runtime and backup credentials have only the permissions they require.

## Phase 15: Add operations and safe deployment

- [x] Define development, test, staging, and production configuration. Production still contains exactly one player-facing global world; non-production worlds are disposable test environments.
- [x] Choose a hosting approach for the static browser assets, Node.js process, and PostgreSQL without requiring Docker.
- [x] Add liveness and readiness endpoints that distinguish process health from world readiness.
- [x] Add structured logs with correlation IDs for connections, commands, players, checkpoints, and failures.
- [x] Create dashboards and alerts for tick overruns, crashes, database failures, failed checkpoints, journal lag, connection spikes, memory pressure, and backup failure.
- [x] Add graceful restart and maintenance mode with clear browser messaging.
- [x] Make deployments reject incompatible database, snapshot, content, or protocol versions before accepting players.
- [x] Define forward-only database migrations and versioned snapshot migrations.
- [ ] Test application rollback separately from data rollback; do not assume a database schema can be safely downgraded.
- [x] Automate production backups with retention and off-host storage.
- [x] Schedule recurring restore drills and record their duration and verification results.
- [x] Write runbooks for failed deployment, corrupted latest checkpoint, database outage, runaway tick time, malicious client flood, lost credentials, and world rollback.
- [x] Add a world-consistency inspection command that can run read-only against a checkpoint.
- [x] Define maintenance windows and player communication procedures.

Exit criteria:

- The service can be deployed, observed, placed into maintenance, restarted, and restored using documented procedures.
- Operators can detect a stuck or unhealthy world before players are the monitoring system.
- A failed deployment can be contained without improvising direct database changes.

## Phase 16: Test and release the global world

- [x] Maintain unit tests for pure rules, invariants, coordinates, recipes, permissions, AI decisions, and serialization.
- [x] Maintain property-based tests for conservation, bounds, idempotency, and concurrency-sensitive systems.
- [x] Maintain integration tests for WebSockets, PostgreSQL, checkpoints, journal replay, reconnect, migrations, and authentication.
- [x] Add browser end-to-end tests for onboarding and the critical gather-build-produce-research-defend loop.
- [x] Maintain deterministic replay scenarios and compare final state hashes in CI.
- [ ] Run compatibility tests in every supported browser.
- [ ] Run load, soak, crash, restart, backup, restore, and interrupted-deployment tests against release candidates.
- [ ] Run a private internal world and fix all world-corrupting, duplication, authorization, and recovery defects before inviting external players.
- [ ] Run a closed alpha focused on comprehension, simulation correctness, persistence, and cooperative behavior.
- [x] Decide and communicate whether the alpha world will reset.
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
