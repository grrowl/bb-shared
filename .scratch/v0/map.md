# bb-shared — v0 map

Parent: [SPEC.md](../../SPEC.md)

## Notes

- Token/share state is in-memory; worker deployment record persists in
  `bb.storage.kv` (narrow exception). Interface designed so a persistent
  backend can slot in later without call-site changes.
- Per-owner CF worker deployed via CF temp-deployments (PoW-gated).
- Worker is dumb; pulls token scope from local bb per request via 06's
  authz endpoint.
- SPA has no user/session concept — all scoping via proxy response
  filters + mutation gate + WS frame filter + a small chrome shim.

## Decisions so far

- **Transport**: fork of bb's connect worker + vendored tunnel-client
  packages wrapped in a `SharedTunnel` class. No Tailscale.
  (issues: 01 ✓, 02 ✓, 08 ✓, 14 ✓)
- **Deployment**: always-temp CF deploy (no wrangler at runtime, one
  code path). Worker state persisted in `bb.storage.kv`. Lazy first
  deploy on `mintToken`; reuse on plugin start if health-check passes;
  bootstrap fresh on failure/expiry. 60-min unclaimed TTL — owner UI
  nudges to claim.
  (issue: 07 ✓ — absorbs deploy pipeline + secret provisioning + claim
  nudge; former issue 13 merged in)
- **Guest URL**: `https://{host}/{token}/projects/{p}/threads/{t}`
  primary; `?token=…` → cookie → 302 fallback. (issue: 08 ✓)
- **Data model**: Token → Share[]. Per-thread perm. Random verb-noun
  label, renameable. Token has a public `id` (short handle for CRUD)
  and a raw bearer (returned once, only its HMAC-SHA256 persisted).
  No expiry, no session tracking. (issues: 05 ✓, 16 ✓)
- **Owner UI**: `experimental_threadHeaderAction` + `navPanel` +
  `commandPaletteAction`. React + `useRpc` + `useRealtime`. Share
  popover, palette entry, token management console all live.
  (issues: 04 ✓, 15 ✓, 16 ✓)
- **Guest scope**: full SPA served, filtered at proxy. Two endpoints
  (`/system/config`, `/sidebar-bootstrap`) shape 90%. Plugin frontends
  suppressed for v0 (empty `/plugins` inventory).
  (issue: 09 ✓ — response filters live)
- **Authz**: single source of truth = plugin's /authz endpoint (06 ✓).
  Worker's mutation gate (10 ✓) delegates; no duplicated logic.
- **WS events**: full catalog + filter predicates implemented. Three
  ephemeral broadcasts drop-by-default is load-bearing.
  (issues: 03 ✓ — see `research/realtime-events.md` — and 11 ✓)
- **Chrome shim**: HTML rewrite injects CSS + JS to hide Settings,
  Extensions, New-thread, plugin-nav-sidebar-items on guest requests.
  Selectors CI-pinned via `scripts/check-chrome-selectors.mjs` +
  `BB_VERSION`. (issue: 12 ✓)
- **Secrets**: two — authz bearer via `bb.sdk.plugins.token()` and
  tunnel handshake secret (32B CSPRNG, rotated per redeploy, persisted
  plaintext in bb.storage.kv). Both owned by 07 ✓. Adversarial review
  still wanted (see follow-ups).
- **Origin guard**: solved by vendored `headersForLoopbackRequest`;
  worker unconditionally sets Origin to its public origin
  (08 ✓ enforced; 14 ✓ exercises via `resolveOrigin`).
- **Non-goals for v0**: persistence (except worker record), presence
  UI, transcript attribution, guest identity, multi-tenancy,
  guest-side plugins, Tailscale.

## Fog

- SPA data-testid stability across bb versions — CI pinned per
  `BB_VERSION`; needs re-run on each bump.

## Frontier

Rounds 1–6 done. Resolved: 01–06, 08–12, 14–17, 18, 19.

**v0 blocker fix status:**

- **22** ✓ — plugin id mismatch fixed (`shared` everywhere in URL
  paths); 0 grep hits for `/plugins/bb-shared/` remain in code/docs.
- **20** (in flight) — HIGH+MEDIUM security findings from tunnel-secret
  adversarial review. `claim.url` reachable to guests via realtime +
  RPC; RPC path guest-reachability unproven; CF SDK error path can
  leak secrets; deploy-race in tick() bypasses dedupe.

Then:

- **21** — LOW security findings + accepted residuals (polish): doc
  contradictions, health-check sharpening, TLS pinning residual, KV
  plaintext trust-model documentation.

Adversarial review report: `research/tunnel-secret-review.md`. Verdict
CONDITIONAL SHIP — conditions are 20+21.

E2E runbook: `docs/e2e-runbook.md` (17 ✓). Also flagged three known
v0 limitations not blocking ship: guest sidebar doesn't live-update
(WS scope fixed at upgrade, useRealtime is owner-side), revocation is
pull-based (no proactive socket teardown), lazy deploy fires on
`mintToken` only (not `openShareDialog`). All documented in the
runbook.

Separately, whenever you want:

- Adversarial review pass on the tunnel-secret design (codex/sol
  subthread). Two residuals to probe: KV plaintext under local-trust
  assumption, and no TLS-identity pinning beyond the assigned
  `*.workers.dev` origin. Owner 07's `tunnel-secret.ts` has the full
  threat-model comment as the review's starting point.

## Follow-ups / drift captured during rounds 2-4

- 06's `/authz` response has no project scope field, so worker's
  `GuestScope.projectIds` is empty today. Fix owned by **19**.
- 09 kept `defaultKeybindings` / `keybindingOverrides` (ticket only
  named `keybindings` for stripping) and left in-scope projects'
  `sources` fields present (guest is authed for that project). Both
  documented in 09's answer for a future review.
- 16 disables the Copy-URL button after mint (raw bearer isn't
  returned by `listTokens` — correct posture). Thread rows show
  `thread_id` because RPC contract exposes no thread title. Both are
  potential v0.1 polish tickets.
- 12 corrected two selectors from the naive SPEC: `plugin-nav-sidebar-items`
  is a data-testid (not class), `Settings` / `New thread` aria-labels
  are dynamic (need `^=` prefix match). SPEC updated in fa0eb8e.
