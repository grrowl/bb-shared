# bb-shared — v0 map

Parent: [SPEC.md](../../SPEC.md)

## Notes

- Token/share state is in-memory; worker deployment record persists in
  bb's `PluginSettings` (narrow exception). Interface designed so a
  persistent backend can slot in later without call-site changes.
- Per-owner CF worker deployed via CF temp-deployments (PoW-gated).
- Worker is dumb; pulls token scope from local bb per request.
- SPA has no user/session concept — all scoping via proxy response
  filters + mutation gate + WS frame filter + a small chrome shim.

## Decisions so far

- **Transport**: fork of bb's connect worker + vendored tunnel-client
  packages wrapped in a `SharedTunnel` class. No Tailscale.
  (issues: 01 ✓, 02 ✓, 08 ✓, 14)
- **Deployment**: always-temp CF deploy (no wrangler, no branching,
  one code path). Worker state persisted in bb's `PluginSettings`
  (narrow exception to v0 no-persistence rule — worker only, tokens
  still in-memory). Lazy first-deploy; reuse on plugin start if
  health-check passes; bootstrap fresh on failure/expiry. **60-min
  unclaimed TTL** — v0 UI nudges owner to claim (no tracking of
  claim state).
  (issue: 07 — absorbs deploy pipeline + secret provisioning + claim
  nudge; former issue 13 merged in)
- **Guest URL**: `https://{host}/{token}/projects/{p}/threads/{t}`
  primary; `?token=…` → cookie → 302 fallback. (issue: 08 ✓)
- **Data model**: Token → Share[]. Per-thread perm. Random verb-noun
  label, renameable. Token has a public `id` (short handle for CRUD)
  and a raw bearer (returned once, only its HMAC-SHA256 persisted).
  No expiry, no session tracking. (issues: 05 ✓, 16)
- **Owner UI**: `experimental_threadHeaderAction` + `navPanel` +
  `commandPaletteAction`. React + `useRpc` + `useRealtime`. Plugin
  scaffold delivered; share popover + palette entry live.
  (issues: 04 ✓, 15 ✓, 16)
- **Guest scope**: full SPA served, filtered at proxy. Two endpoints
  (`/system/config`, `/sidebar-bootstrap`) shape 90%. Plugin frontends
  suppressed for v0 (empty `/plugins` inventory). (issue: 09)
- **Authz**: single source of truth = plugin's /authz endpoint (06).
  Worker's mutation gate (10) delegates; no duplicated logic.
- **WS events**: full catalog + filter predicates captured; three
  ephemeral broadcasts (`thread-open`, `thread-pane-action`,
  `plugin-signal`) drop-by-default is load-bearing.
  (issue: 03 ✓ — see `research/realtime-events.md`)
- **Secrets**: two — authz-endpoint bearer (via `bb plugin token`) and
  tunnel handshake secret (design TBD, adversarial review required).
  Both owned by 07.
- **Origin guard**: solved by vendored `headersForLoopbackRequest`;
  worker unconditionally sets Origin to its public origin (enforced in
  08 ✓).
- **Non-goals for v0**: persistence, presence UI, transcript
  attribution, guest identity, multi-tenancy, guest-side plugins,
  Tailscale.

## Fog

- Tunnel handshake secret design — reuse bb's or mint our own; needs
  adversarial review pass (owned by 07).
- SPA data-testid stability across bb versions — CI pin needed (owned
  by 12).

## Frontier

Rounds 1 & 2 done. Resolved: 01, 02, 03, 04, 05, 08, 15.
Currently unblocked: **06, 09, 10, 11, 12, 14, 16, 18.**

Recommended round 3 (4 parallel):

- **14** tunnel client vendor+wrap — unlocks 07 (which unlocks e2e)
- **06** authz endpoint — unlocks 09/10 for real backend testing
- **11** WS frame filter — catalog is fresh, do it now
- **16** nav panel — plugin frontend continuity

09, 10, 12, 18 queue for whichever agent finishes first.
