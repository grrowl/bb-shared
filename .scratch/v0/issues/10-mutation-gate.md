Status:
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
