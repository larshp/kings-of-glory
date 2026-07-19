# Checkpoint recovery runbook

1. Put the service into maintenance and stop accepting WebSocket commands.
2. Preserve logs and the database before making changes.
3. Identify the newest checkpoint with `completed = true`; never restore an incomplete checkpoint. Runtime retention keeps the newest three completed checkpoints and journal history from the oldest retained checkpoint forward.
4. Export its serialized state to a JSON file and run:

   ```powershell
   pnpm --filter @kings/server inspect path/to/checkpoint.json
   ```

5. If inspection succeeds, start the server with the intended `DATABASE_URL`. Startup loads the completed checkpoint then replays journaled commands.
6. Verify `/ready`, `/metrics`, player inventory samples, and the restored state hash before ending maintenance.
7. If inspection or replay fails, restore the previous completed checkpoint or the most recent tested database backup. Do not edit serialized game state directly.

## Evidence to retain

Record checkpoint ID, tick, state hash, journal range, restore duration, database backup identifier, operator, and the reason for recovery.
