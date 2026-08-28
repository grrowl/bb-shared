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
- v1 candidate: encrypt KV values with a device-tied key (macOS Keychain,
  etc.), prioritising the CF `apiToken` (the crown-jewel at-rest item — see
  21 / SPEC §"Trust model"). Also v1 candidates: TLS-fingerprint pinning
  (L3), best-effort delete of the prior-gen CF account on redeploy (L4).

## Status — v0 owner-side complete; guest transport NOT complete

All 21 delivery tickets were resolved and an adversarial review passed, BUT a
post-v0 review (2026-08-28, on installing to test) found the earlier
"v0 COMPLETE" claim overstated: the CF-side tunnel proxy is an unimplemented
503 stub, so guest access does not work end-to-end. Owner-side (plugin RPC,
`/authz` endpoint, owner UI, worker deploy) is functional and installs cleanly.

Resolved: 01–12, 14–22. Reopened as post-v0 findings: 23–27 (below).

- E2E runbook at `docs/e2e-runbook.md` (guest half currently unrunnable — 27).
- Adversarial review at `research/tunnel-secret-review.md`.
- Trust model documented in SPEC §"Trust model".
- Git history is per-ticket commits (one mixed commit `8c37eb1` from
  round-3 `git add -A` race, noted at the time and left as-is).

## Post-v0 findings (2026-08-28 review, filed as tickets)

Install-blocker already fixed in the working tree: `authz` route path lacked a
leading `/` (bb 0.40 rejects it) → `plugin/authz/authz.ts` `AUTHZ_ROUTE_PATH`
now `/authz`. Not yet committed.

- **23 — authz mutation gate deny-by-default (CRITICAL). RESOLVED.** `computeAuthz`
  allows ANY non-thread path regardless of method/perm; no worker mutation
  gate. read-guest → other-plugin RPC → code exec; write-guest → any thread
  mutation, not just `/send`. SPEC is right; allowlist must be per-(method,
  path). Open Q: does `/send` also need body filtering?
- **24 — `/projects/{p}` scope enforcement (HIGH). RESOLVED.** Authz denies
  out-of-scope projects and gates project-nested thread paths as threads, and
  the worker `filterProjectDetail` scopes an in-scope project body's
  `threads`/`sections` to the token. Owner ruling: a project's `sources` (repo
  paths) are fine to show for a project the guest can see, since a project is
  only in scope when the token holds a thread in it; a project with no shared
  thread is never shown. So sources are kept in both filters.
- **25 — response-filter trailing-slash bypass (MEDIUM). RESOLVED.**
  `matchResponseFilter` now strips the trailing slash before matching, so
  `/api/v1/plugins/` hits the empty filter instead of leaking the inventory.
- **26 — token length floor (LOW). DEFERRED.** One-line regex fix, but it
  churns 32/40-char worker test fixtures; not worth it for a non-exploitable
  LOW right now.
- **27 — CF-side tunnel proxy (HIGH / ship-blocker).** `proxyGuestRequest` is a
  503 stub; guest transport unimplemented. Research pending on
  CF-native vs hand-rolled before implementation.

## v0.1 backlog

Captured from ticket answers during v0 delivery:

- **UX polish** — thread rows show `thread_id` instead of thread title
  (RPC contract exposes no title; noted by 16). Copy-URL only works
  for session-minted tokens (raw bearer isn't returned by `listTokens`;
  correct posture per SPEC, but a UX gap; also noted by 16).
- **Live guest sidebar** — guest's WS scope is fixed at upgrade;
  `useRealtime` is owner-side only. Guests need a reload when shares
  change. Fix: teach worker's WS filter to accept scope updates via
  a control frame, or expose a lightweight guest-side "refresh" hint.
  (Noted by 17.)
- **Push revocation** — currently pull-based; enforcement is at the
  next request/reload. Guests with an already-rendered tab stay
  functional until refresh. Fix: worker proactively closes sockets on
  token/share revocation. (Noted by 17.)
- **Lazy deploy on `openShareDialog`** — SPEC allows this alongside
  `mintToken`; only mint triggers today. First-share UX cost.
  (Noted by 17.)
- **Response-filter cleanup** — 09 kept `defaultKeybindings` /
  `keybindingOverrides` in `/system/config` (ticket named only
  `keybindings` for stripping) and left in-scope projects' `sources`
  fields present. Worth a review pass. (Noted by 09.)

## v1 candidates (from security review)

- **KV encryption** with a device-tied key (macOS Keychain / equivalent).
  `apiToken` is the crown-jewel at-rest item — attacker with it can
  redeploy a malicious worker under our name, making tunnel-secret
  rotation moot.
- **TLS-fingerprint pinning** on the tunnel client's outbound to
  `*.workers.dev` — captures the initial cert fingerprint, rejects
  drift. Closes the CF-account-control MITM path (L3 residual).
- **Best-effort delete of prior-gen CF account on redeploy** — L4
  residual. Currently the prior worker returns 5xx until CF reclaims
  the unclaimed account (≤60 min).
- **OAuth-based claim flow** — captures the claimed CF account and
  keeps managing under it, replacing the fire-and-forget claim.url
  nudge with a real state machine (spike 01 called this out; SPEC
  positions it as v2).

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
