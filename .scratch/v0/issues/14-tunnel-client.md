Status: resolved
Type: task
Blocked by: 08

Local tunnel client pointing at our worker. Vendor + wrap approach
(per spike 02 findings — see `research/tunnel-client.md`).

## Vendor

Copy bb's transport-generic packages into monorepo packages:

- `packages/bb-shared-tunnel-client/` (from
  `/tmp/claude/bb-research/bb/packages/tunnel-client/`)
- `packages/bb-shared-tunnel-contract/` (from
  `/tmp/claude/bb-research/bb/packages/tunnel-contract/`)

Both are `private: true` upstream so not npm-installable. ~750 LOC
combined. Track the bb version they were copied from in a header
comment on each entry file; sync manually on bb version bumps.

## Wrap

`SharedTunnel` class inside the plugin (~120 LOC per spike 02's sketch):

- Construction: `new SharedTunnel({ workerUrl, tunnelSecret, loopbackBaseUrl })`
- API: `start()`, `stop()`, `getStatus()`.
- Sets `publicOrigin = new URL(workerUrl).origin`, `loopbackOrigin = loopbackBaseUrl`
  so the vendored `headersForLoopbackRequest` rewrites Origin correctly
  (visitor `Origin: https://<worker-host>` → `Origin: http://127.0.0.1:38886`
  before hitting local bb; passes the Origin guard cleanly).
- Started/stopped by 07's lifecycle manager on deploy / redeploy.
- Auth handshake with our worker using `tunnelSecret` (design TBD per
  07's secret provisioning + adversarial review).
- Reconnect with backoff.

Refs:

- Vendored code path: `/tmp/claude/bb-research/bb/packages/tunnel-client/src/headers.ts:15`
- Spike doc: `research/tunnel-client.md` (has a concrete class sketch
  in the appendix)

Coexists with real `bb connect` — different plugin namespace, different
KV. Users can run both if they want.

## Comments

## Answer

Vendored bb's transport-generic tunnel packages and wrapped them in a
`SharedTunnel` class. Verified: plugin `tsc --noEmit` clean, `bb plugin
build .` succeeds, both vendored packages typecheck standalone.

### Delivered

- **`packages/bb-shared-tunnel-contract/`** — verbatim copy of bb's
  `packages/tunnel-contract/src/index.ts` (wire protocol, `PROTOCOL_VERSION
  = 1`). Package name `@bb-shared/tunnel-contract`. `VENDORED.md` records
  upstream commit `31a190d` (bb 0.40.0). Zero local modifications.
- **`packages/bb-shared-tunnel-client/`** — copy of bb's
  `packages/tunnel-client/src/{index,session,headers,humanize,reconnect,logger}.ts`.
  Package name `@bb-shared/tunnel-client`, deps `@bb-shared/tunnel-contract`
  + `ws`. Only local change: the `@bb/tunnel-contract` import specifier
  rewritten to `@bb-shared/tunnel-contract` in `headers.ts` + `session.ts`
  (documented in `VENDORED.md`).
- **`plugin/lib/shared-tunnel.ts`** — `SharedTunnel` class per spike 02.
  - Constructor `new SharedTunnel({ workerUrl, tunnelSecret, loopbackBaseUrl })`;
    API `start()` / `stop()` / `getStatus()`.
  - Derives `publicOrigin = new URL(workerUrl).origin` and
    `loopbackOrigin = loopbackBaseUrl` and feeds them through `resolveOrigin`
    so the vendored `headersForLoopbackRequest` rewrites the guest
    `Origin: https://<worker-host>` → the loopback origin before it hits
    local bb (passes the Origin guard cleanly).
  - Auth handshake: `Authorization: Bearer <tunnelSecret>` on the
    `/__tunnel?v=1` WS upgrade — mirrors the worker's `TUNNEL_SECRET`
    check in `worker/src/tunnel/tunnel-do.ts` (`timingSafeEqual`). The WS
    upgrade IS the handshake; no back-channel.
  - Reconnect via the vendored `ReconnectBackoff` (capped exponential,
    stable-connection reset). `401/403` → stop and wait for 07 to hand a
    fresh secret; other failures → backoff redial.
  - `getStatus()` exposes `{ state, workerUrl, remoteClients,
    lastConnectedAt, lastError }` for 07's lifecycle + owner-panel status.
- **Workspaces** — new root `package.json` with
  `"workspaces": ["packages/*", "plugin"]`; plugin depends on both vendored
  packages + `ws` (+ `@types/ws`). `npm install` at root links them; the
  stale `plugin/package-lock.json` was removed in favour of the root lock.

### Integration contract for issue 07

`WorkerLifecycle` owns `SharedTunnel`: on (re)deploy, construct one with the
fresh `{ workerUrl, tunnelSecret }` + `bb.server.loopbackBaseUrl`, call
`start()`, and `stop()` the previous instance. Mount under
`bb.background.service("shared-tunnel", …)` and forward `onStatusChange` to
`bb.realtime` on the `worker-changed` channel. Confirmed the import graph
(`ws` + vendored code) bundles into `server.js` when imported (probe build,
reverted).

### Note — concurrent commit

Round 3 ran four agents in one working tree. Issue 11's agent committed with
`git add -A`, which swept this ticket's finished artifacts (the two vendored
packages, `plugin/lib/shared-tunnel.ts`, root `package.json` /
`package-lock.json`, the plugin `package.json` dep additions, and the
`plugin/package-lock.json` deletion) into commit **`8c37eb1` ("11: WS frame
filter")**. They landed as the correct final versions (verified: no probe
leaked, `shared-tunnel.ts` byte-identical to intended). History was left
as-is rather than rewritten, since sibling agents were committing live; this
resolution commit carries only the ticket status/answer.
