Status:
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
