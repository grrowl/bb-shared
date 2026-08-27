Status:
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
