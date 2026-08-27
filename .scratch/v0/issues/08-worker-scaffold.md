Status: resolved
Type: task
Blocked by: 01, 02

Fork of `apps/connect/src/worker.ts` as the base for our worker.

- Strip the GitHub-cookie auth path.
- Add token extraction from the first path segment (`/{token}/…`) OR
  `?token=` query param.
- On `?token=` hit: set cookie (`bb_shared_session`, HttpOnly, Secure,
  SameSite=Lax) and 302 to `/{token}/…`.
- Basic /ws upgrade proxy passthrough (filtering comes in issue 11).
- Route requests to the target local bb over the tunnel (see issue 14).
- **Origin forwarding constraint (from spike 02)**: for every guest
  request forwarded to the tunnel, either preserve the guest's incoming
  `Origin` header unchanged, or unconditionally set it to the worker's
  public origin (`new URL(request.url).origin`). The tunnel-client's
  Origin rewrite in 14 depends on this to pass local bb's Origin guard.
  If we strip or garble the header, local bb 403s and nothing works.
- Auth-check tunnel connections with the tunnel handshake secret from
  07 — worker rejects any tunnel dial that doesn't present it.
- Emit clear 4xx bodies for scope/authz failures.

Blocker note: tunnel handshake spans both wire halves; spike 02 informs
the auth model on this end.

Layers on top of this: 09 (response filters), 10 (mutation gate + route
lockouts), 11 (WS filter), 12 (chrome shim).

## Comments

## Answer

Landed in [`~/grrowl/bb-shared/worker/`](../../../worker/). Full layout and
runbook in [`worker/README.md`](../../../worker/README.md).

**Shipped:**

- `src/worker.ts` — thin entry: routes `/__tunnel` to the tunnel router (auth
  in the DO), everything else through the request pipeline.
- `src/pipeline.ts` — `runPipeline` + `Stage` type. Every downstream ticket
  (09/10/11/12) slots in as a new file under `src/stages/` and one line in
  the entry's stage array.
- `src/stages/extract-token.ts` — extracts token from `/{token}` path,
  `?token=` query, or `bb_shared_session` cookie. Precedence path > query
  > cookie. Rewrites `request.url` to strip the token prefix so
  downstream sees the tokenless bb path. Missing token → 401 JSON body.
- `src/stages/set-cookie-redirect.ts` — on `?token=` hits, sets
  `bb_shared_session` (HttpOnly, Secure, SameSite=Lax, Max-Age=30d) and 302s
  to the clean `/{token}/…` shape with the token query param stripped.
- `src/stages/prepare-tunnel-request.ts` + `src/origin.ts` — enforces the
  spike-02 Origin invariant by unconditionally setting `Origin` to
  `new URL(request.url).origin` before dispatch. Never strips.
- `src/stages/dispatch.ts` + `src/tunnel/interface.ts` +
  `src/tunnel/do-router.ts` — `TunnelRouter` interface (single `.dispatch()`
  entry for HTTP + WS upgrade) backed by a singleton DO.
- `src/tunnel/tunnel-do.ts` — `TunnelDO` accepts `/__tunnel` WS upgrade with
  bearer auth against `env.TUNNEL_SECRET` (constant-time compare, single
  active socket, fresh dial supersedes). Guest proxy path is stubbed to 503
  `x-bb-tunnel-offline: 1` with a `TODO(14)` marker where the wire protocol
  from `@bb/tunnel-contract` will land.
- `src/cookie.ts`, `src/errors.ts` — helpers.
- `wrangler.toml` — `TUNNEL_DO` binding, `v1` new-classes migration,
  `workers_dev = true`, compatibility date `2025-06-01`.
- Vitest suite (49 tests, all passing) covering token extraction (path /
  query / cookie precedence, malformed values, edge cases like `/` and
  `/{token}/`), Origin handling (idempotence, never-strip invariant, header
  preservation), and cookie parse/serialize.
- Strict TypeScript; `tsc --noEmit` and `wrangler deploy --dry-run` both
  clean.
- README documents local-dev, `TUNNEL_SECRET`, and full deploy notes for 07
  (metadata payload shape, migration on first deploy only, health-check
  probe, secret sync).

**Ready for downstream tickets:**

- 09 (response filters): add stage after `dispatch` (or lift `runPipeline`
  to onion-style — see design note in README).
- 10 (mutation gate + route lockouts): stage before `dispatch`, uses
  `ctx.request.method` + `ctx.url.pathname`.
- 11 (WS filter): wraps dispatch on `upgrade: websocket` requests.
- 12 (SPA chrome shim): post-dispatch stage, checks response content-type.
- 14 (`SharedTunnel` local half): pairs with `TunnelDO`'s stubbed proxy
  path — port the wire protocol on both sides in one pass. Auth handshake
  (`Authorization: Bearer <TUNNEL_SECRET>` on `/__tunnel` WS upgrade) is
  already terminated on this side.
