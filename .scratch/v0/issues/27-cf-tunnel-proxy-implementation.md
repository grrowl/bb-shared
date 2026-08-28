Status: open
Type: task
Severity: high (correctness / ship-blocker)
Blocked by:
Found by: post-v0 adversarial review (2026-08-28)

CF-side tunnel proxy is an unimplemented 503 stub — guest access is
non-functional end-to-end. Resolve the "v0 COMPLETE" drift.

## The defect

`worker/src/tunnel/tunnel-do.ts:123-140` — `proxyGuestRequest` returns
`offlineResponse()` (503, `x-bb-tunnel-offline: 1`) UNCONDITIONALLY, even when a
tunnel WS is connected. The whole CF-side wire protocol is a `TODO(14)`:
allocate streamId, encode `open-http`/`open-ws` via bb-shared-tunnel-contract,
stream body chunks, reassemble `resp-head` + body frames, pump ws-data both
ways for upgrades.

`do-router.ts` routes every `dispatch` to this DO, and the `/authz` pull also
rides the tunnel, so guests get 503 on literally everything.

`worker/README.md:22` documents the stub, but `.scratch/v0/map.md` marks issue
14 ✓ and the milestone "v0 COMPLETE". The LOCAL half
(`packages/bb-shared-tunnel-client` `SharedTunnel`/`TunnelSession`) exists; its
CF counterpart was never ported. The two must land together.

## Impact

The e2e runbook's guest walk-through (issue 17) cannot pass. Owner-side
(plugin RPC, `/authz` endpoint, owner UI, worker deploy) works; the guest half
does not.

## Direction

**Pending research** (owner asked: "we hand-rolled a lot — isn't there a
Cloudflare library we can rely on?"). A research pass is evaluating whether to
replace the hand-rolled DO frame protocol with a CF-native / off-the-shelf
option vs. finishing the hand-rolled protocol, under the hard constraint of
anonymous CF temp-deployment (no CF account). The recommendation will be pasted
into this ticket's Answer before implementation starts — do NOT start coding
the hand-rolled protocol until that decision is recorded here.

Whatever transport is chosen, it must land BEFORE or WITH the authz fixes
(23/24): this DO is the wire that carries every guest request the authz gate
protects, so a broken gate + a live tunnel is the dangerous combination to
avoid shipping.

## Also fix

Correct `.scratch/v0/map.md`: the guest transport is NOT complete; downgrade
the "v0 COMPLETE" / issue-14 ✓ claims to reflect the stub.

## Comments

## Answer

**Decision (research 2026-08-28): keep the hand-rolled tunnel. Finish the
CF-side frame protocol as a mechanical port of bb's own
`apps/connect/src/tunnel-do.ts`. Do NOT adopt cloudflared or a DO WS
framework.**

Rationale — the worker is not a dumb pipe. Per SPEC it does per-request token
auth, response filtering, mutation gating, WS frame filtering, and index.html
chrome rewriting. Any off-the-shelf "expose localhost" tunnel has nowhere to
run that logic, which eliminates the whole category:

- **cloudflared / Cloudflare Tunnel** — quick tunnels (`*.trycloudflare.com`)
  are account-free but expose localhost DIRECTLY to CF's edge with no worker in
  the path (nowhere for the gate/filter/shim). Named tunnels can sit behind a
  worker but need a CF account + zone + API token — violates the anonymous
  temp-deploy constraint. Even the 2026 Sandbox-SDK tunnel uses named tunnels.
  No "anonymous named tunnel behind your own anonymous worker" exists.
- **partyserver / PartySocket / Hono WS** — solve connection lifecycle, not
  stream multiplexing. This DO is a singleton with one upstream socket; room
  routing/broadcast is irrelevant. Bundling them adds bytes to the
  size-constrained temp-deploy script for ~no use.
- **Hibernatable WebSockets API** — not a library to adopt; `tunnel-do.ts`
  already uses it (`state.acceptWebSocket`, `webSocketMessage`).
- The irreducible hard part — multiplexing arbitrary concurrent HTTP+WS guest
  streams over ONE owner socket — is exactly what `bb-shared-tunnel-contract`
  (`streamId` demux, `open-http`/`body-chunk`/`resp-head`/`open-ws`/`ws-data`)
  already does. No CF-native library provides this; a custom frame protocol is
  fundamentally required, not not-invented-here. (Precedent: Stellate hand-
  rolled the same WS-over-DO reverse proxy and never released it as a library.)

The CF primitives to lean on are the ones already in the code: the DO
Hibernatable WS API (worker side) and Node `ws` (local side, already used in
the vendored client). The local half (`packages/bb-shared-tunnel-client`
`session.ts`) is complete and battle-tested — the ONLY gap is the CF/DO relay
side, ~150–200 lines mirroring the local protocol, with upstream
`apps/connect/src/tunnel-do.ts` as a line-for-line reference:

1. allocate a `streamId`
2. encode `open-http` (or `open-ws`) via the contract, send on the tunnel WS
3. stream request body as `body-chunk`, terminate with body-end
4. collect `resp-head` + `body-chunk` back, build a `Response`
5. for WS upgrades, mint a visitor `WebSocketPair` and pump `ws-data` both ways

Compat notes: no new workerd/wrangler flags needed (WS + DO + hibernation
already confirmed on temp deployments). Keep the vendored `PROTOCOL_VERSION`
lockstep in sync (the real maintenance cost, unchanged by this decision).
Highest-leverage guidance for the implementer: make the CF side a mechanical
mirror of bb's `apps/connect/src/tunnel-do.ts` so both halves stay
bug-compatible, exactly as the scaffold TODO intends.

Sources: TryCloudflare & cloudflared docs, CF Workers WebSockets docs,
partyserver npm, anderspitman/awesome-tunneling, Stellate serve writeup.
