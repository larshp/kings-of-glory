# Threat model

This model applies to the browser client, public HTTP/WebSocket boundary, authoritative world host,
PostgreSQL persistence, operator tooling, and dependency/build pipeline. The server/runtime owner is
accountable for protocol and persistence controls, the client owner for browser controls, and the
operations owner for identity, infrastructure, secrets, monitoring, and incident response. Any open
high-risk item blocks public registration.

## Protected boundaries

| Risk                            | Current control                                                                                                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forged game outcomes            | Browsers submit typed commands; the simulation validates ownership, capacity, territory, prerequisites, and costs.                                                                                              |
| Duplicate actions and transfers | Per-player sequences and command IDs are persisted and rejected on retry.                                                                                                                                       |
| Inventory duplication           | Atomic state transitions validate both source and destination before moving resources.                                                                                                                          |
| Hidden-state extraction         | Per-client snapshots omit the world seed and command history; they include terrain and mined tiles only in explored chunks, relevant settlements, explored foreign buildings, and redacted foreign inventories. |
| Oversized or malformed messages | WebSocket payloads are capped at 64 KiB and protocol shape/identifier validation runs before simulation.                                                                                                        |
| Flooding or slow clients        | Connections are limited to 30 messages/second, authenticated accounts to 60 messages/second across connections, and clients are disconnected above 1 MB buffered outbound data.                                 |
| Cross-origin WebSockets         | Production requires an explicit `ALLOWED_ORIGINS` allowlist, a trusted TLS proxy, and an HTTPS forwarded scheme.                                                                                                |
| Persistent-state corruption     | Commands are journaled before mutation; completed checkpoints have state hashes and are inspected read-only before recovery.                                                                                    |
| PvP damage                      | The protocol has no attack command. Server-controlled threats target non-center buildings only.                                                                                                                 |

## Boundary validation inventory

| Boundary                | Validation and failure behavior                                                                                                                                                                                                                | Automated evidence                                                                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Public HTTP             | Only the documented methods and paths are accepted; production session creation requires an allowed origin and trusted HTTPS forwarding; responses set restrictive security headers.                                                           | `apps/server/test/websocket.test.ts` exercises methods, cookies, origins, proxy handling, and missing sessions.                                                                |
| WebSocket               | `ws` rejects payloads above 64 KiB before parsing; `parseClientMessage` allowlists every message shape, safe identifier, integer range, page limit, and command payload; authenticated identity replaces client identity.                      | `packages/protocol/test/protocol.test.ts` and `apps/server/test/websocket.test.ts` cover malformed, oversized, stale, duplicate, forged, unauthorized, and rate-limited input. |
| Content and saved state | Content references and graphs are checked at build and server startup. Snapshots require explicit snapshot and content versions, invariants, and hashes; incompatible versions fail before readiness.                                          | Content, simulation serialization, migration, replay, and persistence suites cover invalid references, version mismatches, and corrupt/incomplete checkpoints.                 |
| Administrative CLI      | The CLI allowlists operations and item IDs, bounds numeric input, requires an offline confirmation plus validated actor and reason, applies mutations to a clone, checks world invariants, and commits state with the audit record atomically. | `apps/server/test/admin.test.ts` and `packages/server-runtime/test/admin.test.ts` cover parsing, authorization preconditions, invariants, and durable audits.                  |
| Backup and restore      | Environment values are required, manifests have a strict shape and SHA-256, source and target databases must differ, and destructive restore requires an exact target-database confirmation.                                                   | Backup-tool, restore-manifest, checkpoint-inspection, and PostgreSQL release-candidate exercises cover rejection and verification paths.                                       |
| PostgreSQL              | Dynamic values use query parameters; migrations are fixed reviewed SQL with contiguous versions; unknown newer migrations fail closed. Runtime, migrator, and backup permissions are separate and verified in the release-candidate job.       | Persistence tests cover transactions, journal/checkpoint recovery, and migration history; real-PostgreSQL CI covers checkpoint/journal replay.                                 |

Adding a route, protocol variant, content source, administrative operation, restore input, or dynamic SQL
requires updating this inventory and adding a rejection test before merge.

## Risk register

| Threat                  | Exposure and required mitigation                                                                                                                                                                                   | Owner                    | Status                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Command forgery         | A client can fabricate any JSON message. Parse against the versioned protocol, derive player identity from the authenticated connection, and authorize every command in the simulation.                            | Server/runtime           | Mitigated with signed-session and authorization regression tests.                                           |
| Hidden-state extraction | A modified client can inspect every received byte. Interest filtering must omit unexplored terrain, entities, inventories, logs, and error detail rather than merely hiding them in the UI.                        | Server/runtime           | Mitigated with regression tests.                                                                            |
| Resource duplication    | Retries, concurrent commands, reconnects, and partial persistence can replay mutations. Journal before mutation, enforce command ID/sequence idempotency, and test conservation invariants.                        | Simulation/runtime       | Mitigated with regression tests.                                                                            |
| Account takeover        | Production uses a signed anonymous bearer session with current/previous key rotation, secure cookie attributes, TLS, and no client-selected identity. A recovery identity and individual revocation remain absent. | Operations/server        | Partially mitigated; recovery decision is a release blocker.                                                |
| Spam and abusive text   | Names/chat can create harassment, storage, and rendering abuse. Normalize and limit text, rate-limit writes, provide block/report/moderation flows, and retain an auditable moderation trail.                      | Client/server/operations | Mitigated with bounded text, blocking, reports, and audited review.                                         |
| Griefing                | Valid commands may block routes, exhaust spawn resources, surround settlements, or drag threats. Reserve spawn buffers, constrain claims/building near foreign settlements, and add offline/new-player protection. | Game/simulation          | Mitigated with protected areas, reserved resources, safe spawns, and threat-dragging tests.                 |
| Denial of service       | Connections can flood parsing, subscriptions, paths, command queues, or outbound buffers. Enforce pre-parse byte limits, per-account and per-connection quotas, bounded simulation work, backpressure, and alerts. | Server/operations        | Runtime limits and alert rules exist; production routing remains a deployment gate.                         |
| Dependency compromise   | A malicious package or lockfile can enter CI and production. Use locked installs, signature/provenance checks, dependency scanning, review lockfile changes, and define an update cadence.                         | Build/operations         | Locked CI installs, production audit, review policy, and update cadence are implemented.                    |
| Administrator misuse    | Direct database edits or unaudited tools can corrupt or unfairly change the permanent world. Use least-privilege roles and audited tools recording actor, reason, operation, target, tick, and before/after state. | Operations               | Audited tooling and role verification are automated; production credential evidence remains a release gate. |

Review this register before each public test and after every new trust boundary, user-generated field,
administrative mutation, or authentication change. High-risk residuals require a named owner and may
not be accepted implicitly.

## Environmental pressure

Environmental events are validated content definitions, not client-controlled timers. The first event,
acid rain, selects one completed owned building in a stable order every 100 ticks and applies one point
of damage. Damaged producers pause until an authorized player repairs them. This keeps the event
auditable, provides a clear recovery action, and cannot create a PvP damage path.

## Deliberate production boundary

Development identity fallback is not public authentication. Production requires a signed anonymous session, TLS termination at a trusted proxy, strict cookie attributes, and origin enforcement. This design intentionally has no password, external identity, or account recovery. Do not open public registration until that limitation is explicitly accepted or a reviewed recovery identity is implemented, and until moderation, deployment secrets management, and the focused security review are complete.

## Verification cadence

- Run `npm run format:check`, `npm run build`, `npm run test`, and `npm run lint` for every change.
- Run `npm --prefix apps/server run load` when simulation, protocol, or serialization costs change.
- Run the checkpoint inspector before restoring a manually supplied checkpoint.
- Treat any duplicate-resource, authorization, hidden-state, or recovery failure as a release blocker and add a regression test at the lowest practical level.
