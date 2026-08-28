Status: resolved
Type: bug
Severity: critical (deployWorker cannot provision a single account as it stands)
Blocked by:
Found by: CF live-verification spike (2026-08-28)

The always-temp CF deploy pipeline (issue 07) is broken in four independent
places against the LIVE Cloudflare API. Each blocks the deploy on its own, in
pipeline order, so `deployWorker()` today fails at the very first step
(`pow_invalid`) and can never serve a worker. None is catchable by the offline
unit tests, because each is a mismatch with a live-API contract, not with our
own code. All four were isolated and fixed live in the spike; full citations,
exact API responses, and a working reference pipeline are in
[research/cf-live-verification.md](../../research/cf-live-verification.md)
(TASK 1) and `.scratch/spike-cf/live-deploy.mjs`.

## The four bugs

### 1 — PoW solver off by one hash (`plugin/worker-lifecycle/pow.ts`)

`solvePow` seeds the checkpoint chain with the RAW seed (`checkpoints[0] =
seed`). Cloudflare's verifier (authoritative, wrangler
`packages/workers-auth/src/pow.ts:27-38`) seeds it with ONE hash of the seed
(`checkpoints[0] = SHA256(seed)`), so our whole chain is shifted back by one
SHA-256. Live proof: posting our checkpoints returned
`HTTP 403 {"code":1019,"message":"pow_invalid"}`; switching `checkpoints[0]` to
`SHA256(seed)` minted an account on the very next `/previews` call. The PoW unit
tests passed only because they tested the wrong algorithm against itself.

Secondary (not load-bearing): decode the seed as `base64url`, not `base64`, to
match wrangler (`pow.ts:48`). Verified the two decode base64url characters
identically today, so this never breaks in practice — matched anyway to remove
the latent risk.

### 2 — DO migration type wrong for free-plan temp accounts (`plugin/worker-lifecycle/cf-deploy.ts`, `worker/wrangler.toml`)

Temp accounts are on the free plan, where Durable Objects MUST use a
SQLite-backed migration. We upload a legacy `new_classes` migration; live proof:
`HTTP 403 {"code":10097,"message":"In order to use Durable Objects with a free
plan, you must create a namespace using a 'new_sqlite_classes' migration."}`.
`new_sqlite_classes: [doClassName]` uploaded fine. `worker/wrangler.toml` has
the same `new_classes = ["TunnelDO"]` and needs the same change for dev/deploy
parity. `TunnelDO` needs no code change: it uses only the WebSocket hibernation
API, which SQLite-backed DOs fully support (proven live).

### 3 — `cloudflare` SDK v7.1.0 `scripts.update` mis-transmits the module (`plugin/worker-lifecycle/cf-deploy.ts`)

Uploading the (valid, byte-checked ESM) bundle via the pinned SDK returns
`HTTP 400 {"code":10021,"message":"Uncaught SyntaxError: Invalid left-hand side
expression in prefix operation ... at worker.js:1:4"}`. The spike probed both
SDK upload primitives (`new File()` and the SDK's `toFile()`) — both fail
identically, so it is the SDK's multipart shape, not the File wrapper. A raw
multipart `PUT /accounts/{id}/workers/scripts/{name}` (a JSON `metadata` part +
a `worker.js` module part, exactly as wrangler builds it) uploads first try.
Fix: bypass the SDK for the upload and build the multipart PUT directly.

### 4 — the workers.dev route is never enabled per-script (`plugin/worker-lifecycle/cf-deploy.ts`)

`uploadScript` uploads, reads the account subdomain, and CONSTRUCTS
`https://<script>.<sub>.workers.dev` — but never tells Cloudflare to serve the
script there. Live proof: the constructed URL returned Cloudflare's generic 404
HTML page indefinitely. `POST /accounts/{id}/workers/scripts/{name}/subdomain`
`{"enabled":true,"previews_enabled":false}` enables it, then the URL begins
serving after ~12-15 s of route propagation. Fix: add the per-script
subdomain-enable POST after upload, and bake a bounded propagation wait into the
deploy so the URL isn't handed back (or declared unreachable) during that
window.

## Fix

- `pow.ts`: `checkpoints[0] = sha256(seed)`, chain from there; decode seed as
  `base64url`. PoW known-answer test updated to the correct algorithm.
- `cf-deploy.ts`: `new_sqlite_classes`; drop the `cloudflare` SDK from the
  upload and do a raw multipart PUT via the injectable fetch; add the
  subdomain-enable POST and a bounded route-propagation probe before returning.
  Secret redaction (M3, ticket 20) preserved on the new fetch upload path.
- `worker/wrangler.toml`: `new_sqlite_classes = ["TunnelDO"]`.

Where an offline test cannot encode a live-API contract (10021 / 10097 / the
propagation window), that is noted sparingly in a code comment and carried by
this ticket instead.

## Comments

## Answer

All four fixed and verified LIVE end to end through the plugin's own pipeline.

- `plugin/worker-lifecycle/pow.ts`: `checkpoints[0] = sha256(seed)`, chain from
  there; seed decoded as `base64url`. Known-answer PoW test updated to the
  correct algorithm (`worker-lifecycle.test.ts`).
- `plugin/worker-lifecycle/cf-deploy.ts`: dropped the `cloudflare` SDK from the
  upload; the script now goes up as a raw multipart PUT (JSON `metadata` +
  `worker.js` module part) through the injectable fetch. Migration is
  `new_sqlite_classes`. Added the per-script `.../subdomain` route-enable POST
  and a bounded route-propagation probe before the URL is returned. The
  `clientFactory` seam is gone (fetch is the only seam now); secret redaction
  (M3, ticket 20) is preserved on the new upload path and re-covered by the
  redaction test, plus a new happy-path pipeline test asserts the route-enable.
- `worker/wrangler.toml`: `new_sqlite_classes = ["TunnelDO"]` for dev/deploy
  parity.

Tests: plugin 82/82 (was 81; +1 pipeline test), worker 167/167, tsc clean.

### Live evidence (2026-08-28, driver `.scratch/spike-cf/plugin-live-deploy.ts`)

The driver imports and runs the plugin's OWN `deployWorker()` (→ `pow.ts`) +
`bundleWorker()` against live Cloudflare — no CF credentials, no spike code.
Secrets redacted to length.

```
[bundle] built via plugin bundleWorker (31862 bytes)
[deploy] live at https://bb-shared-worker.dog-helicopter.workers.dev
url            : https://bb-shared-worker.dog-helicopter.workers.dev
accountId      : 77a928d1e32f82f717b20c385a47842b   (minted → PoW fix ✓)
apiToken       : <redacted len=53>
tunnelSecret   : <redacted len=43>
accountTtl     : ~59.9 min

HTTPS GET /            -> 401 {"error":"token_missing",...}  (our worker's own gate ran → SQLite DO + raw upload ✓, route propagated ✓)
  content-type: application/json; server: cloudflare
/__tunnel no-upgrade   -> 426 "bb-shared tunnel: expected websocket upgrade"  (TunnelDO instantiated)
/__tunnel wrong bearer -> WS 401 (invalid credential; DO timingSafeEqual ran)
/__tunnel right bearer -> WS 101 Switching Protocols  (DO built a WebSocketPair & accepted)
totalMs: 9633
[RESULT] PASS — HTTPS + WebSocket upgrade verified live
```

The temp account self-expires ~60 min after provision; no cleanup needed.
