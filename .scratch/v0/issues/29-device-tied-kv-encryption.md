Status: open
Type: task
Severity: high (prerequisite for the OAuth path in issue 28)
Blocked by:
Found by: claim-confirmation OAuth design (2026-08-28)

Encrypt the plugin's at-rest secrets in bb.storage.kv with a device-tied key.

## Why now

This was a v1 candidate in the map. The OAuth design in issue 28 promotes it to
a prerequisite. To confirm claims, read the live worker hostname, and
redeploy/undeploy a claimed worker, the plugin persists a `cfRefreshToken`,
which is a long-lived credential to the owner's REAL Cloudflare account. That is
a more sensitive at-rest secret than the temporary account apiToken the new
persistence model removed. Storing it as plaintext in bb.storage.kv is not
acceptable for shipping the OAuth path.

## Scope

- Encrypt the persisted secret fields (`cfRefreshToken`, `tunnelSecret`) with a
  key tied to this device, for example the macOS Keychain or the equivalent
  secure store per platform, so a copied bb data directory does not yield the
  secrets.
- Keep the non-secret metadata (url/hostname is re-resolved live anyway,
  scriptName, accountId, generation) readable as today.
- Decide the failure mode when the device key is unavailable (for example a
  restore on a new machine): treat the record as absent and re-run the OAuth
  connect, rather than crashing.

## Notes

- Pairs with the trust-model section in SPEC.md, which currently documents the
  local plaintext posture as an accepted v0 residual. This ticket changes that
  for the OAuth secret.
- Not required for the tunnelSecret-only model (issue 28 pre-OAuth), but the
  owner chose OAuth as the source of truth, so it is required for that path.

## Comments

## Answer
