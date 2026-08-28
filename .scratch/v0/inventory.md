# bb-shared — open work inventory (2026-08-28)

Snapshot after the post-v0 review, the UX grilling, and the security-fix pass.
Owner side is functional and installs cleanly. Guest transport does not work end
to end yet, so the guest half is untestable. Source of truth stays the per
ticket files in `.scratch/v0/issues/` and the decisions in `ux-refinement.md`.

## Open tickets

- **27 — CF tunnel proxy (HIGH, ship blocker).** `proxyGuestRequest` in
  `worker/src/tunnel/tunnel-do.ts` is a 503 stub, so no guest request or authz
  pull is served. Blocks all end to end guest testing and the e2e runbook's
  guest half. Decision made: keep the hand rolled tunnel and finish the CF side
  as a port of bb's `apps/connect/src/tunnel-do.ts` (~150 to 200 lines). No
  OAuth or framework needed for this.
- **28 — Claim confirmation via Cloudflare OAuth (HIGH).** Design complete in
  `research/claim-confirmation.md`. Build a public OAuth client with PKCE,
  confirm a claim by reading the account through the API, persist
  `cfRefreshToken` + `claimedAccountId` + `scriptName` + `tunnelSecret`, and
  re-resolve the hostname live on start. Depends on 29. Caveat: confirm the
  exact OAuth authorize/token endpoints, scope ids, and refresh token lifetime
  from the CF OAuth API reference or by inspecting `wrangler login`.
- **29 — Device-tied KV encryption (HIGH, prerequisite for 28).** The OAuth
  refresh token is a long lived credential to the owner's real CF account, so
  encrypt the persisted secrets (`cfRefreshToken`, `tunnelSecret`) with a
  device tied key before shipping the OAuth path.
- **26 — Token length floor (LOW, deferred).** One line regex tightening, but
  it churns 32/40 char fixtures across four worker test files. Do it with the
  next worker test pass.

## Incomplete UX from the grilling (decisions locked, not built)

Copy and owner-side pill/popover changes already landed. These remain, each
needing server, worker, or a visual check:

- **Surface 1 — mint deploys first.** Mint should deploy the worker and only
  then return a real link, so `<worker-pending>` never reaches the owner. Ties
  to the worker lifecycle and 27/28.
- **Surface 3 — combined list visual restructure.** The popover copy and the
  contextual create button are done; the full one list layout wants a look in
  the running app.
- **Surface 4 — copy a link again.** Hold the raw link in memory in the plugin
  so Copy link works for the whole session. Needs a server change and a
  contract/RPC addition.
- **Surface 5 — thread titles + copy always enabled.** Resolve each shared
  thread's title in `listTokens` (server + contract + a bb thread title
  lookup). Copy URL always enabled follows from surface 4.
- **Surface 6 — guest experience.** Hide the composer for a read guest (the
  shim must carry the per thread perm), and show a plain page when access has
  ended. Guest side shim/worker; untestable until 27 lands.

## Smaller follow-ups and drift

- **09 response filter cleanup.** `/system/config` still passes
  `defaultKeybindings` / `keybindingOverrides` (only `keybindings` is
  stripped). Worth a pass.
- **v0.1 backlog (in map.md).** Live guest sidebar scope updates on share
  change, push based revocation (close guest sockets on revoke), lazy deploy on
  `openShareDialog`.
- **v1 candidates (in map.md).** TLS fingerprint pinning on the tunnel client;
  best effort delete of the prior generation CF account on redeploy. KV
  encryption and the OAuth claim flow are now tickets 29 and 28.

## Testing gap

The e2e runbook's guest walk through cannot run until 27 lands. Owner side
(plugin RPC, authz endpoint, owner UI, worker deploy attempt) is functional.

## Suggested order

1. The big three, in this order: 29 (encryption) → 28 (OAuth claim), and 27
   (tunnel) in parallel. 27 unblocks all guest testing; 29/28 make claiming
   real. 27 and the 29/28 pair are independent.
2. The server backed UX items (thread titles, copy a link again) — independent,
   low risk, improve the owner console now.
3. Surface 6 and the e2e guest test once 27 is in.
4. 26 whenever the worker tests are touched next.
