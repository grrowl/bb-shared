Status:
Type: task
Blocked by: 20

Address the LOW findings + document accepted residuals from the
tunnel-secret adversarial review. Full findings in
[research/tunnel-secret-review.md](../../../research/tunnel-secret-review.md).

## L1 — `timingSafeEqual` doc/code contradiction

Comment claims XOR-on-length-mismatch; actual code early-returns. Not
exploitable (fixed-length secret; no per-char oracle) but fix the
comment.

## L2 — `healthCheck` accepts any HTTP response as alive

Currently a non-throw counts as alive. Sharpen to require 2xx. A
malicious / broken proxy returning 502 shouldn't be treated as "worker
OK".

**Fix:** `healthCheck` returns true iff `response.status >= 200 && <
300`. Add a test.

## L3 — No TLS pinning beyond `*.workers.dev`

Documented residual. No fix in v0. Document the acceptance criterion
explicitly in SPEC + `tunnel-secret.ts` header:

> Attacker with control of CF's `*.workers.dev` subdomain assignment
> (i.e. CF account control) could MITM. This is considered inside the
> CF-trust boundary. v1 could add pinning by capturing the initial TLS
> certificate fingerprint on first handshake and rejecting drift.

## L4 — Stale prior-gen worker holds old secret ≤60 min post-redeploy

Documented residual. Note the acceptance: prior-gen worker has no live
tunnel to bb (secret rotated bb-side), so the residual reduces to
"guest URLs against the old worker return 5xx until CF cleans it up."

## M5 — KV plaintext (accepted, documented)

**Sharpened from the review**: `apiToken` is the worst-case item — an
attacker with `apiToken` can redeploy a malicious worker under our
name, making tunnel-secret rotation moot.

v0 assumes local-trust boundary. Document explicitly in SPEC (add a
"Trust model" subsection) and in `plugin/worker-lifecycle/tunnel-secret.ts`
header.

v1 candidate: encrypt KV values with a device-tied key (macOS Keychain,
etc.). Note in fog for later.

## Verify

- Doc / comment fixes reviewable in diff.
- `healthCheck` test covers 5xx = unhealthy.

## Comments

## Answer
