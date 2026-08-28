Status: resolved
Type: task
Blocked by: 07

Fix the HIGH and MEDIUM findings from the tunnel-secret adversarial
review — the ship-blocker set. Full findings in
[research/tunnel-secret-review.md](../../../research/tunnel-secret-review.md).

## H1 — Strip `claim.url` from realtime broadcast + RPC

**Severity: HIGH.** The CF `claim.url` is an account-**takeover** bearer
— whoever holds it can claim the CF account and inherit our workers.
It's currently:

- Broadcast on the `worker-changed` realtime channel via
  `publishStatus` in `plugin/worker-lifecycle/worker-lifecycle.ts`.
- Returned by the `getWorkerStatus` RPC.

Guest isolation of both today hinges on 11's WS frame filter treating
`plugin-signal` frames as drop-by-default (it does). But a takeover
credential should NEVER appear in a guest-reachable payload in the
first place — defense in depth.

**Fix:**

- Remove `claim` from the realtime broadcast payload entirely (owner
  UI reads it via a separate owner-only channel, not via the general
  worker-changed broadcast — or fetches on demand).
- Ensure `getWorkerStatus` is guest-blocked at the worker (see M2).
- Consider a separate `getClaimUrl` RPC that's explicitly owner-only
  and never allowlisted in the worker's path allowlist.

## M2 — Verify `getWorkerStatus` RPC is guest-unreachable

**Severity: MEDIUM.** The worker's mutation gate (10) allowlists
`/api/v1/threads/*` and specific non-thread paths. Plugin RPC paths
like `/api/v1/plugins/bb-shared/rpc/*` were not explicitly named — need
to verify they fall to deny-by-default. Currently unproven.

**Fix:**

- Add an explicit deny for `/api/v1/plugins/bb-shared/rpc/*` in 10's
  allowlist, OR verify the deny-by-default posture catches them.
- Negative test: guest hits `/api/v1/plugins/bb-shared/rpc/getWorkerStatus`
  → 403.

## M3 — Sanitize CF SDK error paths

**Severity: MEDIUM.** `tunnelSecret` / `authzToken` are passed as
`text` in the CF `scripts.update` body (see `cf-deploy.ts`). An SDK
error that echoes the request body flows into `bb.log.error` via the
retry/error path. The "never logged" claim in `tunnel-secret.ts` is
conditional on the SDK not doing that.

**Fix:**

- Wrap the CF SDK call in a try/catch that scrubs sensitive fields
  from error objects before logging. Redact any value matching
  `bbsh_*`, `bbcm_*`, or 32+ char base64url patterns from error
  messages.
- Assert with a test: an SDK error containing the secret is redacted
  in the logged output.

## M4 — Deploy race: `tick()` bypasses `deployInFlight` dedupe

**Severity: MEDIUM.** `tick()` (60s health-check loop) on failure calls
`deploy()` directly rather than routing through `ensureDeployed()`.
Concurrent `mintToken`s during a tick-fail can orphan a live
secret-bearing worker + leak a `SharedTunnel` instance.

**Fix:**

- `tick()` health-fail branch should call `ensureDeployed()` (which
  serializes via `deployInFlight`), not `deploy()` directly.
- Alternative: introduce a shared `deployMutex` both paths acquire.

## Verify

- All plugin tests pass, new tests for each fix.
- New worker test: guest 403 on `/api/v1/plugins/bb-shared/rpc/*`.
- Assertion: no `claim` field in `worker-changed` broadcast payloads.
- Assertion: CF SDK errors never contain raw secrets in logged form.

## Comments

## Answer

All four findings fixed. Ticket 22 (plugin id `bb-shared` → `shared`) landed
first (commit eed3290), so every new URL reference here uses `/plugins/shared/`.

### H1 — `claim.url` off the broadcast + RPC (defense in depth)

The CF `claim.url` is an account-**takeover** bearer, so it no longer rides any
guest-observable channel:

- `WorkerStatus` (the `getWorkerStatus` RPC payload **and** the `worker-changed`
  broadcast projection) dropped its `claim` field entirely
  (`worker-lifecycle.ts`). `getStatus()` no longer copies `record.claim`, so the
  bearer is gone from both surfaces at the source — not filtered downstream.
- New owner-only accessor `WorkerLifecycle.getClaimUrl()` and a dedicated
  `getClaimUrl` RPC (`server.ts`) deliver the claim URL to the owner UI on
  demand. That RPC path is guest-denied by M2.
- Frontend (`nav-panel/tokens-panel.tsx`): new `useClaimUrl()` hook pulls the
  claim via `getClaimUrl` (refetched on the same `worker-changed` signal);
  `WorkerClaimNudge` reads it instead of `status.claim`.
- Test: `worker-lifecycle.test.ts` asserts `getStatus()` and **every** captured
  `publishStatus` broadcast payload contain no `claim` (and no `https://claim/`
  value), while `getClaimUrl()` still returns it.

### M2 — `getWorkerStatus` (all plugin RPC) guest-unreachable

The plugin's own `/authz` classifier treats any `/plugins/*` subpath as an
always-allowed non-thread endpoint, so an RPC POST would have been forwarded and
answered. Added an explicit worker-side deny:

- `worker/src/stages/authz.ts`: `isGuestDeniedRpcPath()` matches
  `/api/v1/plugins/shared/rpc/*`; the authz stage deny-closes it (403
  `{ error: "scope", reason: "plugin rpc is not guest-reachable" }`) **before**
  consulting `/authz` — never dispatched over the tunnel. The `.../http/authz`
  route the worker itself calls is unaffected.
- Tests (`worker/tests/authz.test.ts`): guest → 403 on
  `/api/v1/plugins/shared/rpc/getWorkerStatus` and `.../getClaimUrl` (both never
  dispatched), plus a `isGuestDeniedRpcPath` unit test guarding the `http/authz`
  route and prefix false-positives (`.../rpcish/x`).

### M3 — CF SDK error paths scrubbed

- `cf-deploy.ts`: new `redactSecrets()` redacts `bbsh_*`, `bbcm_*`, and any 32+
  char base64url run (catches the 43-char `tunnelSecret`, the `authzToken`, and
  the CF api token). The `scripts.update` call is wrapped in try/catch that
  re-throws a `CfDeployError` with a redacted message, so the raw SDK error
  never propagates. Both the `deployWorker` retry-log site and
  `worker-lifecycle.ts`'s deploy-catch `log.error` also pass through
  `redactSecrets`.
- Tests (`cf-deploy.test.ts`): `redactSecrets` unit tests, plus an end-to-end
  `deployWorker` test whose synthetic SDK error echoes the raw
  `TUNNEL_SECRET`/`AUTHZ_TOKEN` — asserts neither the logged warning nor the
  thrown error contains the secret (both show `[redacted]`).

### M4 — deploy race routed through the dedupe

- `worker-lifecycle.ts`: extracted `runDeploy()` (the `deployInFlight` dedupe).
  Both `ensureDeployed()` (mintToken) and `tick()`'s health-fail branch now call
  `runDeploy()` instead of `deploy()` directly, so at most one deploy is ever in
  flight — a concurrent mint + health-fail can no longer provision two temp
  accounts and orphan a live secret-bearing worker.
- Test (`worker-lifecycle.test.ts`): a health-fail `tick()` with a gated deploy,
  raced against a concurrent `ensureDeployed()`, results in exactly ONE redeploy
  (`deployCalls === 2`, not 3).

### Verification

- plugin: `tsc --noEmit` clean; `vitest` 68 pass (+6); `bb plugin build .` exit 0.
- worker: `tsc --noEmit` clean; `vitest` 162 pass (+4); `wrangler deploy
  --dry-run` builds.

Note: `getWorkerStatus` retains no takeover bearer post-H1; M2 blocks the whole
RPC transport regardless. The KV-plaintext / no-TLS-pinning residuals (M5, L1–L4)
are out of scope here — they belong to ticket 21.
