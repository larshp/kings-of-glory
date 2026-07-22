# Administrative governance runbook

The administrative CLI reads and corrects the authoritative PostgreSQL world without hand-editing JSON or database rows. Every accepted correction creates a completed checkpoint and an immutable audit event in the same database transaction. The event records the operator, normalized reason, operation, target, affected before/after state, and world tick.

## Prerequisites

1. Build the workspace with `npm run build`.
2. Set `DATABASE_URL` to the persistent world database.
3. Use an operations identity with only the database permissions required by this tool. Never use browser-supplied player identity as `ADMIN_ACTOR`.
4. Take and verify a backup before any correction.
5. Stop the game server before a mutation. The CLI requires `ADMIN_CONFIRM_OFFLINE=YES` but cannot determine whether another deployment is still writing the world.

Inspection is read-only and reconstructs the latest completed checkpoint plus its replayable command journal:

```powershell
npm --prefix apps/server run admin -- inspect world
npm --prefix apps/server run admin -- inspect player player-a
npm --prefix apps/server run admin -- inspect settlement settlement-player-a
npm --prefix apps/server run admin -- inspect transactions
npm --prefix apps/server run admin -- inspect moderation
npm --prefix apps/server run admin -- inspect audits 100
```

World inspection includes the schema version, tick, state hash, entity counts, and invariant errors. Player and settlement inspection includes private operational state and must be handled as sensitive data. Transaction inspection includes transfers and cooperative contribution ledgers. Moderation inspection includes retained messages and report evidence. Audit inspection returns newest events first and accepts a limit from 1 through 500.

## Corrective mutations

Set a stable operator identity and a specific incident or ticket reason of 10–500 characters:

```powershell
$env:ADMIN_ACTOR = 'operator@example.test'
$env:ADMIN_REASON = 'INC-1234: correcting the verified failed transaction.'
$env:ADMIN_CONFIRM_OFFLINE = 'YES'
```

Supported corrections are intentionally narrow:

```powershell
npm --prefix apps/server run admin -- mutate set-player-inventory player-a ingot 4
npm --prefix apps/server run admin -- mutate set-settlement-owner settlement-player-a player-b
npm --prefix apps/server run admin -- mutate remove-chat-message message-id
npm --prefix apps/server run admin -- mutate resolve-chat-report report-id
```

Inventory corrections must be non-negative integers and cannot exceed player inventory capacity. A replacement settlement owner must be an active current member. Removing a retained message does not erase the immutable snapshot held by an existing report. Resolving a report changes its status but retains its evidence.

The tool validates the complete resulting world before persistence. If validation, checkpoint storage, or audit storage fails, the active mutation is rejected. PostgreSQL writes the checkpoint and audit row in one transaction and rolls both back on failure.

## Verification and recovery

After a mutation:

1. Run `inspect world` and require an empty `invariantErrors` array.
2. Run `inspect audits 10` and verify the actor, reason, operation, target, before/after state, and tick.
3. Inspect the affected player, settlement, transactions, or moderation state.
4. Restart the game server and confirm `/ready` succeeds after recovery.

If any result is unexpected, keep the server stopped. Preserve the audit output and restore the pre-mutation backup according to the backup and checkpoint recovery runbooks; do not attempt a compensating direct database edit.
