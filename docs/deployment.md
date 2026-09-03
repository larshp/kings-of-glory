# Deployment architecture and environments

Kings of Glory is deployed as three independently replaceable components without Docker:

1. The immutable `apps/client/dist` directory is served from an HTTPS static host/CDN. Unknown
   application routes fall back to `index.html`; assets under `/assets/` use content-hashed,
   immutable caching.
2. One Node.js 22 process runs `apps/server/dist/index.js` behind an HTTPS reverse proxy that
   supports WebSocket upgrades. The proxy overwrites (rather than appends) `X-Forwarded-Proto`,
   forwards `/health`, `/ready`, `/metrics`, `/session`, and the WebSocket endpoint, and drains the
   old process before replacement.
3. PostgreSQL 16 or newer runs as a managed, single-primary service with encrypted storage,
   point-in-time recovery, and a separate off-host backup destination. PostgreSQL is the only
   durable dependency.

The static host, process supervisor, managed database, metrics collector, and secret manager are
provider-neutral requirements. A hosting provider may be selected without changing world topology:
production always has exactly one player-facing world host.

## Configuration matrix

Secrets belong in the deployment secret manager, never an environment file committed to Git.

| Setting              | Development         | Test                     | Staging                 | Production                |
| -------------------- | ------------------- | ------------------------ | ----------------------- | ------------------------- |
| `NODE_ENV`           | `development`       | `test`                   | `production`            | `production`              |
| `PERSISTENCE`        | `memory` by default | isolated PostgreSQL      | PostgreSQL              | PostgreSQL                |
| `DATABASE_URL`       | optional            | disposable runtime role  | staging runtime role    | production runtime role   |
| `ALLOWED_ORIGINS`    | optional            | test client origin       | staging HTTPS origin    | public HTTPS origin       |
| `TRUST_PROXY`        | `false`             | matches test edge        | `true`                  | `true`                    |
| `SESSION_SECRET`     | optional            | ephemeral 32+ characters | secret manager          | secret manager            |
| `PEACEFUL`           | normally `true`     | scenario-specific        | release configuration   | release configuration     |
| `WORLD_SEED`         | disposable          | fixture seed             | disposable staging seed | immutable production seed |
| `LOG_LEVEL`          | `debug`             | `warn`                   | `info`                  | `info`                    |
| `MIGRATE_ON_STARTUP` | `true` (default)    | `true`                   | `false`                 | `false`                   |

Staging is production-shaped but disposable and has no route to production credentials or storage.
Tests use a unique database/schema per run. Never copy session secrets or live account rows into
either environment.

## Database roles

Provision three distinct credentials:

- `kings_migrator` owns the application schema and is used only by the deployment migration job.
- `kings_runtime` may connect and use the schema plus `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on
  application tables and sequences. It cannot create roles, databases, schemas, or tables.
  - `kings_backup` may connect and read the schema and application tables. It runs `pg_dump` and has no
    write privilege; it also receives sequence `SELECT`, which `pg_dump` needs to preserve sequence
    values.

After migrations, revoke schema creation from the runtime and backup roles. Default privileges owned
by the migrator must grant future table/sequence access to the appropriate roles. Verify grants with
`information_schema.role_table_grants` during every deployment; do not let the server's runtime
credential apply migrations in staging or production.

The reviewed grant and verification scripts are
[`ops/postgres/least-privilege.sql`](../ops/postgres/least-privilege.sql) and
[`ops/postgres/verify-least-privilege.sql`](../ops/postgres/verify-least-privilege.sql). Run both with
`psql -v ON_ERROR_STOP=1`; role creation and passwords remain a secret-manager/provisioning concern.

Application rollback is rehearsed separately from data rollback by the manual
`application rollback rehearsal` workflow. It seeds an isolated database with the candidate, starts
the previously deployed ref without running migrations, records whether compatibility permits the
old process to become ready, and then requires the candidate to recover the same database. A refusal
by the older application is an acceptable contained outcome; changing the database back to an older
schema is not.

## Deployment gate

Build once and promote the same artifacts. Before traffic is switched:

1. Run locked install, audit, formatting, lint, build, and tests in CI.
2. Back up the database and retain its manifest.
3. Run `npm --prefix apps/server run migrate` with `kings_migrator`. Production startup rejects
   `MIGRATE_ON_STARTUP=true`; the world host uses only `kings_runtime`.
4. Start the candidate with `kings_runtime` while it is excluded from player traffic.
5. Require `/health` and `/ready`, scrape `/metrics`, and complete a WebSocket protocol handshake.
6. Stop the deployment if the database migration history, snapshot schema, content, or protocol is
   newer than the candidate. The runtime fails closed for each compatibility boundary.
7. Drain the old process, switch traffic once, and retain the previous application artifact.

Application rollback means redeploying the previous artifact only when it accepts the current
database and checkpoint versions. Database schemas are forward-only and are never downgraded. If the
old artifact rejects compatibility, keep the service in maintenance and deploy a forward fix.

## Backup and maintenance schedule

Run the repository backup command at least daily using `kings_backup`, copy both dump and manifest to
encrypted off-host storage, and alert when the newest verified manifest is older than 24 hours.
Retention is 14 daily, 8 weekly, and 12 monthly copies. A separate scheduler runs an isolated restore
drill quarterly and before each public persistent test.

The regular maintenance window is Tuesday 08:00-09:00 UTC. Announce player-impacting work at least 48
hours ahead in the status page and in-game notice, repeat it one hour before the window, and post
start/completion updates. Emergency maintenance uses the same channels as soon as the incident is
confirmed. Every notice states the expected duration, whether simulation is paused, and the restore
or rollback outcome.
