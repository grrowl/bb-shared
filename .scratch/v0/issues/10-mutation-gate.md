Status: resolved
Type: task
Blocked by: 08

Path allowlist + route lockouts at the worker.

- Deny-by-default; explicit allowlist per (method, path).
- Allow-by-scope: `GET /api/v1/threads/{t}/*` if `t` in scope (per 06's
  authz response).
- Allow-by-scope-and-perm: `POST /api/v1/threads/{t}/send` if `t` in
  scope AND perm == `write` (per 06's authz response).
- SPA route lockouts: `/settings/*`, `/extensions/*`, `/tools/*`,
  `/hosts/*` — return a tiny HTML page that 302s to `/{token}/`.
- Everything else → `403 { error: "scope" }` for API, `404` for
  unrecognized HTML routes.
- Regression tests: iterate every route in bb server-contract, assert
  guest gets 403 for non-allowlisted routes.

**Delegates all authz decisions to issue 06's /authz endpoint.** This
issue's job is path matching, method extraction, and enforcing the
response — no independent authz logic. Interface-only dependency on 06,
not a build dependency.

## Comments

## Answer

Two new pipeline stages, both landing before the scope-enforcing stages (11 WS
frame filter, 09 response filters) so `ctx.scope` is populated for both.

**`worker/src/stages/authz.ts` — the authz gate.** The worker's single
consultation of 06's `/authz` endpoint; carries no independent authz logic.
Per guest request it:

1. `GET /api/v1/plugins/bb-shared/http/authz?token=…&path=…&method=…` over the
   tunnel (`router.dispatch`), bearer-authed with `env.AUTHZ_TOKEN`. `path` is
   the tokenless guest path (`ctx.url.pathname`, already stripped by
   extract-token); `method` is the guest's method. Origin is set to the worker
   public origin like every tunnel-bound request.
2. Parses `{ allowed, thread_scope, perms, reason? }` and populates
   `ctx.scope` via `scopeFromAuthz` (`thread_scope → threadIds`).
3. `allowed === false` → deny: `403 { error: "scope", reason }` for API paths
   (`/api/*`), `404` for SPA/HTML paths.
4. `allowed === true` → `continue`.

Fails **closed**: unreachable tunnel, non-2xx (e.g. bearer rejected), or
malformed body all deny. Exception: a `503 tunnel_offline` is passed through
untouched so the SPA's own retry loop handles a transient outage rather than
seeing a hard scope error. `ctx.token === null` (defensive; extract-token 401s
first) → 401 without consulting the endpoint.

**`worker/src/stages/route-lockouts.ts` — SPA route lockouts.** Intercepts hard
navigations to `/settings/*`, `/extensions/*`, `/tools/*`, `/hosts/*` (SPA
routes only — `/api/*` excluded, those are REST endpoints handled by authz +
09) and serves a tiny HTML document that `location.replace`s to `/{token}/`
(with a `<meta http-equiv=refresh>` fallback), per SPEC §"Route lock-outs". The
client-side redirect gives react-router a clean full load at the token root —
it never mounts the locked path. Runs before authz so a locked route redirects
rather than falling through to a scope 404.

**Wiring (`worker/src/worker.ts`):** inserted `routeLockoutsStage` then
`authzStage(router)` after `prepareTunnelRequestStage`, before
`wsFrameFilterStage` and `responseFiltersStage`.

**Env (`worker/src/env.ts`):** added `AUTHZ_TOKEN: string` (07 provisions it
alongside `TUNNEL_SECRET`). This was the one file outside the ticket's stated
set that had to change — the bearer needs a typed home on `Env`; the change is
purely additive.

**Tests (`worker/tests/authz.test.ts`, 20 cases):** the six required — authz
allow forwards (asserts scope populated + correct query/bearer), deny 403s,
missing token 401 (without consulting authz), thread out-of-scope 403, mutating
write-without-perm 403, route-lockout redirect — plus HTML-deny 404, non-2xx
fail-closed, 503 pass-through, tunnel-throw fail-closed, and pure-helper unit
tests for `scopeFromAuthz` / `isApiPath` / `denyForPath` / `isLockedRoute`.

**Verify:** `tsc --noEmit` clean; `vitest run tests/authz.test.ts` 20/20 pass;
`wrangler deploy --dry-run` builds. (The full suite shows 2 failures in 09's
`tests/response-filters.test.ts` — 09's in-progress work, untouched here.)

**Known interface drift for a 06 follow-up:** `GuestScope.projectIds` should be
the union of a token's project ids (per `scope.ts` and needed by 11's
`project-detail` WS subscriptions), but 06's `perms` entries are
`{ thread_id, mode }` with no `project_id`. `scopeFromAuthz` derives
`projectIds` from `perm.project_id` **if present** — forward-compatible, so it
picks them up with zero change here once 06 adds the field, but yields an empty
set today. Deriving projects independently (e.g. from the request URL) would be
exactly the independent authz logic this ticket forbids, so it is left to a 06
amendment. Flagging for the map/frontier.
