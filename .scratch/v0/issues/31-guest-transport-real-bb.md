# 31 — Guest transport broken against a real bb (chain of fixes) — RESOLVED pending live validation

Status: fixes committed; needs one clean end-to-end guest load with a freshly
minted link to close. Found while installing to test (2026-08-30). Ticket 27's
e2e used a STUB bb that did not enforce plugin-token auth or serve the real SPA,
so none of the below surfaced until a real-bb walk.

## Root cause (the blocker)

The worker authenticated to bb's `/authz` route with `Authorization: Bearer
<plugin-token>`. bb 0.40 rejects that with 401 — its `auth: "token"` routes read
the per-plugin token from the `x-bb-plugin-token` header (`?token=` is taken by
the guest token). Every authz call failed closed, so every guest request 404'd.

Verified live: `Authorization: Bearer` → 401, `x-bb-plugin-token` → 200.
Fix: worker `buildAuthzRequest` now sends `x-bb-plugin-token`. (commit 31e145d)

## The downstream chain (each also required, all committed 8821c76)

1. Share links were the bare path form `/{token}/…`, which sets no session
   cookie; the SPA's absolute `/assets/*` requests then arrive credential-less
   and 401. `buildShareUrl` now emits the `?token=` query form, which the worker
   turns into Set-Cookie + 302; the cookie authenticates all absolute requests.
2. The share popover copied the mint URL before attaching the thread, so the
   link deep-linked nowhere. `mintToken` now takes `firstThread` and returns a
   deep link to it.
3. authz deny-by-default (23) 404'd every static asset. `classifyPath` now
   treats the SPA shell (`/`) and static assets (`/assets/*`, root
   favicons/manifest/fonts) as guest-readable non-thread GETs, structurally
   excluding scoped `/threads` and `/projects`.

## Supporting fixes

- `getWorkerStatus` returned `tunnel: undefined`, which bb's RPC envelope
  rejects — owner status panel could not load. Now omitted when absent. (0ce0157)
- Deployed worker renamed `bb-shared-worker` → `bb-shared` (first URL label).
  (13f7d71) A persisted worker whose script name no longer matches the default
  is now treated as stale and redeployed, so the rename + fixed bundle roll out
  instead of the old worker being reused forever. (31e145d)

## Outstanding — the live validation gap

The end-to-end guest walk against a real bb has NOT passed yet. Each fix reload
killed the in-memory test token, so the full chain was never observed working.
To close:

1. Mint a fresh link (no reloads after).
2. Curl the whole boot through the deployed worker with a cookie jar: `?token=`
   entry → 302, SPA shell at the thread path → 200, an `/assets/*` file → 200.
3. Load it in a browser and watch the network tab for any GET boot endpoint the
   authz allowlist still misses (e.g. project/thread detail calls beyond
   `/system/config` + `/sidebar-bootstrap`). Allowlist any that are guest-safe.
4. Then walk `docs/e2e-runbook.md`'s guest half for real and record it.

## Follow-up

The stub-based e2e should be upgraded to run against a real (or realistic) bb so
this class of bug cannot hide again — the worker unit tests mock authz, so they
cannot catch an auth-header or allowlist mismatch.
