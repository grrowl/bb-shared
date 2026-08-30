# 37 — Harden worker guest RPC-deny against %2F-encoded paths (LOW / defense-in-depth)

Source: fable security review of issue 32 (2026-08-30). Not a live vulnerability
— filed so it isn't lost.

## Finding

The worker denies guest access to plugin RPC via
`GUEST_DENIED_RPC_RE = /^\/api\/v1\/plugins\/shared\/rpc(?:\/|$)/`
(worker/src/stages/authz.ts). `URL.pathname` leaves `%2F` percent-encoded, so a
path like `/api/v1/plugins/shared/rpc%2FlistTokens` does NOT match the regex and
skips this early deny.

Today this is backstopped: the plugin's `computeAuthz` classifies the path in the
`/plugins` non-thread family and denies every mutating method (bb serves plugin
RPC as POST), so the call still dies. No leak. But the worker-level deny is the
intended first gate and it has a hole.

## Fix

- Normalise/decode the path before matching, or extend the regex to also catch
  `%2f`/`%2F` immediately after `.../rpc`, so the worker denies the encoded form
  at the edge rather than relying on the plugin backstop.
- Add a worker unit test pinning encoded-path handling
  (`/api/v1/plugins/shared/rpc%2FlistTokens` → denied) so a future refactor can't
  silently reopen it.

## Scope

worker/src/stages/authz.ts + worker/tests. Keep the plugin-side backstop as-is
(defense in depth). Small, self-contained.
