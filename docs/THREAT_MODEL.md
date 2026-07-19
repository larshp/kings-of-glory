# Threat model

## Protected boundaries

| Risk                            | Current control                                                                                                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forged game outcomes            | Browsers submit typed commands; the simulation validates ownership, capacity, territory, prerequisites, and costs.                                                                                              |
| Duplicate actions and transfers | Per-player sequences and command IDs are persisted and rejected on retry.                                                                                                                                       |
| Inventory duplication           | Atomic state transitions validate both source and destination before moving resources.                                                                                                                          |
| Hidden-state extraction         | Per-client snapshots omit the world seed and command history; they include terrain and mined tiles only in explored chunks, relevant settlements, explored foreign buildings, and redacted foreign inventories. |
| Oversized or malformed messages | WebSocket payloads are capped at 64 KiB and protocol shape/identifier validation runs before simulation.                                                                                                        |
| Flooding or slow clients        | Connections are limited to 30 messages/second and disconnected above 1 MB buffered outbound data.                                                                                                               |
| Cross-origin WebSockets         | Production requires an explicit `ALLOWED_ORIGINS` allowlist.                                                                                                                                                    |
| Persistent-state corruption     | Commands are journaled before mutation; completed checkpoints have state hashes and are inspected read-only before recovery.                                                                                    |
| PvP damage                      | The protocol has no attack command. Server-controlled threats target non-center buildings only.                                                                                                                 |

## Environmental pressure

Environmental events are validated content definitions, not client-controlled timers. The first event,
acid rain, selects one completed owned building in a stable order every 100 ticks and applies one point
of damage. Damaged producers pause until an authorized player repairs them. This keeps the event
auditable, provides a clear recovery action, and cannot create a PvP damage path.

## Deliberate production boundary

The current development identity is not public authentication. Do not run a public service until production account/session authentication, TLS termination, password or external-identity flows, moderation, secrets management, and a security review are implemented. Production origin enforcement reduces browser-origin abuse; it does not replace authentication.

## Verification cadence

- Run `npm run format:check`, `npm run build`, `npm run test`, and `npm run lint` for every change.
- Run `npm --prefix apps/server run load` when simulation, protocol, or serialization costs change.
- Run the checkpoint inspector before restoring a manually supplied checkpoint.
- Treat any duplicate-resource, authorization, hidden-state, or recovery failure as a release blocker and add a regression test at the lowest practical level.
