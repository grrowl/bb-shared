Status: resolved
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

---

## Implementation (2026-08-28) — RESOLVED

Ported bb's `apps/connect/src/tunnel-do.ts` into
`worker/src/tunnel/tunnel-do.ts`, replacing the unconditional 503 stub. The
port is faithful and mechanical, trimmed only of the bits bb-shared does not
need (no D1/presence/machine bookkeeping; no `target` port-sharing — bb-shared
is one worker per bb instance, so every stream routes to the single loopback
origin and the DO never sets a `target` on any frame).

What landed:

- `proxyGuestRequest` now splits on the `upgrade` header: HTTP → `proxyHttp`,
  WebSocket → `openVisitorWebSocket`. Both allocate a `streamId` and multiplex
  over the one owner tunnel socket via `@bb-shared/tunnel-contract`.
- HTTP: `open-http` (method/path/forwardable headers/hasBody) → request body
  streamed as `body-chunk` + `body-end` → `resp-head` + `body-chunk`/`body-end`
  reassembled into a streamed `Response` (`relayedResponse`, `encodeBody:
  "manual"` so bb's own content-encoding survives). 204/205/304 resolve
  bodiless; hop-by-hop headers stripped both ways; `RESP_HEAD_TIMEOUT_MS`
  guards a silent tunnel; visitor cancel → `close-stream`.
- WS: `open-ws` (+ echoed first subprotocol) → visitor `WebSocketPair`, tagged
  `visitor:<streamId>` with the id in its serialized attachment; `ws-data`
  pumped both directions; `close-stream` tears down.
- Cleanup/backpressure: `abandonStreams` fails in-flight HTTP 502 and closes
  visitors on tunnel close/replace; `webSocketClose` for a visitor sends
  `close-stream` upstream. Hibernation-safe: stream ids resume above surviving
  visitor attachments; a `WebSocketRequestResponsePair` auto-response answers
  heartbeats without waking the DO.
- Pipeline order preserved: the proxy is the terminal transport; extractToken →
  routeLockouts → authzStage → wsFrameFilter → responseFilters → chromeShim +
  dispatch all run ahead of it unchanged. (The `/authz` pull itself rides this
  same relay — see the live evidence below, where the stub bb receives the
  authz probe before the guest request.)

The worker sits outside the npm workspace, so the vendored contract is reached
via a tsconfig `paths` alias `@bb-shared/tunnel-contract`; both `tsc` and
wrangler's esbuild honour it (confirmed by a `--dry-run` bundle), and
`vitest.config.ts` mirrors it.

### Tests

`worker/tests/tunnel-do.test.ts` — 20 unit tests driving `TunnelDO` with a
mocked `DurableObjectState` + fake hibernatable WebSocket, using the REAL
vendored `encodeFrame`/`decodeFrame` so every assertion is against exact wire
bytes. Covers open-http framing + hop-by-hop stripping, request-body chunking,
resp-head/body reassembly into a streamed Response, 204 bodiless, close-stream
→ 502, distinct stream ids, tunnel-close teardown, WS passthrough (open-ws,
ws-data both ways, close-stream), stream-id resume across hibernation, dial
auth + replace-abandons-streams. Full worker suite **187 green**, plugin
**82 green**, `tsc` clean across worker/plugin/packages.

### Live e2e verification (real anonymous CF temp deploy)

Driver: `.scratch/spike-cf/e2e-tunnel-proxy.ts`. It bundles the worker
(`bundleWorker`), deploys it anonymously through the plugin's own
`deployWorker` (no CF account), starts a local stub bb (HTTP + WS) behind the
real `SharedTunnel` client, then makes a guest HTTP request and a guest WS
connection to the live `*.workers.dev` URL. No running bb needed — the stub
answers the worker's `/authz` probe "allow", then serves the guest request.

Result (redacted; worker URL is an ephemeral temp deploy, dead ≤60 min):

```json
{
  "workerUrl": "https://bb-shared-e2e.<sub>.workers.dev",
  "tunnelState": "connected",
  "http": {
    "status": 200,
    "xStubBb": "1",
    "body": "HELLO-FROM-STUB-BB GET /api/v1/e2e-probe",
    "bodyMatched": true,
    "sawAuthzProbe": true,
    "sawGuestReq": true
  },
  "ws": { "ok": true, "reply": "echo:ping-over-tunnel", "replyMatched": true },
  "stubHits": [
    { "method": "GET", "url": ".../authz?token=[redacted]&path=%2Fapi%2Fv1%2Fe2e-probe&method=GET", "origin": "http://127.0.0.1:<port>" },
    { "method": "GET", "url": "/api/v1/e2e-probe", "origin": "http://127.0.0.1:<port>" },
    { "method": "GET", "url": ".../authz?token=[redacted]&path=%2Fapi%2Fv1%2Fe2e-ws&method=GET", "origin": "http://127.0.0.1:<port>" },
    { "method": "WS",  "url": "/api/v1/e2e-ws", "origin": "http://127.0.0.1:<port>" }
  ],
  "result": { "httpOk": true, "wsOk": true }
}
```

What this proves end to end: a guest HTTP request round-tripped worker → tunnel
→ stub bb → back (200, custom header + body intact), AND a guest WebSocket
round-tripped both ways (`echo:ping-over-tunnel`). The `origin` on every stub
hit is the loopback `127.0.0.1:<port>`, confirming the vendored
`headersForLoopbackRequest` rewrite fires (the worker's public origin was
rewritten before hitting the stub — the load-bearing constraint from SPEC
§"Local tunnel client"). The two `/authz` probes prove the authz pull rides the
same relay ahead of dispatch, i.e. the pipeline order is intact.

(Driver note, not a product issue: `deployWorker`'s propagation wait uses an
`unref`'d timer, so a bare script can loop-drain and exit before the deploy
resolves; the driver holds a ref'd keep-alive interval. Irrelevant inside the
plugin, which has a live event loop.)

### Remaining

- Walking `docs/e2e-runbook.md`'s guest half against a REAL local bb instance
  (install plugin → mint token → guest browser) is left as remaining: it needs
  a running bb + a real browser session and is not straightforward headless.
  The transport it exercises is now proven with the stub above, which the
  ticket explicitly prefers. No transport work is blocked on it.
- Affects tickets 28/29 & surface 6: the guest transport they build on is now
  live. See the final summary for specifics.
