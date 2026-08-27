# bb-shared — v0 map

Parent: [SPEC.md](../../SPEC.md)

## Notes

- All state is in-memory; dies with plugin restart. Interface designed
  so a persistent backend can slot in later without call-site changes.
- Per-owner CF worker deployed via CF temp-deployments (PoW-gated).
- Worker is dumb; pulls token scope from local bb per request.
- SPA has no user/session concept — all scoping via proxy response
  filters + mutation gate + WS frame filter + a small chrome shim.

## Decisions so far

- **Transport**: fork of bb's connect worker + vendored tunnel-client
  packages wrapped in a `SharedTunnel` class. No Tailscale.
  (issues: 01 ✓, 02 ✓, 08, 14)
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
  primary; `?token=…` → cookie → 302 fallback. (issue: 08)
- **Data model**: Token → Share[]. Per-thread perm. Random verb-noun
  label, renameable. No expiry, no session tracking. (issues: 05, 16)
- **Owner UI**: `experimental_threadHeaderAction` + `navPanel` +
  `commandPaletteAction`. React + `useRpc` + `useRealtime`. Plugin
  scaffold delivered — vendored shadcn primitives available for
  confirm dialogs etc.
  (issues: 04 ✓, 15, 16)
- **Guest scope**: full SPA served, filtered at proxy. Two endpoints
  (`/system/config`, `/sidebar-bootstrap`) shape 90%. Plugin frontends
  suppressed for v0 (empty `/plugins` inventory). (issue: 09)
- **Authz**: single source of truth = plugin's /authz endpoint (06).
  Worker's mutation gate (10) delegates; no duplicated logic.
- **Secrets**: two — authz-endpoint bearer (via `bb plugin token`) and
  tunnel handshake secret (design TBD by spike 02 outcome, adversarial
  review required). Both owned by 07.
- **Origin guard**: solved by vendored `headersForLoopbackRequest`;
  worker must forward guest `Origin` unchanged (constraint enforced in 08).
- **Non-goals for v0**: persistence, presence UI, transcript
  attribution, guest identity, multi-tenancy, guest-side plugins,
  Tailscale.

## Fog

- Complete realtime event catalog for WS filter (spike 03 — still open).
- Tunnel handshake secret design — reuse bb's or mint our own; needs
  adversarial review pass (owned by 07).
- SPA data-testid stability across bb versions — CI pin needed (owned
  by 12).

## Frontier

Spikes 01, 02 and scaffold 04 all resolved. Currently unblocked:
**03, 05, 08, 15, 16.**

Recommended parallel next round (4 agents):

- **08** worker scaffold — highest leverage; unlocks 09/10/11/12/14
- **05** token store — unlocks 06
- **15** share button — proceeds on plugin scaffold (04 done)
- **03** realtime event catalog — small research spike; unlocks 11

16 (nav panel) can queue for whichever agent finishes first.
