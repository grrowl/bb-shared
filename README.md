# bb-shared

A bb plugin that lets the owner grant a guest **live access to specific bb
threads** — read or write, per thread — via a scoped, revocable capability
token. The guest opens a URL and gets the real bb SPA scoped to just their
shared threads (not a stripped mirror): they can watch the transcript live and,
with `write` perm, inject input as user messages. The owner can add/remove
threads, change perms, or revoke the whole token at any time, and changes take
effect immediately. Intended for pair-programming / pair-prompting during
grilling sessions.

Three components: a per-owner **Cloudflare Worker** (fork of bb connect,
deployed anonymously via CF temp-deployments) that gates guests on the token and
proxies to the owner's local bb over a tunnel; a vendored **tunnel client**
wrapped in a `SharedTunnel`; and the **bb-shared plugin** running in-process in
the local bb server, holding token state, answering scope checks, and exposing
the owner UI. The SPA has no user/session concept, so all scoping is enforced at
the worker via response filters, a mutation gate, a WebSocket frame filter, and
a small chrome shim.

## Status

**v0 complete** — all v0 tickets (01–19) resolved. State is in-memory (tokens
die on plugin restart; the worker deployment record persists in
`bb.storage.kv`). See the runbook's "Known v0 limitations" for the full list.

## Docs

- **[SPEC.md](SPEC.md)** — full design: architecture, transport, data model,
  scope enforcement, owner UI, non-goals.
- **[docs/e2e-runbook.md](docs/e2e-runbook.md)** — manual end-to-end smoke-test
  runbook: install → deploy → mint → guest walk-through → revocation, with the
  SPEC-vs-reality drift flagged.
- **[.scratch/v0/map.md](.scratch/v0/map.md)** — v0 feature map and decision log.

## Layout

- [`plugin/`](plugin/README.md) — the bb-shared plugin (token store, authz
  endpoint, worker lifecycle, owner UI). Install/dev in its README.
- [`worker/`](worker/README.md) — the Cloudflare Worker (token gating +
  proxy pipeline). Dev/deploy notes in its README.
- `packages/` — vendored bb tunnel-contract + tunnel-client.
- `research/` — spike outputs (CF temp-deployments, tunnel client, realtime
  events).
- `.scratch/v0/` — v0 planning: the map and per-ticket issues.
