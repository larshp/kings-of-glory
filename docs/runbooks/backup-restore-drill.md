# PostgreSQL backup and restore drill

Use PostgreSQL client tools from the same major version as production. A restore drill is destructive
to its target database and must never target the live database. The command refuses an identical
source/target identity and requires the target database name to be confirmed explicitly.

## Automated backup

Set an absolute backup directory on off-host or replicated storage. The command requires a completed
world checkpoint, creates a custom-format `pg_dump`, computes its SHA-256 digest, and writes a JSON
manifest containing the source identity and checkpoint ID, tick, and state hash. Credentials are not
written to the manifest.

```powershell
$env:DATABASE_URL = 'postgres://kings_backup:secret@db.example/kings_of_glory'
$env:BACKUP_DIR = 'D:\kings-backups'
npm run build
npm --prefix apps/server run backup
```

Set `PG_DUMP` only when `pg_dump` is not on `PATH`. Schedule this command at least daily and more
frequently than the accepted recovery-point objective requires. Retain daily backups for 14 days,
weekly backups for 8 weeks, and monthly backups for 12 months on encrypted off-host storage. Alert on
a missing manifest, non-zero exit, zero-byte dump, or backup age beyond the schedule. Test retention
deletion against a non-production directory before enabling it; this repository deliberately does not
delete operator files.

## Isolated restore drill

Create an empty, disposable PostgreSQL database with no application traffic. The runtime role used by
the drill must be able to restore the schema and write the drill evidence table. The command runs
`pg_restore --clean --if-exists`, applies later forward migrations, deserializes and validates the
newest completed checkpoint, compares its state hash and identity with the backup manifest, inserts an
auditable `backup_restore_drills` row, and writes a `.restore.json` report beside the dump.

```powershell
$env:DATABASE_URL = 'postgres://kings_backup:secret@db.example/kings_of_glory'
$env:RESTORE_DATABASE_URL = 'postgres://kings_restore:secret@db.example/kings_restore_drill'
$env:RESTORE_CONFIRM_DATABASE = 'kings_restore_drill'
$env:RESTORE_OPERATOR = 'operator@example.com'
$env:BACKUP_FILE = 'D:\kings-backups\kings-of-glory-2026-07-22T08-00-00-000Z.dump'
npm --prefix apps/server run restore:drill
```

Set `PG_RESTORE` only when `pg_restore` is not on `PATH`. A successful command is necessary but not
sufficient for the release drill: start a server against the restored database, verify `/health`,
`/ready`, `/metrics`, a WebSocket handshake, representative player inventories, and the reported
checkpoint hash. Record elapsed recovery time and confirm it satisfies the five-minute RTO.

## Evidence and failure handling

Retain the dump manifest, restore report, `backup_restore_drills` row, application smoke-test output,
operator, tool versions, and measured RPO/RTO. If checksum, migration, invariant, checkpoint identity,
or state-hash verification fails, preserve the target and logs, do not open it to traffic, and follow
the checkpoint recovery runbook. Perform this drill before every public persistent test and at least
quarterly afterward.
