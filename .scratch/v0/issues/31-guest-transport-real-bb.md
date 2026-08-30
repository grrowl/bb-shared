# 31 — Guest transport broken against a real bb (chain of fixes) — RESOLVED (browser-verified)

Status: RESOLVED. Verified end to end in a real browser (agent-browser) against
a live deployed worker on 2026-08-30 — the guest deep link opens straight to the
shared thread, history renders, models load, the composer works for a write
share, the sidebar is scoped to the one shared thread, and new messages stream
in live over /ws. Found while installing to test. Ticket 27's e2e used a STUB bb
that did not enforce plugin-token auth or serve the real SPA, so none of the
below surfaced until a real-bb walk. Remaining: surface-6 read-guest composer
UX (below), and folding this into an automated real-bb e2e.

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

## Live walk #2 (2026-08-30, browser) — deep-link fix; fully verified

Drove agent-browser (`npx agent-browser`) against a live deployed worker. First
load showed the SPA falling back to `/` (empty new-thread view) with a "could
not load the project's execution defaults" error, because the set-cookie 302
redirected to `/{token}/<path>` — bb's client router doesn't know the `/{token}`
prefix. Since the cookie already carries the token, `buildCleanRedirectPath` now
drops it and redirects to the clean bb path (commit 332ef8e). Re-tested on a
fresh worker: the deep link opens straight to the thread (landed URL is the
clean `/projects/{p}/threads/{t}`), history renders, the model picker populates
("Opus 4.8 1M High"), the composer is present (write share), the sidebar shows
only the shared thread, and the guest view mirrored the owner's live activity in
real time — proving `/ws` live updates end to end.

## Outstanding

1. Surface-6 UX: hide the composer for a read-only guest (the share perm is in
   the token; the shim can carry it) so a read guest never types into a
   dead-end "scope" error.
2. Fold this walk into an automated real-bb e2e so the class of bug can't hide.

Runtime note: heavy autonomous curl/WS testing tripped CF edge rate-limiting
(HTTP 429) on a temp account. Account-specific — a fresh temp deploy has a clean
budget. Not a code issue. Also noted: the health check treats a 429 worker as
"healthy" (429 < 500) and reuses it; consider treating 429/5xx as unhealthy.

## Follow-up

The stub-based e2e should be upgraded to run against a real (or realistic) bb so
this class of bug cannot hide again — the worker unit tests mock authz, so they
cannot catch an auth-header or allowlist mismatch.
