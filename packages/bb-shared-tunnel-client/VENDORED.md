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

The contract import uses `@bb-shared/tunnel-contract`. The session now enforces
bounded concurrent streams, body sizes, pending WebSocket data, and receive
deadlines. Invalid frame metadata and duplicate stream transitions close the
relay connection. Logs omit request queries and transport error bodies.

## Sync policy

Review upstream transport changes and reapply these local trust-boundary limits.
Do not overwrite the session verbatim when updating BB. Keep the binary frame
format in step with `@bb-shared/tunnel-contract` and run the full-stack tests.
