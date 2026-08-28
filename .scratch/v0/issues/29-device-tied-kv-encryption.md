Status: resolved
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

Resolved (2026-08-28). At-rest encryption of the persisted worker-record secret
fields with a device-tied key.

- **Crypto**: AES-256-GCM via `node:crypto`, random 12-byte nonce per
  encryption, versioned self-describing envelope `{ v:1, alg:"AES-256-GCM",
  nonce, ct, tag }` so the primitive can rotate. 128-bit GCM tag → wrong-key /
  tamper fails loudly on open. `plugin/lib/device-key/envelope.ts`.
- **Key storage**: `KeyProvider` interface with a platform-aware factory
  (`plugin/lib/device-key/key-provider.ts`). Primary = macOS Keychain via the
  `security` CLI (`find-generic-password -w` / `add-generic-password -U`), 32
  random bytes generated on first use under service `bb-shared-device-key`,
  stored base64, never in the repo or kv. Fallback (non-darwin) = a `0600` file
  under `<dataDir>/plugins/<id>/`, documented weaker (key sits beside
  ciphertext). `InMemoryKeyProvider` for tests.
- **Integration**: encrypt-on-save / decrypt-on-load inside
  `createWorkerRecordStore` (`plugin/worker-lifecycle/worker-record.ts`), so
  call sites are unchanged. Secret fields (`apiToken`, `tunnelSecret`,
  `claim.url`) are per-field envelopes; non-secret metadata stays plaintext and
  readable. A record that fails to decrypt (missing key / other machine /
  tamper) is wiped and treated as absent — same degrade-to-fresh-bootstrap path
  as a malformed blob, never a crash. `server.ts` wires the real device key
  provider (dataDir passed as a thunk so the bind-gated `experimental_dataDir`
  is only read on the non-macOS fallback path).
- **Migration**: a pre-issue-29 plaintext record is read once, re-saved
  encrypted, and the plaintext falls out of the kv.
- **Tests**: 33 new unit tests — envelope round-trip / wrong-key / tamper (ct +
  tag) / version-gate / key-size; record-crypto field selection + migration
  flag; key-provider (in-memory, file 0600, faked-CLI keychain, factory
  platform routing) + one opt-in real-Keychain integration test
  (`BB_SHARED_KEYCHAIN_IT=1`, skipped when `security` absent); and store
  integration with an injected in-memory KeyProvider (round-trip, no-plaintext,
  wrong-key wipe, migration, null claim). Plugin suite 115 passing / 1 skipped;
  tsc clean.

Pairs with SPEC §"Trust model" (new "At-rest encryption" note). Prerequisite for
issue 28 persisting a long-lived `cfRefreshToken`.
