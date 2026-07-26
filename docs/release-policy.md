# World reset and release policy

The private internal world and closed-alpha world are disposable validation environments. The closed
alpha **will reset** after its announced end date. Its purpose is to find comprehension, persistence,
authorization, duplication, and recovery defects; progression in it is not permanent.

The beta world also resets before public launch unless a later announcement explicitly promotes a
release candidate. That decision must be made before beta registration opens and repeated in the
client, status page, and invitation message. No test-world data is silently promoted.

The public world becomes permanent only after save schema, content IDs, and protocol compatibility
are frozen; the final restore drill, browser matrix, target-load soak, and release checklist all pass;
and the launch notice states that the reset policy has changed. After that point, a reset is an
incident-recovery action requiring a public incident report, not a balancing tool.

## Player-facing operations

- Support requests receive a tracking ID and are triaged as access, gameplay, moderation, privacy,
  billing (currently not applicable), or incident reports. World-state corrections use only the
  audited administrative commands and require an operator, reason, before/after evidence, and tick.
- Moderation reports are visible only to authorized operators. Actions preserve the bounded audit
  record, avoid exposing reporter identity, and provide an appeal path.
- Account deletion uses the in-game authoritative command. Requests that cannot authenticate are
  verified through the approved account-recovery procedure; operators never edit player rows or
  disclose session tokens.
- Security and privacy incidents follow the operations runbook, preserve relevant bounded logs, and
  use the public status channel for impact and resolution notices.

Before external registration, deployment owners must publish the actual support, moderation appeal,
security contact, privacy contact, status page, terms, and privacy notice URLs. Legal review of terms,
retention, deletion, and jurisdiction remains a release gate.
