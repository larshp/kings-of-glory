# Checkpoint recovery runbook

1. Put the service into maintenance and stop accepting WebSocket commands.
2. Preserve logs and the database before making changes.
3. Identify the newest checkpoint with `completed = true`; never restore an incomplete checkpoint. Runtime retention keeps the newest three completed checkpoints and journal history from the oldest retained checkpoint forward.
4. Export its serialized state to a JSON file and run:

   ```powershell
   npm run build
   npm --prefix apps/server run inspect -- path/to/checkpoint.json
   ```

   The inspector rejects incomplete checkpoints, structural corruption, and a mismatched tick or
   state hash when those fields are included in the export.

5. If inspection succeeds, start the server with the intended `DATABASE_URL`. Startup loads the completed checkpoint then replays journaled commands.
6. Verify `/ready`, `/metrics`, player inventory samples, and the restored state hash before ending maintenance.
7. If inspection or replay fails, restore the previous completed checkpoint or the most recent tested database backup. Do not edit serialized game state directly.

## Evidence to retain

Record checkpoint ID, tick, state hash, journal range, restore duration, database backup identifier, operator, and the reason for recovery.

## Recovery objectives

- **RPO:** zero accepted commands. The server journals an accepted command before it mutates the
  active world. The checkpoint cadence is 300 ticks (about 30 seconds at the 100 ms tick target),
  which bounds the usual replay window rather than permitted data loss.
- **RTO:** five minutes from process start to a verified ready world for the current first-slice
  target. Watch `kings_recovery_duration_ms`, `kings_journal_lag_ticks`, checkpoint failures, and
  the `/ready` result. A release candidate must demonstrate this target in a restore drill before
  public persistence is enabled.
