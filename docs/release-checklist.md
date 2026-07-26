# Persistent-world release evidence

Copy this file for each release candidate and replace every `PENDING` field with an immutable CI URL,
artifact digest, drill report, or signed operator record. A checkbox without evidence does not pass.
The manual `release candidate` workflow generates the baseline load, soak, lifecycle, PostgreSQL,
backup, and restore artifacts; the final run must increase `soak_rounds` enough to last multiple hours.

## Candidate identity

- Commit and artifact SHA-256: PENDING
- Client, protocol, content, snapshot, and database versions: PENDING
- Configuration review and secret-rotation owner: PENDING

## Automated gates

- Locked install, dependency audit, format, lint, typecheck, unit/invariant tests, build: PENDING
- PostgreSQL migration, checkpoint, journal-replay, authentication, and reconnect integration: PENDING
- Deterministic replay hash and target load: PENDING
- Boundary fuzz/abuse suite and focused security review: PENDING
- Chrome, Firefox, Edge, and Safari at supported viewports/zoom/input: PENDING

## Durability and operations

- Off-host backup manifest and checksum: PENDING
- Isolated restore report, state hash, smoke test, measured RPO/RTO: PENDING
- Interrupted checkpoint/deployment and application rollback exercises: PENDING
- Multi-hour soak report including memory, event-loop, tick, and hash analysis: PENDING
- Dashboards, alerts, on-call route, status page, and maintenance notice: PENDING

## Product and policy

- New-player playtest report and resolved blocking findings: PENDING
- Private-world/alpha/beta defect disposition: PENDING
- Reset policy and permanent-world compatibility freeze announcement: PENDING
- Support, moderation, incident, privacy, terms, and deletion contacts/processes: PENDING

## Approval

- Engineering owner/date: PENDING
- Operations owner/date: PENDING
- Security/privacy/legal owners/date: PENDING
- Launch or no-launch decision and rationale: PENDING
