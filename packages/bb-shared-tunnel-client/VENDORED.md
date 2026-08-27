# Vendored: @bb-shared/tunnel-client

Copy of bb's transport-generic tunnel client (session, header rewrite,
reconnect backoff, error humanization).

| | |
|---|---|
| Upstream package | `packages/tunnel-client` (bb monorepo, `private: true`) |
| Upstream commit | `31a190d` (2026-08-26) |
| bb version | 0.40.0 |

## Files (all from `packages/tunnel-client/src/`)

- `index.ts` — re-exports
- `session.ts` — `TunnelSession`: proxies relayed HTTP/WS streams to loopback
- `headers.ts` — `headersForLoopbackRequest`: the Origin rewrite the guest
  request depends on (see SPEC §Transport, spike 02)
- `reconnect.ts` — `ReconnectBackoff`
- `humanize.ts` — `humanizeTransportError`
- `logger.ts` — `TunnelClientLogger` interface

## Local modifications

Exactly one, mechanical: the `@bb/tunnel-contract` import specifier in
`headers.ts` and `session.ts` was rewritten to `@bb-shared/tunnel-contract`
(our vendored copy). Otherwise byte-for-byte.

## Sync policy

Copy the six files verbatim on a bb version bump, then re-apply the single
import rewrite above. Keep in step with `@bb-shared/tunnel-contract`.
