# bb-shared — v0 map

Parent: [SPEC.md](../../SPEC.md)

## Notes

- Token/share state is in-memory; worker deployment record persists in
  bb's `PluginSettings` (narrow exception). Interface designed so a
  persistent backend can slot in later without call-site changes.
- Per-owner CF worker deployed via CF temp-deployments (PoW-gated).
- Worker is dumb; pulls token scope from local bb per request via 06's
  authz endpoint.
- SPA has no user/session concept — all scoping via proxy response
  filters + mutation gate + WS frame filter + a small chrome shim.

## Decisions so far

- **Transport**: fork of bb's connect worker + vendored tunnel-client
  packages wrapped in a `SharedTunnel` class. No Tailscale.
  (issues: 01 ✓, 02 ✓, 08 ✓, 14 ✓)
- **Deployment**: always-temp CF deploy (no wrangler, no branching,
  one code path). Worker state persisted in bb's `PluginSettings`.
  Lazy first-deploy; reuse on plugin start if health-check passes;
  bootstrap fresh on failure/expiry. **60-min unclaimed TTL** — v0 UI
  nudges owner to claim (no tracking of claim state).
  (issue: 07 — absorbs deploy pipeline + secret provisioning + claim
  nudge; former issue 13 merged in)
- **Guest URL**: `https://{host}/{token}/projects/{p}/threads/{t}`
  primary; `?token=…` → cookie → 302 fallback. (issue: 08 ✓)
- **Data model**: Token → Share[]. Per-thread perm. Random verb-noun
  label, renameable. Token has a public `id` (short handle for CRUD)
  and a raw bearer (returned once, only its HMAC-SHA256 persisted).
  No expiry, no session tracking. (issues: 05 ✓, 16 ✓)
- **Owner UI**: `experimental_threadHeaderAction` + `navPanel` +
  `commandPaletteAction`. React + `useRpc` + `useRealtime`. Share
  popover, palette entry, and token management console all live.
  (issues: 04 ✓, 15 ✓, 16 ✓)
- **Guest scope**: full SPA served, filtered at proxy. Two endpoints
  (`/system/config`, `/sidebar-bootstrap`) shape 90%. Plugin frontends
  suppressed for v0 (empty `/plugins` inventory). (issue: 09)
- **Authz**: single source of truth = plugin's /authz endpoint (06 ✓).
  Worker's mutation gate (10) delegates; no duplicated logic.
- **WS events**: full catalog + filter predicates implemented. Three
  ephemeral broadcasts drop-by-default is load-bearing.
  (issues: 03 ✓ — see `research/realtime-events.md` — and 11 ✓)
- **Secrets**: two — authz-endpoint bearer (via `bb plugin token`) and
  tunnel handshake secret (design TBD, adversarial review required).
  Both owned by 07.
- **Origin guard**: solved by vendored `headersForLoopbackRequest`;
  worker unconditionally sets Origin to its public origin (enforced in
  08 ✓, exercised in 14 ✓ via `resolveOrigin`).
- **Non-goals for v0**: persistence, presence UI, transcript
  attribution, guest identity, multi-tenancy, guest-side plugins,
  Tailscale.

## Fog

- Tunnel handshake secret design — reuse bb's or mint our own; needs
  adversarial review pass (owned by 07).
- SPA data-testid stability across bb versions — CI pin needed (owned
  by 12).

## Frontier

Rounds 1, 2, 3 done. Resolved: 01, 02, 03, 04, 05, 06, 08, 11, 14, 15, 16.
Currently unblocked: **07, 09, 10, 12, 18.**

Recommended round 4 (4 parallel):

- **07** worker lifecycle manager — highest leverage; brings the stack
  together (deploy + secret provisioning + claim nudge)
- **09** response filters — guest-scope shaping at the worker
- **10** mutation gate + route lockouts — delegates to 06's authz
- **12** SPA chrome shim + CI selector-pin

18 (realtime-channels split — cleanup) queues for whoever finishes
first. After round 4, only 17 (e2e smoke) remains.

## Round 3 commit hygiene note

Round 3's four bb subthreads ran in one shared working tree. My
prompt template said `git add -A`, and ticket 11 committed
(`8c37eb1`) while 14 and 16 had in-progress files on disk —
sweeping them into 11's commit. All work landed correctly; just
muddy attribution.

- `8c37eb1` "11: WS frame filter" actually contains 11's + 14's +
  16's code artifacts.
- `8daae2d` "14: …" is a status-only commit (Answer + ticket state).
- `3ee0952` "16: …" is a status-only commit (Answer + ticket state).
- `989c2dd` "06: authz endpoint" was staged with explicit paths,
  clean.

Round 4 prompts fixed: stage own files by path, not `git add -A`.
