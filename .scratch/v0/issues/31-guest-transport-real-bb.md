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

## Live walk #1 (2026-08-30) — guest loads; 3 more gaps found + fixed

First real guest load worked: the guest sees only the shared thread. An authz
trace (temporary, since removed) revealed three more denied boot requests, all
now allowlisted (commit 90761e4):

- `GET /ws` was classified invalid → the live-updates socket upgrade denied (no
  streaming messages). Allowlisted; ws-frame-filter still scopes frames;
  `/ws/terminals/*` stays denied.
- `GET /system/providers` + `/system/execution-options` denied → the "could not
  load models" error. Allowlisted read-only (payloads are provider/model UI
  config, no secrets).
- `GET /system/version` allowlisted (harmless).

Verified live through the deployed worker with a real (self-minted, write) token:
`?token=`→302, shell→200, assets→200, models→200, timeline→200, `/ws`→**101**
(HTTP/1.1; an HTTP/2 curl shows 200 because HTTP/2 doesn't use the Upgrade
header — not a bug). Outbound frame filter forwards an in-scope `changed/thread`
frame, so live message events reach the guest by design.

Send: `POST /threads/{t}/send` works for a **write** share; a **read** share
correctly blocks it (the "scope" toast). Hiding the composer for a read guest is
surface-6 UX, not a transport bug.

Minor, left denied (non-blocking): `POST /threads/resolve-mentions` (mention
autocomplete), `GET /environments/{id}/status|pull-request` (env status in the
thread header). Revisit if the guest UI needs them.

## Outstanding — the live validation gap

The transport chain is now verified by curl (above). What remains is a VISUAL
browser confirmation — that the SPA renders, the model picker populates, and a
new message streams in live — plus the read-guest composer UX.

1. Load the guest link in a real browser; confirm render + models + a live
   message appearing without reload. (Could not automate this run: the
   computer-use/orca binary was uninstalled, so no browser driver was
   available.)
2. Surface-6 UX: hide the composer for a read-only guest (the share perm is in
   the token; the shim can carry it) so a read guest never types into a
   dead-end "scope" error.
3. Walk `docs/e2e-runbook.md`'s guest half for real and record it.

Runtime note: heavy autonomous curl/WS testing tripped CF edge rate-limiting
(HTTP 429) on the temp worker's tunnel dial. Transient — clears on CF's window
or when the temp worker expires and the plugin redeploys a fresh account. Not a
code issue.

## Follow-up

The stub-based e2e should be upgraded to run against a real (or realistic) bb so
this class of bug cannot hide again — the worker unit tests mock authz, so they
cannot catch an auth-header or allowlist mismatch.
