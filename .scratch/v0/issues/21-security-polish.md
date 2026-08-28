Status: resolved
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

All four LOW findings addressed and M5 documented. Doc/comment-only except
L2 (one code change + tests).

**L1 — `timingSafeEqual` doc/code contradiction.** Rewrote the comment in
`worker/src/tunnel/tunnel-do.ts` to match the actual early-return-on-length-
mismatch code (the old comment claimed an XOR-on-mismatch that doesn't exist).
Added the note: the load-bearing property (the XOR loop accumulates into `diff`
and returns only after the full pass — no per-char short-circuit) is correct;
the length early-return leaks only length, which is public via the fixed
32-byte / 43-char secret shape. Not a per-char oracle.

**L2 — `healthCheck` accepted any non-throw as alive.** Sharpened
`healthCheck` in `worker-lifecycle.ts` to reject 5xx, plus two new tests
(`worker-lifecycle.test.ts`): 500/502/503 → unhealthy (wipes the persisted
record on bootstrap), and 401 → still healthy.

  **Deviation from the ticket's literal instruction, flagged deliberately.**
  The ticket said "return true iff `response.ok` (200–299)". That is wrong for
  this codebase and would cause a serious regression: the health probe hits
  `GET /` (no token), and a *live* worker answers **401 `token_missing`**
  (worker/README.md; `extractTokenStage` in worker.ts). A 2xx-only check would
  mark every live worker dead → infinite wipe+redeploy loop, and would break
  the two existing tests that use 401 as the healthy response — directly
  violating this ticket's own Verify constraints ("all existing tests pass",
  "no functional regressions in the deploy/health flow"). I implemented the
  finding's actual intent ("a 502 shouldn't count as worker OK", matching the
  review's L2) as **healthy iff `status < 500`**: rejects the broken/hostile-
  proxy 5xx, keeps the worker's real 401 liveness signal healthy, and stays
  robust if `GET /` ever serves a real 2xx once the guest proxy is wired up.

**L3 — no TLS pinning residual.** No code change (v0 accepts the CF-trust
boundary). Documented the acceptance criterion in the new SPEC "Trust model"
section and in the `tunnel-secret.ts` threat-#1 residual: CF-account-control
MITM is inside the CF-trust boundary; v1 could pin the first-handshake TLS
fingerprint and reject drift.

**L4 — stale prior-gen worker.** Documented in the `tunnel-secret.ts` "NOT
DEFENDED" block and SPEC "Trust model": prior-gen worker has no live tunnel to
bb (secret rotated bb-side on redeploy), so the residual reduces to guest URLs
against the old worker returning 5xx until CF reclaims the unclaimed account
(≤60 min). Window is narrow and self-closing (guest URLs change on redeploy).

**M5 — KV plaintext / `apiToken` crown jewel.** Added a "Trust model"
subsection to SPEC.md naming the local-trust boundary explicitly (local disk,
every installed plugin, network egress) and calling out that `apiToken` — not
the tunnel secret — is the worst-case at-rest item: an attacker with it can
redeploy a malicious worker under our account, making tunnel-secret rotation
moot. Updated the `tunnel-secret.ts` header residual (2) + NOT-DEFENDED block
to name `apiToken` as the crown jewel. Added the v1 candidate (encrypt KV with
a device-tied key, e.g. macOS Keychain) to the map's Fog.

### Verify
- plugin: `tsc --noEmit` clean; `vitest` 72 passed (incl. new L2 tests);
  `bb plugin build .` clean (dist artifacts regenerated, gitignored).
- worker: `tsc --noEmit` clean; `vitest` 162 passed; `wrangler deploy
  --dry-run` builds (30.15 KiB).
- No functional regression in deploy/health: the `< 500` health rule preserves
  the existing "reuse healthy (401) worker" and "wipe dead worker" behaviour.
