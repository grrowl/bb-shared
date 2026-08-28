# Adversarial security review — tunnel-secret design

Scope: the tunnel handshake secret and everything that touches it, mint → persist
→ inject → transmit → check → rotate. Read-only review; no code changed.

Reviewer basis: `plugin/worker-lifecycle/{tunnel-secret,worker-lifecycle,cf-deploy,
worker-record}.ts`, `plugin/lib/shared-tunnel.ts`, `plugin/server.ts`,
`worker/src/tunnel/{tunnel-do,interface}.ts`, plus SPEC.md and `.scratch/v0/map.md`.

---

## Executive verdict — **CONDITIONAL SHIP**

The core handshake-secret design is sound for v0's stated local-trust model. 256
bits of CSPRNG entropy, fresh-per-deploy rotation, secret-text binding, a
non-short-circuiting compare, and fail-closed mismatch behaviour are all correct.
The four threats the ticket calls out (worker impersonation, deploy-log leak,
replay, cross-owner reuse) are adequately handled **as described in the header**.

However, the review surfaced one issue that is **not** about the tunnel secret
itself but about a *different, higher-value bearer that rides the same lifecycle*:
the CF `claim.url`. It is an account-takeover credential and it is currently
placed into a realtime broadcast payload and an RPC response whose guest-isolation
the SPEC itself still lists as unverified (open Q #3, "realtime frame filter
fidelity — still open"). That must be closed before guests are ever let near the
worker.

Ship conditions:

1. **[H1]** Remove `claim.url` (and ideally `claim` entirely, plus `url`) from the
   `worker-changed` realtime broadcast payload. Surface the claim affordance only
   through an explicit owner-authenticated pull, and add a positive test that no
   plugin realtime channel is relayed to a guest WS. (Do not rely on the WS
   allowlist alone for an account-takeover bearer.)
2. **[M2]** Confirm — with a test — that `getWorkerStatus` (and every bb plugin
   RPC) is unreachable through the worker's guest proxy. If the RPC transport is
   reachable, a guest reads `claim.url` and takes the CF account.
3. **[M3]** Prove the CF SDK / `api.cloudflare.com` error path never serializes
   the `secret_text` binding values into an `Error.message` that reaches
   `bb.log`. If unprovable, scrub deploy error strings before logging.
4. Accept-and-document (or fix) the KV-plaintext and no-TLS-pinning residuals as
   explicit v0 posture, and confirm bb's `bb.storage.kv` enforces per-plugin
   isolation (M5 open question).

Everything else is low/informational.

---

## Findings (most severe first)

### H1 — Account-takeover bearer (`claim.url`) is put on a broadcast channel
**Category:** secret-handling / excessive exposure · **Severity:** HIGH

`WorkerLifecycle.getStatus()` returns `claim: { url, expiresAt }`
(worker-lifecycle.ts:157). `publish()` feeds that exact object to
`publishStatus`, which in `server.ts:179-181` calls
`bb.realtime.publish(REALTIME_CHANNELS.workerChanged, status)`. So the CF
`claim.url` — a **bearer that lets anyone who holds it claim/take ownership of the
temp CF account** (SPEC: "`claim.url` is a bearer credential — never send to
guests, never log") — is emitted on the `worker-changed` realtime channel on
*every* state transition, and is also returned by the `getWorkerStatus` RPC
(server.ts:278-280).

Whether a guest actually receives it depends entirely on the worker's WS
broadcast filter and RPC gating. The SPEC's own map.md still lists "Realtime frame
filter fidelity … spike 03 — still open" (open Q #3), i.e. the containment this
relies on is not yet verified. A bearer of this value must not depend on a filter
the team has flagged as incomplete.

**Exploit sketch:** attacker = a guest with a valid low-privilege (read) token.
Guest's browser holds an authenticated WS to the worker, which tunnels to the
owner's bb. If the WS broadcast allowlist does not explicitly drop the
`worker-changed` channel (it enumerates `thread:*` events; a plugin channel is
easy to miss), the guest receives a `worker-changed` frame containing
`claim.url`. Guest opens it → claims the CF account → now owns the worker: can
redeploy arbitrary worker code, read future guest traffic, and persist access
past the 60-min TTL. Same outcome if `getWorkerStatus` RPC is reachable through
the proxy (see M2).

**Impact:** full compromise of the owner's deployed worker and CF temp account by
any guest, including read-only guests.

**Mitigation:** do not place `claim.url` in the broadcast projection at all. The
realtime payload needs only `{ state, healthy, url?, expiresAt?, tunnel? }` —
strictly the fields the live-status UI renders. Deliver the claim URL through a
dedicated owner-only RPC that is provably not proxied to guests, and add a
regression test asserting the `worker-changed` payload contains no `claim`.
Defence-in-depth: keep the WS-filter fix too, but the bearer should never be in
the payload regardless.

---

### M2 — Guest-reachability of the `getWorkerStatus` RPC is unproven
**Category:** access-control / missing-negative-test · **Severity:** MEDIUM (HIGH if reachable)

`getWorkerStatus` returns `claim.url` (server.ts:278). The SPEC's guest response
matrix covers `/api/v1/plugins` (`[]`), `/api/v1/plugin-settings/*` (empty), and a
deny-by-default mutation gate — but it does not explicitly name the plugin **RPC
transport path** or the **realtime subscribe** path. If bb serves plugin RPC over
a route the worker's deny-by-default gate doesn't cover (or the SPA's RPC channel
is proxied verbatim), a guest can call `getWorkerStatus` directly and read the
claim bearer, independent of H1's broadcast path.

**Exploit sketch:** guest issues the same RPC envelope the owner SPA uses against
whatever path bb exposes plugin RPC on. Worker forwards it (not in the explicit
deny list) → plugin answers with `claim.url`. → account takeover as in H1.

**Mitigation:** add an explicit worker-side denial for the plugin RPC + realtime
paths for guest tokens, and a test that a guest token calling `getWorkerStatus`
gets 403. Combined with H1 (removing the bearer from the payload) this is
belt-and-braces.

---

### M3 — Tunnel/authz secrets may leak via CF deploy error messages
**Category:** secret-leak-via-logs · **Severity:** MEDIUM

The raw `tunnelSecret` and `authzToken` are passed as `text` inside the
`bindings` array of the `client.workers.scripts.update(...)` request body
(cf-deploy.ts:190-199). If that SDK call — or a lower-level `fetch` error inside
the `cloudflare` SDK — throws an error whose `message` serializes the request
body or params (several HTTP SDKs echo request context in error strings), that
message propagates up through `deployWorker`'s `catch` and lands in
`worker-lifecycle.ts:287-289` (`this.deps.log.error(... ${err.message})`) and in
`cf-deploy.ts:278-286` (`opts.log?.warn(... ${message})`). The header's claim
"never written to `bb.log`" is only true if no error path ever embeds the binding
values.

**Exploit sketch:** a malformed-but-non-network deploy (e.g. CF returns a
validation 4xx that the SDK renders by including the submitted metadata) →
`err.message` contains `TUNNEL_SECRET`'s value → written to bb.log →
readable by anyone with log access (and logs are often less protected than
`bb.db`, sometimes shipped off-box).

**Mitigation:** never interpolate raw SDK/HTTP errors from the upload step into a
log line without scrubbing. Wrap `uploadScript` so its thrown errors carry only a
status/code, not the request body. Add a test that feeds a synthetic SDK error
containing the secret and asserts the logged string does not contain it.

---

### M4 — Concurrent deploy race → orphaned live worker holding a valid secret
**Category:** TOCTOU / lifecycle race · **Severity:** MEDIUM

`deploy()` is invoked from two places that are **not** mutually serialized:
- `ensureDeployed()` (worker-lifecycle.ts:168-181), guarded by `deployInFlight`,
  called externally from the `mintToken` RPC handler (server.ts:212).
- `tick()`'s health-fail branch calls `await this.deploy()` **directly**
  (worker-lifecycle.ts:237), bypassing the `deployInFlight` dedupe.

The health loop and an owner `mintToken` run on independent turns. A `mintToken`
→ `ensureDeployed` → `deploy()` can overlap a `tick()` health-fail → `deploy()`.
Two temp accounts get provisioned, two `startTunnel` calls run, and the second
`recordStore.save` overwrites the first. Result: one fully-deployed worker — live,
reachable, holding a valid `TUNNEL_SECRET` — is now **untracked** (its record was
overwritten), and its `SharedTunnel` instance is leaked (never `stop()`ed because
`teardownTunnel` only tracks `this.tunnel`).

**Exploit sketch:** not directly attacker-triggered, but it widens the secret's
exposure surface: an orphaned worker with a valid secret sits reachable for up to
the 60-min TTL, outside the health/rotation machinery, and a leaked SharedTunnel
keeps dialling it. Blast radius the design assumes is "one generation" is
temporarily two.

**Mitigation:** route the `tick()` redeploy through `ensureDeployed()` (or share a
single deploy mutex), so at most one deploy is ever in flight. On overwrite,
capture the previous record and best-effort tear down its tunnel + delete its CF
account.

---

### M5 — Secrets persisted plaintext in `bb.storage.kv` (documented residual)
**Category:** secret-at-rest · **Severity:** MEDIUM (accepted under local-trust)

`worker-record.ts` persists `apiToken`, `tunnelSecret`, and `claim.url` as
plaintext JSON in `bb.storage.kv` (bb.db). The header documents this and defers to
v0's local-trust model — reasonable — but two things sharpen it:

- **`apiToken` is the worst item here, not `tunnelSecret`.** With the CF temp-
  account `apiToken`, an attacker doesn't need the tunnel secret at all: they
  redeploy a malicious worker (that logs the tunnel secret / exfiltrates guest
  traffic) under the owner's own account. The tunnel secret's careful rotation is
  moot if `apiToken` leaks.
- **Rogue-plugin path.** The threat you asked me to consider ("rogue plugin reads
  kv") depends on whether `bb.storage.kv` is truly per-plugin isolated at the API
  layer *and* whether bb.db is encrypted at rest. If another installed plugin can
  read this namespace, the local-trust assumption is weaker than "local disk
  access" — it's "any plugin the owner installs." See open question Q-A.

**Mitigation (v0-acceptable):** document explicitly that installing an untrusted
bb plugin is equivalent to handing over the CF account. For v0.1, consider
storing only what's needed to *re-attach* and re-minting on restart rather than
persisting `tunnelSecret`; or wrap secret fields with a bb-provided secret store
if one exists.

---

### L1 — `timingSafeEqual` comment contradicts its code; hand-rolled compare
**Category:** crypto-hygiene / doc-drift · **Severity:** LOW

`worker/src/tunnel/tunnel-do.ts:55-67`. The doc comment claims: "On a length
mismatch we still XOR against `presented` so timing does not distinguish 'bearer
missing' from 'bearer wrong length'." The code does the opposite — it early-
returns on `a.length !== b.length` before any XOR. The length of the secret is
therefore leakable by timing.

This is **not exploitable**: the secret is a fixed-length (43-char) 256-bit value,
so its length is already public and constant. The important property — the XOR
loop does not short-circuit on the first differing character (it accumulates into
`diff` and returns only after the full pass) — **is** correctly implemented, so no
per-character timing oracle exists. Brute force over 256 bits is a non-threat.

**Mitigation:** fix the comment to match the code (or use `crypto.subtle`/a
constant-time primitive and delete the hand-roll). Doc-only; no behaviour change
needed for security.

---

### L2 — `healthCheck` accepts *any* HTTP response as "alive"
**Category:** liveness-spoofing · **Severity:** LOW

`worker-lifecycle.ts:335-352`: any non-throwing `fetch` (even a 200 from a wrong
host, captive portal, or MITM) counts as healthy. Combined with the absence of
TLS-identity pinning (L3), a network-position attacker who answers *anything* at
the worker URL keeps the plugin believing a dead/hostile endpoint is live and
suppresses the wipe-and-redeploy that would otherwise rotate away from it.

**Exploit sketch:** low, needs on-path network control that already implies bigger
problems; but it means the health check can't be trusted as a security control,
only a liveness hint.

**Mitigation:** health-check the actual `/__tunnel` contract (expect the specific
401 `missing bearer` body/marker), not "any response." Cheap and tightens L2+L3.

---

### L3 — No TLS/identity pinning beyond the `*.workers.dev` origin (documented residual)
**Category:** transport-auth · **Severity:** LOW (accepted)

The tunnel dials `record.url` over `wss://` and relies on standard web PKI to
authenticate `*.workers.dev`. No pinning. A local attacker who can install a
trusted CA (or otherwise MITM the owner's egress) can terminate the WS, capture
the `Authorization: Bearer <secret>`, and relay — a full tunnel MITM. This is the
documented residual and is consistent with v0's local-trust boundary (a machine
that can install a CA can also read `bb.db`). Noted, not blocking.

---

### L4 — Stale prior-generation worker holds the old secret for up to 60 min
**Category:** rotation-tail · **Severity:** LOW

On redeploy the *new* worker gets a new account+secret, but the *old* worker keeps
running (with the old secret in its env) until its unclaimed TTL expires. The
local tunnel has moved to the new worker, so the old one serves 503-offline to
guests. An attacker who captured the *old* secret can dial the old worker's
`/__tunnel` and, because of single-tunnel-supersede (see the design note below),
attach *their* bb as the tunnel — then phish any guest still holding the **old**
worker URL. Guest URLs change on redeploy so the window is narrow and self-
closing, and it requires prior secret capture (already game-over locally).

**Mitigation:** if `apiToken` for the prior generation is retained, best-effort
delete the old account on successful redeploy instead of waiting for TTL.

---

## Design note (not a bug, worth stating): secret possession = tunnel *takeover*

`tunnel-do.ts:104-110` (`acceptTunnel`) closes any existing tunnel socket when a
new authenticated dial arrives — "a fresh dial supersedes." Correct for the
owner's own reconnect loop, but it means the tunnel secret is not merely a *read*
credential: **anyone who presents it displaces the legitimate owner's tunnel** and
becomes the endpoint all guest traffic flows to. There is no channel binding or
proof-of-owner beyond the shared bearer. So any secret leak (M3/M5/L3) escalates
from "eavesdrop" to "own the guest session": serve attacker content to guests
(phishing) and collect guest `write` messages. This raises the stakes on every
secret-confidentiality finding above and is the reason H1/M2/M3 matter more than
their individual mechanics suggest. For v0 under local-trust it's acceptable, but
the design should state that the tunnel secret is a *takeover* credential, not
just an auth token, so future work (v2 claim/OAuth) treats it accordingly.

---

## Non-findings (checked, deemed safe — don't re-review)

- **Brute force of the secret.** 32 bytes CSPRNG (`randomBytes`), 256 bits. Non-
  threat. `base64url` encoding is correct (strips padding, URL-safe). ✔
- **Per-character timing oracle in the compare.** The XOR loop accumulates into
  `diff` and returns only after the full pass — no early-out on first mismatch. No
  byte-by-byte recovery oracle. (Length early-return is harmless; secret length is
  fixed/public — see L1.) ✔
- **Empty/unset secret.** `timingSafeEqual` returns `false` when `a.length === 0`,
  and `env.TUNNEL_SECRET ?? ""` maps unset → "" → never authenticates. Fail-closed.
  `bearerFrom` rejects missing/blank/malformed `Authorization`. ✔
- **Replay across redeploys.** Fresh account + fresh secret per (re)deploy; old
  account self-destructs. No long-lived secret to replay. ✔ (tail: L4).
- **Cross-owner secret reuse / misrouted deploy.** Secret minted independently per
  deploy, never shared; a misroute plants a fresh secret on the wrong worker and
  the mismatched dial 401s. Fail-closed, no cross-owner access. ✔
- **Worker impersonation via guest-supplied URL.** The tunnel only ever dials
  `record.url`, constructed by the plugin from a constant `scriptName` + the CF
  subdomain; never a guest- or worker-supplied URL. A rogue worker lacking the
  secret just 401s the dial. ✔ (residual = L3 MITM only).
- **Worker leaking `TUNNEL_SECRET` to guests.** `tunnel-do.ts` never echoes
  `env.TUNNEL_SECRET`; `proxyGuestRequest` doesn't touch it; `secret_text`
  bindings are omitted from CF script GETs. ✔
- **Origin/redirect exfil of the bearer.** WS dial URL is fixed; `healthCheck`
  uses `redirect: "manual"`; no attacker-controlled redirect chain carries the
  `Authorization` header elsewhere. ✔
- **`Authorization` prefix casing.** Client sends `Bearer <secret>`; `bearerFrom`
  matches `"Bearer "` exactly; ws lowercases only the header *name*, not the value.
  Match holds. ✔
- **Malformed KV record.** `createWorkerRecordStore.load` zod-validates and treats
  a bad blob as absent (deletes it) → fresh bootstrap, no crash, no partial-secret
  reuse. ✔
- **`getStatus` redaction of `apiToken`/`tunnelSecret`.** Neither is in
  `WorkerStatus`/`workerStatusSchema`; they never cross the RPC boundary. (The
  *`claim`* field is the gap — see H1.) ✔
- **401/403 handling in `SharedTunnel`.** On a 401/403 upgrade rejection the client
  `stop()`s instead of hot-looping the same bad secret. ✔

---

## Open questions for the design team

- **Q-A (blocks M5 sign-off):** Does `bb.storage.kv` enforce per-plugin namespace
  isolation at the API layer, and is the backing `bb.db` encrypted at rest? If a
  co-installed plugin can read this namespace, "local-trust" must be restated as
  "trust every installed plugin," which is a materially weaker claim.
- **Q-B (blocks M2):** On what route does bb expose plugin RPC and realtime
  subscribe to the SPA, and is that route inside the worker's deny-by-default
  guest gate? The guest response matrix in SPEC.md doesn't name it.
- **Q-C (blocks M3):** Does the `cloudflare` SDK (or the raw `fetch` in `cfPost`)
  ever include request-body/binding values in thrown `Error.message`s? If yes,
  every deploy error is a potential secret disclosure to bb.log.
- **Q-D:** The `TUNNEL_PROTOCOL_QUERY_PARAM` version is sent by the client
  (shared-tunnel.ts:151) but `acceptTunnel` never validates it. Intended for the
  scaffold, but confirm the real wire-protocol pass (issue 14) enforces a version
  floor so an old client can't negotiate a weaker framing later (downgrade).
- **Q-E:** Is retaining `tunnelSecret` in KV actually necessary? Re-attach only
  needs to re-present it to a still-live worker; if a plugin restart could instead
  redeploy-fresh, the persisted secret (the most sensitive rotating item) could be
  dropped from disk entirely.
