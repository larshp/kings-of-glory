# Session-secret rotation

Production session secrets belong in the deployment secret store, never in source control, command
arguments, logs, or backup artifacts. Generate at least 32 random bytes for each key. The public Node
service must only be reachable through a trusted TLS proxy that overwrites `X-Forwarded-Proto` and sets
it to `https`; configure `TRUST_PROXY=true` only in that topology.

## Routine rotation

1. Generate a new secret in the secret store without printing it in CI output.
2. Deploy the current `SESSION_SECRET` as `SESSION_SECRET_PREVIOUS` and the new value as
   `SESSION_SECRET` in one configuration change.
3. Verify `/ready`, create a new session, reconnect an existing session, and confirm that the existing
   session receives a refreshed cookie signed by the new key.
4. Keep the previous key for the 30-day maximum session lifetime. Then remove
   `SESSION_SECRET_PREVIOUS` and redeploy.

Only the current key signs cookies. The previous key is verification-only, so active browsers migrate
on their next `POST /session`. Never configure more than one previous key.

## Suspected compromise

Remove both exposed keys, deploy one new secret immediately, and expect all sessions to be invalidated.
Announce the forced reauthentication before reopening traffic. Inspect connection spikes, account-rate
limit closes, command journals, and administrative audit records from the exposure window. This
anonymous first-release session design has no account-recovery identity: losing or forcibly invalidating
the only cookie loses access to that player. Public registration must explicitly accept this product
constraint or add a reviewed external identity and recovery flow first.
