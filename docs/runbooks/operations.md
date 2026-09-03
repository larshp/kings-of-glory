# Operational runbooks

These runbooks apply to the single authoritative world host. They describe the current first-slice
behavior. Production authentication is implemented, but public operation still requires the
least-privilege credentials, monitored off-host backups, restore drill, and release gates in the
[deployment architecture](../deployment.md).

## Failed deployment or incompatible release

1. Do not direct traffic to a new process until `/health`, `/ready`, and a WebSocket `hello` smoke
   test succeed.
2. If the process cannot restore its checkpoint or rejects its content/schema version, stop it and
   leave the previous compatible deployment running. Do not edit checkpoint JSON or database rows.
3. If the deployment must be stopped, send the process `SIGINT` or `SIGTERM`. It stops accepting
   commands, closes clients with code `1012` (`Server maintenance`), writes one final checkpoint,
   and closes persistence.
4. Inspect the newest completed checkpoint with the read-only checkpoint inspector before retrying
   a deployment. Follow [checkpoint recovery](checkpoint-recovery.md) if restore is required.

## Database outage or failed checkpoint

1. Watch `kings_command_persistence_failures_total`, `kings_checkpoint_failures_total`,
   `kings_journal_lag_ticks`, and structured `world.command_failed` / `world.tick_failed` logs.
2. A command whose journal write fails is rejected with `persistence-failed` and must not mutate the
   active world. Tell players to retry only after storage is healthy.
3. If checkpoints continue failing, enter maintenance with graceful shutdown instead of forcing a
   process termination. Preserve database logs and the newest completed checkpoint.
4. Restore only a checkpoint that passes the inspector; retain the checkpoint ID, hash, journal
   range, and measured recovery time.

## Runaway tick time or memory pressure

1. Inspect `kings_tick_duration_ms`, `kings_tick_failures_total`,
   `kings_process_heap_used_bytes`, `kings_process_resident_memory_bytes`, and the active entity /
   chunk counts.
2. Check `kings_commands_pending` and `kings_outbound_buffered_bytes` to distinguish simulation
   pressure from slow-client pressure.
3. Put the world into maintenance if ticks repeatedly exceed the 100 ms target or memory grows
   without stabilizing. Capture `/metrics`, state hash, checkpoint tick, and recent logs first.
4. Reproduce with `npm --prefix apps/server run load` or `npm --prefix apps/server run soak`; compare
   deterministic hashes and memory shape with the recorded baseline before deploying a mitigation.

## Malicious or overloaded client

1. The boundary rejects messages larger than 64 KiB, limits a socket to 30 messages per second, and
   closes sockets that exceed 1 MB buffered output. Record the close code, reason, and affected
   player ID from structured logs.
2. In production, verify the connection origin is on the configured `ALLOWED_ORIGINS` allowlist.
3. Do not attempt database edits to remove a client. A disconnected connection is removed from the
   in-memory connection map automatically; game state remains authoritative and recoverable.
4. If the flood is broad enough to affect tick time, use the runaway-tick procedure and preserve logs
   for a later abuse review.

## World rollback

1. Announce maintenance and stop the service gracefully.
2. Preserve the database and logs, then select a known-good completed checkpoint.
3. Run the checkpoint inspector, restore the selected checkpoint, and replay only the intended
   journal range.
4. Verify `/ready`, `/metrics`, player inventory samples, and the final state hash before reopening.
5. Record the reason, operator, checkpoint ID, hash, affected tick range, and player communication.

## Credentials and public-service boundary

Production identity is derived only from signed, HTTP-only sessions; a browser cannot select its
player ID. Rotate signing secrets using the [session-secret runbook](session-secret-rotation.md).
Account recovery is an operator-owned support action and must use an audited administrative flow;
never disclose or manually copy a session token. Do not expose the build publicly until separate
runtime, migration, and backup roles plus a successful restore drill have been verified.
