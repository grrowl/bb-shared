# Vendored: @bb-shared/tunnel-contract

Verbatim copy of bb's transport-generic tunnel wire protocol package.

| | |
|---|---|
| Upstream package | `packages/tunnel-contract` (bb monorepo, `private: true`) |
| Upstream commit | `31a190d` (2026-08-26) |
| bb version | 0.40.0 |
| `PROTOCOL_VERSION` | 1 |

## Why vendored

Upstream is a `private: true` workspace-only package — not npm-installable.
It is vendored here so the Worker and plugin can share the exact transport
contract without depending on an unpublished bb workspace.

## Sync policy

- Copy `src/index.ts` verbatim on a bb version bump.
- This is bb's public tunnel wire protocol; it changes rarely (a change
  breaks every deployed bb client). Watch `PROTOCOL_VERSION` in particular —
  if it bumps, the worker's `TunnelDO` (`worker/src/tunnel/`) and this copy
  must move in lockstep, and `SharedTunnel` sends the new value on the
  `/__tunnel` query param.
- Only local modification: none. Copied byte-for-byte.
