# Cloudflare live verification — turning two medium-confidence assumptions into fact

Spike branch `spike/cf-verification`, run 2026-08-28 from `mactom` (open network
egress). Two tasks:

1. **Prove the anonymous temp deploy live, end to end** — no Cloudflare login,
   real worker bundle, real `*.workers.dev` URL.
2. **Pin down the Cloudflare OAuth specifics** the design (`research/claim-confirmation.md`
   §11, §14) left as unverified caveats.

Every fact below is cited: a live API response, a wrangler source `file:line`
(from a fresh `git clone --depth 1 https://github.com/cloudflare/workers-sdk`),
or a doc URL. Reproduction scripts: `.scratch/spike-cf/live-deploy.mjs` and
`.scratch/spike-cf/sdk-upload-probe.mjs`.

---

## TASK 1 — anonymous temp deploy, end to end: **VERIFIED LIVE, but the plugin's
deploy pipeline is currently broken in four independent places**

Headline: the transport works exactly as the spike hoped — an anonymous temp
worker deploys, serves on `*.workers.dev`, and terminates a WebSocket into a
Durable Object, with **no Cloudflare account or credential**. Getting there
exposed **four load-bearing bugs** in the plugin's own deploy code that the
offline unit tests could never catch, because each is a mismatch with the *live*
Cloudflare API. A `deployWorker()` call as the code stands today cannot provision
a single account, let alone serve a worker.

I proved the pipeline by driving the same endpoints the plugin drives
(`/provisioning/previews/challenge` → `/provisioning/previews` → script upload →
subdomain enable), fixing each mismatch as the live API rejected it, and
recording what actually worked.

### The four bugs (each blocks deploy on its own, in pipeline order)

#### Bug 1 — PoW solver is off by one hash (`plugin/worker-lifecycle/pow.ts`) — LOAD-BEARING

The plugin's `solvePow` seeds the checkpoint chain with the **raw seed**:

```
checkpoints[0] = seed
cur = seed; for k segments: cur = SHA256^g(cur); checkpoints.push(cur)
// chain = [ H^0, H^g, H^2g, … ]   (H^0 = seed itself)
```

Cloudflare's verifier (authoritative, from wrangler's own solver
`packages/workers-auth/src/pow.ts:27-38`) starts the chain with **one hash of
the seed**:

```
h = SHA256(seed); checkpoints[0] = h
for k segments: h = SHA256^g(h); checkpoints[j+1] = h
// chain = [ H^1, H^(1+g), H^(1+2g), … ]
```

The plugin's whole chain is shifted back by one SHA-256. **Live proof:** posting
the plugin's checkpoints returned `HTTP 403 {"code":1019,"message":"pow_invalid"}`.
Switching `checkpoints[0]` to `SHA256(seed)` (wrangler's algorithm) → the very
next `/previews` call succeeded and minted an account. The plugin's PoW unit
tests pass only because they test the wrong algorithm against itself.

Fix: `let h = sha256(seed); checkpoints[0] = h;` then chain from `h`.

Secondary, **not** load-bearing: the plugin decodes the seed with
`Buffer.from(seed, "base64")`; wrangler uses `"base64url"`
(`pow.ts:48`). I verified with Node that `Buffer.from(x, "base64")` decodes
base64url characters (`-`/`_`) identically, so this never actually breaks — but
switch to `"base64url"` to match wrangler and remove the latent risk.

Note: the live challenge envelope also carries a field `s` (value `16`) that
neither the plugin's `PowChallenge` type nor wrangler's reads. It is ignored by
both and did not affect a valid solution.

#### Bug 2 — DO migration type wrong for free-plan temp accounts (`plugin/worker-lifecycle/cf-deploy.ts:241-244`, and `worker/wrangler.toml`) — LOAD-BEARING

Temp accounts are on the **free plan**. The plugin uploads the Durable Object
with a legacy (non-SQLite) migration:

```ts
migrations: { new_tag: input.migrationTag, new_classes: [input.doClassName] }
```

**Live proof:** the upload returned
`HTTP 403 {"code":10097,"message":"In order to use Durable Objects with a free
plan, you must create a namespace using a 'new_sqlite_classes' migration."}`.
Switching to `new_sqlite_classes: [doClassName]` → upload succeeded. `worker/wrangler.toml`
has the same `new_classes = ["TunnelDO"]` and needs the same change for dev/deploy
parity.

`TunnelDO` needs **no code change** for this — it uses only the WebSocket
hibernation API (`state.acceptWebSocket` / `getWebSockets`), which SQLite-backed
DOs fully support (proven live below). SQLite DO is now Cloudflare's default/only
option for new namespaces on free.

#### Bug 3 — the `cloudflare` SDK's `scripts.update` mis-transmits the module (`plugin/worker-lifecycle/cf-deploy.ts:218-247`) — LOAD-BEARING

The plugin uploads via the SDK (`cloudflare@^7.1.0`, the pinned dep) with a
`new File([scriptContent], "worker.js", …)` in `files: [...]`. Against the live
API this returns:

```
HTTP 400 {"code":10021,"message":"Uncaught SyntaxError: Invalid left-hand side
expression in prefix operation\n  at worker.js:1:4\n"}
```

The bundle itself is valid ESM (`var __defProp = Object.defineProperty;…`, 31 KiB,
byte-checked), so the SDK is sending the wrong bytes as the module. **I probed
both upload primitives** (`.scratch/spike-cf/sdk-upload-probe.mjs`): `new File()`
**and** the SDK's own `toFile()` helper **both fail identically** with code
10021. So it is not the File wrapper — the SDK v7.1.0 `workers.scripts.update`
multipart shape is incompatible with the current CF Workers upload API.

**A raw multipart `PUT` works first try** — `metadata` part (JSON) + a
`worker.js` part (`Blob`, `application/javascript+module`), exactly as wrangler
builds it (`packages/wrangler/src/__tests__/helpers/mock-upload-worker.ts` shape).
Fix: bypass the SDK for the upload and build the multipart `PUT
/accounts/{id}/workers/scripts/{name}` directly, or upgrade/replace the SDK once
a version whose `scripts.update` matches the live API is confirmed. (The `cloudflare`
SDK subdomain read `subdomains.get` was *not* re-tested; only the script upload
is implicated.)

#### Bug 4 — the workers.dev route is never enabled per-script (`plugin/worker-lifecycle/cf-deploy.ts:257-264`) — LOAD-BEARING

`uploadScript` uploads the script, reads the account subdomain, and **constructs**
`https://<script>.<subdomain>.workers.dev` — but never tells Cloudflare to serve
the script there. **Live proof:** immediately after a successful upload, the
constructed URL returned Cloudflare's generic **HTTP 404** HTML page (19,984
bytes, `server: cloudflare`) indefinitely.

Enabling the route with `POST /accounts/{id}/workers/scripts/{name}/subdomain`
`{"enabled":true,"previews_enabled":false}` → `200 {"enabled":true,…}`, and
after ~12–15 s of propagation the URL began serving the worker. This endpoint is
what wrangler calls when `workers_dev = true`
(`packages/wrangler/src/__tests__/helpers/mock-workers-subdomain.ts:97-115`:
`POST …/scripts/:scriptName/subdomain` with body `{enabled, previews_enabled}`).

Fix: add the per-script subdomain-enable POST after upload, and expect ~15 s of
route propagation before the URL is live (bake into the health-probe/retry
logic; the current code assumes the URL is immediately serving).

### With those four fixes: the deploy is verified end to end

Running the corrected pipeline (`.scratch/spike-cf/live-deploy.mjs`), a full
anonymous deploy completes in **~23 s wall-clock** (PoW ~1.1 s, upload ~0.7 s,
route enable + ~15 s propagation), no credentials at any point.

#### (a) Provisioning envelope — actual shape returned (secrets redacted to length)

Challenge response `POST /provisioning/previews/challenge` (empty body):

```
result: {
  challengeToken : string  (JWT, ~244 chars; payload embeds cid, seed, g, s, k, iat, exp)
  seed           : string  (43-char base64url → 32 bytes)
  k              : number  (observed 1000)
  g              : number  (observed 2000  → k*g = 2,000,000, well under the 64M cap)
  s              : number  (observed 16;  read by neither the plugin nor wrangler)
  expiresAt      : number  (unix SECONDS; challenge ~120 s TTL)
}
success: true, errors: [], messages: []
```

Provision response `POST /provisioning/previews`:

```
result: {
  account: {
    id        : string  (32 hex chars)
    name      : string  (random human-word slug, e.g. length 15–21)
    type      : string  ("standard")
    apiToken  : string  (bearer, 53 chars)              ← SECRET (redacted)
    tokenId   : string  (32 hex chars)
    expiresAt : string  (ISO-8601, no ms, e.g. "2026-08-28T06:50:39Z")
  },
  claim: {
    token     : string  (43-char base64url)             ← SECRET (redacted)
    url       : string  (96 chars — see (d))
    expiresAt : string  (ISO-8601 WITH ms, e.g. "2026-08-28T06:50:39.141Z")
  }
}
success: true
```

This matches the `ProvisionedAccount` interface in `cf-deploy.ts:166-176` exactly
(all fields present; `account.name` is present and required, which wrangler also
enforces at `temporary.ts:211-223`). Note the two `expiresAt` fields differ in
precision (account: second precision, no ms; claim: millisecond precision).

#### (b) Does the worker serve? — YES, our real code runs

- `GET /` on the live URL →
  `HTTP 401 {"error":"token_missing","detail":"no bb-shared token in path, query,
  or session cookie — this URL was not shared with you"}`
  (`content-type: application/json`). That is the bb-shared worker's own token
  gate executing — not a Cloudflare page. A guest with no token is correctly
  rejected. (401 is sub-500, so the plugin's `healthCheck()` counts it as alive.)
- **WebSocket + Durable Object, end to end** (`GET /__tunnel`, forced HTTP/1.1):
  - no upgrade header → `426 "bb-shared tunnel: expected websocket upgrade"`
    (emitted from inside `TunnelDO.acceptTunnel`, so the SQLite DO instantiated
    and ran)
  - wrong bearer + ws upgrade → `401 "bb-shared tunnel: invalid credential"`
    (the DO's `timingSafeEqual` against `env.TUNNEL_SECRET` ran)
  - correct bearer + ws upgrade → **`HTTP/1.1 101 Switching Protocols`** with a
    valid `Sec-WebSocket-Accept` header — the DO built a `WebSocketPair` and
    accepted the hibernatable socket.

  This is direct, live confirmation of the two things `research/cf-temp-deployments.md`
  could only assert by inference: **WebSocket upgrades and Durable Objects both
  work on an anonymous temp deployment.** (Full guest→owner proxying still awaits
  the issue-14 local half; only the tunnel accept side exists in the worker
  today, which is exactly what deployed and worked.)

#### (c) Account / claim TTL — ~60 minutes, confirmed

Both `account.expiresAt` and `claim.expiresAt` land **~60.0 minutes** after
provision (measured 59.95–59.97 min, the shortfall being request latency). So the
"60-minute unclaimed lifetime" the whole claim design hangs on is real and
precise, and the account and claim windows expire together. The survival-probe
timing in `research/claim-confirmation.md` §2 (probe at `expiresAt + CONFIRM_MARGIN`)
rests on a verified 60-min deadline.

#### (d) claim.url format — confirmed

```
https://dash.cloudflare.com/claim-preview?claimToken=<43-char base64url token>
```

Origin `https://dash.cloudflare.com`, path `/claim-preview`, single query param
`claimToken`. This confirms the format asserted in `research/claim-confirmation.md`
§1.1 verbatim. It is a browser dashboard deep link (no API/callback), consistent
with the "no claim-status API" finding.

### What TASK 1 changes for ticket 28

- **Nothing in ticket 28's *design* is invalidated** — the 60-min TTL, the
  claim.url shape, and the WS+DO transport premise are all confirmed. If
  anything, the design's foundation is firmer.
- **But ticket 28 builds on a deploy pipeline (issue 07) that does not work
  against live Cloudflare.** The four bugs above must be fixed before any
  claim-confirmation or OAuth behaviour can be exercised for real; today
  `deployWorker()` fails at the very first step (`pow_invalid`). These are
  prerequisites, filed here so they are not rediscovered at integration time.
- The **~15 s workers.dev route-propagation delay** (Bug 4) is new information
  for the health/first-serve logic and the UX "deploying…" state.

---

## TASK 2 — Cloudflare OAuth specifics: **mostly VERIFIED; two items remain open**

wrangler performs authorization-code + PKCE against Cloudflare today; its OAuth
logic now lives in the shared package `@cloudflare/workers-auth`
(`packages/workers-auth/src/…` in workers-sdk). These are the authoritative,
live-in-production values.

### Authorize URL — VERIFIED
`https://dash.cloudflare.com/oauth2/auth`
(`packages/workers-auth/src/env-vars.ts:32-35`, domain default `dash.cloudflare.com`
at `env-vars.ts:16-22`; query assembly at
`packages/workers-auth/src/generate-auth-url.ts:31-49`). Staging domain is
`dash.staging.cloudflare.com`.

### Token endpoint URL — VERIFIED
`https://dash.cloudflare.com/oauth2/token` — used for **both** the auth-code
exchange and the refresh exchange
(`packages/workers-auth/src/env-vars.ts:45-48`;
`packages/workers-auth/src/token-exchange.ts:300-332`).
Revoke endpoint: `https://dash.cloudflare.com/oauth2/revoke` (`env-vars.ts:58-61`).

### Scope identifiers — VERIFIED, and the design's names were WRONG
The design (`claim-confirmation.md` §11.1, ticket 28) used `workers-platform.read` /
`workers-platform.write`. **Those are not real Cloudflare scopes.** The real
format is `resource:action` (colon), verbatim from wrangler's catalog:

- Workers write (read+write): **`workers:write`** — "See and change Cloudflare
  Workers data such as zones, KV storage, namespaces, scripts, and routes"
  (`packages/workers-auth/src/core/scopes.ts:12-13`).
- Workers read: **`workers:read`** (`packages/workers-auth/src/cf/scopes.ts:88`).
  Note wrangler's own login set uses `workers:write` plus narrower scopes rather
  than a bare `workers:read`.
- Account list/read: **`account:read`** (`core/scopes.ts:8-9`).
- **workers.dev subdomain read: no dedicated scope exists.** Subdomain management
  is bundled into **`workers_scripts:write`** — "…scripts, durable objects,
  **subdomains**, triggers, and tail data" (`core/scopes.ts:18-19`). So reading /
  setting the workers.dev subdomain rides on `workers:read` / `workers_scripts:write`,
  not a standalone identifier.
- `offline_access` is appended automatically to every authorize request to get a
  refresh token (`generate-auth-url.ts:44-45`, `core/scopes.ts:52-56`).

Minimum viable set for this plugin's needs (list accounts, read a worker's
subdomain, update/delete a script): `account:read`, `workers:read`,
`workers_scripts:write` (+ auto `offline_access`). Make `workers_scripts:write`
an **optional scope** so a read-only owner can decline write (Cloudflare added
optional scopes — changelog
https://developers.cloudflare.com/changelog/post/2026-08-20-oauth-optional-scopes/).

### Client registration `POST /accounts/{id}/oauth_clients` — VERIFIED (docs)
Source: https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/

Request body: required `client_name`, `grant_types` (`["authorization_code"]`),
`redirect_uris` (array), `response_types` (`["code"]`), `token_endpoint_auth_method`,
`scopes` (array). Optional: `optional_scopes`, `post_logout_redirect_uris`,
`logo_uri`, `policy_uri`, `tos_uri`, `client_uri`, `allowed_cors_origins`.
`token_endpoint_auth_method` for a **public PKCE client = `none`**.

Response: `client_id` always; `client_secret` **only for confidential clients** —
a public/PKCE client receives **no secret** (so nothing secret ships in the
plugin). Setting a client public is permanent. Only the authorization-code grant
is supported for third-party clients (no device/implicit/client-credentials);
PKCE is required and must be **S256** (wrangler sends `code_challenge_method=S256`,
`generate-auth-url.ts:48`).

### Flow shape — VERIFIED (matches the §11.2 design)
- Authorize params: `response_type=code`, `client_id`, `redirect_uri`, `scope`
  (space-joined + `offline_access`), `state`, `code_challenge`,
  `code_challenge_method=S256` (`generate-auth-url.ts:39-48`).
- Auth-code exchange body: `grant_type=authorization_code`, `code`, `redirect_uri`,
  `client_id`, `code_verifier` — **no** client_secret (`token-exchange.ts:243-249`).
- Redirect target: a fixed loopback, wrangler uses
  `http://localhost:8976/oauth/callback`
  (`packages/workers-auth/src/wrangler/constants.ts:23`) — confirms the design's
  `http://127.0.0.1:<port>/oauth/callback` shape.
- wrangler's own shipped production `client_id` is
  `54d11594-84e4-41aa-b438-e81b8fa78ee7`
  (`packages/workers-auth/src/wrangler/env.ts:17-22`). The plugin registers and
  ships **its own** client_id; this only proves the live flow.

### Refresh token — rotation VERIFIED, lifetime NOT
- Refresh exchange: `grant_type=refresh_token`, `refresh_token`, `client_id` (no
  secret) at the token URL (`token-exchange.ts:134-156`).
- **Rotation: Cloudflare MAY issue a new `refresh_token` on each exchange.**
  wrangler stores the new one if present and keeps the old one if absent
  (per RFC 6749 §6): `token-exchange.ts:203-213`. The backend is Ory Hydra with
  refresh-token rotation + a grace period, so a retried refresh does not break the
  chain (https://blog.cloudflare.com/oauth-for-all/). **Design must persist a
  rotated refresh token when the response includes one.**
- **Lifetime: could not verify a concrete TTL.** Not in the OAuth docs, not in the
  changelog, not hardcoded in wrangler (which only reads the *access* token's
  `expires_in`, `token-exchange.ts:189-194`). **Still an open caveat.**

### `GET /client/v4/oauth/scopes` unauthenticated — tried, requires auth
```
HTTP 400 {"success":false,"errors":[{"code":9106,"message":"Missing X-Auth-Key,
X-Auth-Email or Authorization headers"}],"result":null}
```
The endpoint exists but needs credentials; it cannot enumerate scopes
anonymously. (The scope catalog above came from wrangler source + the create-client
doc instead. The `/fundamentals/oauth/scopes/` doc page 404s — there is no
standalone published scope list.)

### What TASK 2 changes for ticket 28
- Replace the placeholder scope names `workers-platform.read/.write` with the real
  `account:read` + `workers:read` + `workers_scripts:write` (write optional).
  There is **no** standalone workers.dev-subdomain scope; it is covered by
  `workers_scripts:write`.
- Hardcode the two endpoints (`…/oauth2/auth`, `…/oauth2/token`) and revoke
  (`…/oauth2/revoke`); use `token_endpoint_auth_method: "none"`, S256 PKCE,
  loopback `http://127.0.0.1:<port>/oauth/callback`. Caveat #1 of ticket 28's
  "Two caveats carried forward" is now **closed** for authorize/token URLs and
  scope identifiers.
- Refresh-token **rotation must be handled** (store the new token when returned).
  Refresh-token **lifetime remains undocumented** — the one part of caveat #1
  still open.

---

## Residual open items (not closed by this spike)

- **Refresh-token lifetime** (seconds/days): undocumented and not in wrangler
  source. Rotation-with-grace is confirmed; the absolute TTL is not.
- **Hostname-on-claim empirical test** (`claim-confirmation.md` §10.3): still not
  run — it requires actually claiming a temp worker into a real CF account (two
  accounts, one existing with its own subdomain). That is explicitly out of scope
  here (needs the owner's account and a real login). The structural inference
  (hostname changes when claimed into an existing account) stands unverified; OAuth
  live-hostname discovery (§11.3) makes correctness independent of it, but guest-URL
  survival across a claim is still unknown.
- Full guest→owner request **proxying** through the tunnel awaits the issue-14
  local half; only the worker's tunnel-accept side was exercised.
