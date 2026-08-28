# Confirmed-claim flow for the CF temp worker — research + design

Scope: how the plugin can learn that its anonymously-deployed Cloudflare temp
worker has been **claimed** by the owner, set a *trustworthy* `claimed` flag from
that confirmation (not from a button click), and persist exactly enough to reuse
a claimed worker across a bb restart while holding both invariants:

- **Invariant A** — a worker *in use* must always be claimable (its claim link
  reachable while it serves guests).
- **Invariant B** — a *claimed* worker is permanent, reused across restart,
  never orphaned.

Supersedes the fire-and-forget claim posture in `SPEC.md` §"Worker lifecycle"
and the persist-everything shape in `plugin/worker-lifecycle/worker-record.ts`.
Builds on the original spike `research/cf-temp-deployments.md` and the v1
"OAuth-based claim flow" candidate in `.scratch/v0/map.md`.

Sources (every capability claim below is cited inline):

- Changelog — [Platforms can now create Temporary Accounts via the Cloudflare API (2026-07-14)](https://developers.cloudflare.com/changelog/post/2026-07-14-temporary-accounts-api/)
- Docs — [Claim deployments (temporary accounts)](https://developers.cloudflare.com/workers/platform/claim-deployments/), incl. [§Integrate with the REST API](https://developers.cloudflare.com/workers/platform/claim-deployments/#integrate-with-the-rest-api)
- Blog — [Temporary Cloudflare accounts for agents](https://blog.cloudflare.com/temporary-accounts/)

---

## 1. What the Cloudflare docs DO and DO NOT give us

### 1.1 There is no claim-status API. None.

Both primary docs were read in full. Neither the 2026-07-14 changelog nor the
claim-deployments page exposes **any** endpoint, field, webhook, or callback to
observe claim status.

- The changelog documents exactly two endpoints — `POST
  /client/v4/provisioning/previews/challenge` (get PoW challenge) and `POST
  /client/v4/provisioning/previews` (create the temp account). No account-status
  GET, no claim-status resource. [[changelog]](https://developers.cloudflare.com/changelog/post/2026-07-14-temporary-accounts-api/)
- The claim-deployments REST-API section describes the same three-step flow
  (challenge → solve → create) and is explicit that the claim is an
  **asynchronous, user-driven, browser flow with no callback**: *"The intended
  user must complete the claim within 60 minutes. Opening the claim URL before
  the deadline is not enough"* — they must *"sign in to Cloudflare or create an
  account, then complete the dashboard prompts."* [[claim-deployments]](https://developers.cloudflare.com/workers/platform/claim-deployments/#integrate-with-the-rest-api)

**Answer to Q1 and Q2:** no poll endpoint, no status field, no webhook. The only
thing the create call returns that a program can key off is the provisioning
envelope (`account.{id,apiToken,expiresAt,…}` + `claim.{token,url,expiresAt}`).
The `claim.url` is a **dashboard deep link**, formatted
`https://dash.cloudflare.com/claim-preview?claimToken=<CLAIM_TOKEN>`, `expiresAt`
= 60 minutes. [[claim-deployments]](https://developers.cloudflare.com/workers/platform/claim-deployments/#integrate-with-the-rest-api)
This matches the earlier spike's read (`research/cf-temp-deployments.md`:
"There is no webhook or callback from CF telling us the account has been
claimed").

### 1.2 The workers.dev URL after claim — CORRECTED, see §10

> **⚠️ This section's original conclusion ("URL is stable across claim") was
> wrong for the claim-into-existing-account case and has been superseded by the
> definitive analysis in [§10](#10-definitive-hostname-on-claim-finding).** The
> quote below only covers *which account* the worker lives in, not *which
> subdomain* it is served from. Read §10 before relying on any persisted `url`.

The docs build the URL as `result.subdomain` + script name →
`https://<SCRIPT_NAME>.<SUBDOMAIN>.workers.dev`, and state that after claiming
*"the Worker and supported resources remain in the claimed account."*
[[claim-deployments]](https://developers.cloudflare.com/workers/platform/claim-deployments/#integrate-with-the-rest-api)
That sentence is about ownership, not hostname. Because the host embeds the
*account* subdomain and an account has exactly one subdomain, claiming into an
existing account that already has its own subdomain changes the hostname. §10
settles this.

### 1.3 The temp `apiToken` does NOT survive as a management credential

**Answer to Q5 (part 1):** the docs say plainly *"Claiming does not grant the
platform permanent access to the account,"* and that for future management you
must *"connect the claimed account through your normal authenticated flow, such
as a Cloudflare OAuth client."* [[claim-deployments]](https://developers.cloudflare.com/workers/platform/claim-deployments/#integrate-with-the-rest-api)

The exact revocation *timing* of the temp `apiToken` on claim is **not
documented** (flagged as a gap). Treat the temp `apiToken` as **dead the moment
a claim is confirmed** — do not build any reuse path that depends on it after
claim. This is a docs-unsupported area we design conservatively around.

### 1.4 No worker-side runtime signal of claim status

**Answer to Q4:** the owner's idea — the *worker* detects it is claimed and calls
back to the plugin over the tunnel — is **not feasible**, because there is no
worker-observable claim signal to trigger on. Nothing in the runtime surfaces
claim state to a Worker: the `secret_text` bindings (`TUNNEL_SECRET`,
`AUTHZ_TOKEN`) baked at deploy are unchanged by a claim, and there is no
env/binding/runtime API that reflects "this account is now claimed." The docs
describe claim as a control-plane account-ownership transfer; the data-plane
Worker is oblivious. There is nothing for a callback to fire *on*.

A callback would also be redundant: whatever the worker could report, the plugin
can observe more cheaply and more trustworthily from its own side (§2).

**Net:** Cloudflare gives us **zero positive claim signal** through any API,
binding, or callback. Any confirmation mechanism has to be inferred plugin-side.

---

## 2. Survival-past-TTL signal — DEMOTED to pre-OAuth fallback (owner decision, §9)

> **Status: demoted.** Per the owner decision in [§9](#9-owner-decisions-oauth-is-the-source-of-truth),
> Cloudflare OAuth ([§11](#11-oauth-design-source-of-truth)) is now the source of
> truth for claim state and worker identity. The survival probe below is kept
> **only** as an optional fallback for the short window *before* the owner has
> connected by OAuth (it still answers "did anyone claim this at all?" when we
> have no OAuth token yet). It no longer sets a persisted trust boundary on its
> own. The mechanics are retained for that fallback and for context.

The temp account has a hard property we can lean on:

> An **unclaimed** temp account and all its resources are **deleted after 60
> minutes**; a **claimed** account becomes permanent and its Worker keeps
> running. [[changelog]](https://developers.cloudflare.com/changelog/post/2026-07-14-temporary-accounts-api/) [[blog]](https://blog.cloudflare.com/temporary-accounts/)

Cloudflare enforces this regardless of what the owner clicks. So:

> **A worker that is still reachable meaningfully after its `expiresAt` deadline
> has been claimed.** A button click cannot produce that state; only a completed
> claim can. Cloudflare deletes anything unclaimed.

That is the **trustworthy `claimed` flag** the design needs. The signal is:

- **Positive (claimed):** `healthCheck(url)` succeeds at `now >= expiresAt +
  CONFIRM_MARGIN`.
- **Negative (expired-unclaimed):** `healthCheck(url)` fails around/after
  `expiresAt` — CF reaped it.

`CONFIRM_MARGIN` (proposed ~5 min) guards the false-positive direction: CF's
reaper may lag a little past the exact 60-minute mark, so a still-alive worker at
`expiresAt + 30s` might just be not-yet-reaped, not claimed. Waiting a margin
before trusting "alive ⇒ claimed" removes that ambiguity. It costs nothing on the
true-claimed side (a claimed worker lives forever, so a few extra minutes of
waiting is harmless).

This reuses machinery that already exists: `WorkerLifecycle.healthCheck()`
(`plugin/worker-lifecycle/worker-lifecycle.ts:384`) already probes `GET /` and
treats sub-500 as alive. No CF API call, no `apiToken` needed — it hits the
public worker URL directly, which is exactly why it keeps working after the temp
`apiToken` dies on claim (§1.3).

**Latency is the cost.** Confirmation cannot fire before ~`expiresAt` (≈55–60
min into the worker's life), because that is the earliest moment survival is
diagnostic. There is no earlier positive signal anywhere in the API (§1.1). This
latency is fundamental to the Cloudflare design, not a shortcoming of ours, and
it drives the one residual in §5.

---

## 3. Persistence model: session-memory record vs claimed disk record

Two distinct records, replacing today's single persist-everything
`WorkerRecord`.

### 3.1 Session record — MEMORY ONLY, never touches disk

Held in `WorkerLifecycle` for the life of the process, for **every** worker
(claimed or not), covering the fields we must never write down:

| Field | Why memory-only |
|---|---|
| `apiToken` | crown-jewel bearer (SPEC §"Trust model"); also dead post-claim (§1.3) |
| `accountId` | account identifier; task constraint keeps it off disk |
| `claim: { url, expiresAt }` | account-**takeover** bearer (H1, ticket 20) — never on disk, never on a broadcast |
| `url`, `tunnelSecret` | present here too; only *promoted* to disk on confirmed claim |
| `expiresAt` | the 60-min deadline that drives confirmation |
| `claimed` (in-memory view) | mirrors the flag once confirmed |

An **unclaimed** worker lives *entirely* here and is **never written to disk** —
satisfying the task's "UNCLAIMED workers are session-only, recreated fresh each
session." Because the record (and its `claim.url`) are always freshly in memory
while the worker is in use, the claim link is always reachable → **Invariant A**.

### 3.2 Claimed record — PERSISTED to `bb.storage.kv`

Written **only** on a confirmed claim (§2). Contains url + tunnelSecret + the
trustworthy flag + non-secret metadata, and **nothing** from the memory-only set:

```ts
// replaces the current workerRecordSchema
claimedWorkerRecordSchema = z.object({
  claimed: z.literal(true),      // trustworthy flag — only ever written after §2 confirmation
  url: z.string(),               // stable across claim (§1.2) → safe to reuse verbatim
  tunnelSecret: z.string(),      // SECRET, but the ONLY secret we persist; needed to re-dial the tunnel
  // ---- non-secret metadata ----
  scriptName: z.string(),        // for the dashboard management link (§4)
  deploymentId: z.string(),
  generation: z.number(),
  deployedAt: z.number(),
  claimedAt: z.number(),         // when confirmation fired
  // expiresAt intentionally absent: a claimed worker does not expire
})
// NOT persisted: apiToken, accountId, claim{url,expiresAt}
```

`tunnelSecret` on disk is unchanged from today's posture (already plaintext in
`bb.storage.kv`, inside the v0 local-trust boundary — SPEC §"Trust model"). The
improvement is that `apiToken`, `accountId`, and `claim.url` **leave the disk
entirely**, shrinking the at-rest crown-jewel surface the trust model calls out.

`load()` keeps the current defensive stance
(`plugin/worker-lifecycle/worker-record.ts:63`): a malformed or non-`claimed`
blob is treated as absent and wiped, degrading to a fresh bootstrap.

---

## 4. The confirmed-claim flow (state machine)

Deploy no longer persists. It builds the **session record in memory** and starts
the tunnel — same as today minus the `recordStore.save()` call.

```
deploy() ──▶ session record in memory { url, apiToken, accountId,
             tunnelSecret, claim, expiresAt }, tunnel up, state=live
             (NOTHING on disk yet)
```

The health `tick()` (already runs every `healthIntervalMs` while tokens are live)
gains a claim-confirmation branch. Replace today's "expiry ⇒ unhealthy ⇒
wipe+redeploy" with an expiry-aware evaluation:

```
tick(), record is the in-memory session record, worker not yet claimed:

  if now < expiresAt:
      normal health probe. alive → stay live. dead → genuine failure,
      wipe memory + redeploy fresh (unchanged from today).

  if now >= expiresAt + CONFIRM_MARGIN:
      probe once more.
        alive  → CLAIM CONFIRMED.
                 • set claimed = true (trustworthy — only reachable here)
                 • write the §3.2 claimed record to bb.storage.kv
                 • drop apiToken / accountId / claim from the live model
                   (they are now invalid and no longer needed)
                 • keep url + tunnelSecret + tunnel running untouched
                 • state stays live; broadcast worker-changed (redacted)
        dead   → EXPIRED UNCLAIMED. wipe memory, redeploy fresh
                 (new url, new claim.url in memory → Invariant A preserved).
```

Key properties:

- The `claimed` flag is **only ever set inside the "alive at `expiresAt +
  margin`" branch.** No RPC, no owner button, no worker callback can set it.
  Clicking the claim link does not touch the plugin at all (it opens a CF
  dashboard tab). The flag is a function of *observed survival*, which only a
  real claim can produce → **trustworthy by construction**.
- Nothing is persisted for an unclaimed worker, ever.
- Confirmation is idempotent: once the claimed record exists, subsequent ticks
  take the §5 reuse path, not this one.

`getClaimUrl()` (owner-only RPC, `worker-lifecycle.ts:177`) keeps serving the
in-memory `claim.url` while the worker is unclaimed and pre-expiry — the whole
window in which claiming is possible. After confirmation there is nothing left to
claim, so it returns null. The claim URL still never rides `getStatus()` or the
`worker-changed` broadcast (H1 preserved).

---

## 5. Reuse-on-restart, and the two invariants walked

### 5.1 Claimed worker, restart (the Invariant B happy path)

```
start → recordStore.load() → claimed record { claimed:true, url, tunnelSecret, … }
      → healthCheck(url)
          alive → re-attach SharedTunnel with the persisted tunnelSecret,
                  state=live. NO redeploy, NO apiToken, NO CF API call.
          dead  → the owner deleted the worker in their dashboard.
                  wipe record, state=idle, bootstrap fresh unclaimed on next mint.
```

This works precisely because (a) the URL is stable across claim (§1.2) so the
persisted `url` is still correct, and (b) re-dialling the tunnel needs only `url`
+ `tunnelSecret`, both persisted, and **not** the (now-dead) `apiToken`. The
claimed worker's `TUNNEL_SECRET` env binding still holds the same secret from its
original deploy, so the handshake matches. → **Invariant B holds.**

"Dead on reload ⇒ owner deleted it" is not an orphan: the owner removed it on
purpose; the plugin correctly forgets it and re-bootstraps.

### 5.2 Unclaimed worker, restart

```
start → recordStore.load() → null (unclaimed was never persisted) → idle
      → next mint → deploy fresh temp worker, in memory, new claim.url in memory.
```

Pre-restart guest URLs were already dead (tokens are in-memory and die on
restart — SPEC §"Data model"). The fresh worker's claim link is in memory and
reachable the instant it starts serving. → **Invariant A holds**; nothing
orphaned (the pre-restart unclaimed worker self-destructs on CF's 60-min timer).

### 5.3 The one residual: restart *inside the confirmation window*

Claim completed at minute 5, bb restarts at minute 30, before confirmation could
fire (~minute 62). At restart the claimed record does not exist yet (confirmation
is gated on `expiresAt + margin`, §2), so `load()` returns null and the plugin
bootstraps a **fresh** worker. The genuinely-claimed minute-5 worker is now an
**orphan** under the owner's real CF account: still running, but tunnel-less
(its `tunnelSecret` lived only in the lost session memory) and unknown to the
plugin. This is a narrow violation of Invariant B.

- **Bounded:** the window is [claim-time, `expiresAt`] ⊆ ≤60 min, self-closing.
- **Recoverable:** the orphan appears as a stray `bb-shared-worker` in the
  owner's Workers dashboard; they can delete it. The plugin, having redeployed,
  is otherwise fully functional.
- **Irreducible under the stated model.** Closing it would require persisting the
  unclaimed worker's `url`+`tunnelSecret` *tentatively* at deploy time — directly
  contradicting "UNCLAIMED workers are never written to disk," and gaining
  nothing on CF's side (there is still no earlier claim signal to confirm
  against). We deliberately do **not** do this; the residual is the price of the
  never-persist-unclaimed rule and of Cloudflare exposing no claim callback. It
  is the direct analogue of the accepted L4 stale-prior-gen residual (SPEC
  §"Trust model"). Flagged here for the parent thread to accept or override.

---

## 6. Redeploy / undeploy of a CLAIMED worker (Q5)

Once claimed, the plugin holds no valid CF management credential (§1.3). Two
paths were on the table:

**(a) Cloudflare OAuth.** The docs' own recommendation: *"connect the claimed
account through your normal authenticated flow, such as a Cloudflare OAuth
client."* [[claim-deployments]](https://developers.cloudflare.com/workers/platform/claim-deployments/#integrate-with-the-rest-api)
This is the *only* way the plugin can programmatically redeploy new worker code
onto, or delete, a claimed worker. Cost: register a CF OAuth client, run the
authorization-code flow, store + refresh a real user token — a whole subsystem.
This is the v1/v2 "OAuth-based claim flow" candidate in `.scratch/v0/map.md`, and
it is the right long-term answer.

**(b) Dashboard link.** The plugin surfaces a link to the worker's resource in
the CF dashboard and the owner does undeploy/redeploy by hand. Zero infra. The
generic form works without the (unpersisted) `accountId`:
`https://dash.cloudflare.com/?to=/:account/workers-and-pages` plus telling the
owner the script name (`bb-shared-worker`). While the session record still holds
`accountId` in memory (pre-restart), a deep link
`https://dash.cloudflare.com/<accountId>/workers/services/view/<scriptName>` can
be offered as a nicety; post-restart it degrades to the generic link + script
name.

**MVP for v1: (b), plus "don't redeploy claimed workers at all."** A claimed
worker is treated as a **frozen, stable endpoint**: the plugin drives its tunnel
and never attempts to push new code to it. If the owner needs updated worker
code, the flow is: delete the claimed worker via the dashboard link → the plugin
sees the reload/health probe fail → it bootstraps a fresh temp worker → the owner
re-claims. Undeploy = the same dashboard link. This keeps v1 free of any OAuth
dependency while remaining correct, and leaves (a) as the clean v2 upgrade that
turns redeploy into a first-class in-plugin action.

---

## 7. Docs gaps we are designing around (stated explicitly)

- **No claim-status API of any kind** — no poll, no field, no webhook, no
  callback. Confirmation is inferred from survival-past-TTL, not read from CF.
- **No worker-runtime claim signal** — a worker-side callback is impossible;
  there is nothing to trigger it.
- **Exact temp-`apiToken` invalidation timing on claim is undocumented** — we
  treat it as dead-on-claim and never depend on it post-confirmation.
- **CF reaper timing precision** — "60 minutes" is the stated TTL; we add a
  `CONFIRM_MARGIN` rather than trusting the boundary to the second.

---

## 8. Recommendation

**Yes — reliable claimed-worker reuse is achievable with today's Cloudflare
APIs, with one bounded, documented residual.** Cloudflare offers no positive
claim signal (§1.1, §1.4), so the plugin cannot be *told* a claim happened. But
it can *prove* one to itself from the one hard guarantee CF does make —
**unclaimed accounts die at 60 minutes, claimed ones live on** — by health-probing
the worker URL past its `expiresAt` deadline (§2). That gives a `claimed` flag
that only a real claim can set, which is exactly the trustworthy signal the
persistence split needs.

Chosen paths:

- **Confirmation:** survival-past-TTL probe in the existing health tick. No new
  CF dependency, no OAuth, no worker callback.
- **Persistence:** memory-only session record for everything; promote **only**
  `url + tunnelSecret + claimed + non-secret metadata` to disk on confirmation;
  `apiToken`/`accountId`/`claim.url` never hit disk.
- **Reuse:** re-attach the tunnel from the persisted `url + tunnelSecret`; the
  URL is stable across claim (§1.2) and no CF credential is required.
- **Redeploy/undeploy (v1 MVP):** dashboard link + treat claimed workers as
  frozen endpoints; defer programmatic redeploy to the v2 **Cloudflare OAuth**
  path the docs recommend.

Invariant A holds in all cases (unclaimed workers keep a fresh claim link in
memory while in use). Invariant B holds except for a restart landing in the
[claim, `expiresAt`] window (§5.3) — bounded ≤60 min, dashboard-recoverable, and
irreducible without breaking the never-persist-unclaimed rule; recommended for
acceptance as an L4-class residual.

---
---

# Revision — OAuth as source of truth (owner decisions)

Everything above §9 is the first-pass design. The owner has since made OAuth the
source of truth and asked three things be settled. §§9–14 are the current design;
where they conflict with §§1.2, 2, 4–6, the sections below win.

## 9. Owner decisions: OAuth is the source of truth

1. **Cloudflare OAuth is built in v1, not deferred.** Once the owner connects the
   claimed account via a Cloudflare OAuth client, the plugin reads claim state,
   the worker's *current* hostname, and drives redeploy/undeploy from the CF API.
2. **Survival-past-TTL is demoted** to an optional pre-OAuth fallback (§2 banner).
3. **Settle the hostname-on-claim question** definitively (§10), because a
   persisted `url` is only ever safe if the hostname is stable across claim.
4. **Record but do not adopt** the "recent hosts, use the latest" idea (§13).

## 10. Definitive hostname-on-claim finding

**Question:** when a temp worker is claimed, does its
`<script>.<subdomain>.workers.dev` hostname stay the same, or move onto the
claiming account's subdomain?

### 10.1 What the docs actually say — and do not

- The URL is constructed as `<SCRIPT_NAME>.<SUBDOMAIN>.workers.dev` where the
  subdomain comes from the account (`result.subdomain`).
  [[claim-deployments]](https://developers.cloudflare.com/workers/platform/claim-deployments/#integrate-with-the-rest-api)
- On claim the claimer *"sign[s] in to Cloudflare **or** create[s] an account,
  then complete[s] the dashboard prompts,"* and afterwards *"the Worker and
  supported resources remain in the claimed account."*
  [[claim-deployments]](https://developers.cloudflare.com/workers/platform/claim-deployments/#integrate-with-the-rest-api)

I re-fetched the claim-deployments page asking specifically about the subdomain
in the two claim cases (new account vs existing account). **The page is silent.**
It says the worker *remains in the claimed account*; it says **nothing** about
what subdomain it is served from once it is in that account. So the cited quote
in the old §1.2 does **not** support "URL stable across claim." I was over-reading
it. Stated plainly: **the docs do not resolve the hostname-on-claim question.**

### 10.2 What the structure of workers.dev forces

Two facts constrain the answer even though the claim page is silent:

- A workers.dev hostname is `<script>.<account-subdomain>.workers.dev` — the
  subdomain segment is the **account's** subdomain.
  [[workers.dev docs]](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- **An account has exactly one workers.dev subdomain.** Cloudflare rejects a
  second one: users changing it hit *"Account already has an associated
  subdomain."*
  [[community]](https://community.cloudflare.com/t/request-to-change-account-workers-dev-subdomain/893651)

Therefore, when a worker ends up inside an account, it can only be served at
**that account's** subdomain. The temp account's subdomain cannot ride along into
an account that already has its own. This yields:

- **Claim into a brand-new account:** the claimer's account likely inherits (or is
  assigned) a subdomain; whether it is the *same* string as the temp subdomain is
  **undocumented**. Hostname *may* be stable, but this is not guaranteed.
- **Claim into an existing account with its own subdomain:** the worker must be
  reachable at `<script>.<existing-subdomain>.workers.dev`. The subdomain segment
  **changes**, so the **hostname changes**. This matches the owner's expectation
  and contradicts the old §1.2.

### 10.3 Verdict, and what an empirical test must check

**The owner is right to distrust a persisted `url`.** In the common case (a
developer claiming into their existing Cloudflare account), the hostname almost
certainly changes. The docs do not state it, so this is a **strong structural
inference, not a documented fact** — flagged as such.

Consequences:

- A persisted `url` **can be stale** after claim. Reuse-on-restart must **not**
  trust a stored hostname for a claimed worker; it must re-resolve the current
  hostname. Under the OAuth design (§11) the plugin reads the live hostname from
  the CF API, which removes the guesswork entirely — this is a second, independent
  reason OAuth is the right source of truth.
- The old §5.1 "the persisted url is still correct" claim is **withdrawn** for the
  existing-account case; §12 re-walks restart under OAuth.

**Empirical test to close the doc gap** (no CF egress in-sandbox — run on a
machine with network + two CF accounts):

1. Provision a temp worker via `POST /provisioning/previews`; record
   `account.id`, the temp `subdomain`, and the full URL.
2. **Case A:** open `claim.url`, sign into an **existing** account whose
   workers.dev subdomain is known and *different* from the temp one. After claim,
   `GET /accounts/{claimedAccountId}/workers/subdomain` and confirm whether the
   returned subdomain equals the existing account's (hostname changed) or the temp
   one (hostname preserved). Also curl the old temp URL and the recomputed
   `<script>.<existing-sub>.workers.dev` and see which one serves.
3. **Case B:** repeat, claiming into a **freshly created** account, and record
   whether the new account's subdomain equals the temp subdomain.
4. Record both in this file. Until then, treat "hostname changes on claim into an
   existing account" as the working assumption.

## 11. OAuth design (source of truth)

### 11.1 Which client, which grant, which scopes

- **Client type:** a **public OAuth client with PKCE.** The plugin runs on the
  owner's machine (a bb server process, not a domain-verified confidential web
  backend); it cannot safely hold a client secret, which is exactly the case
  Cloudflare's docs direct to *"PKCE required for public clients (single-page,
  mobile, desktop, CLI apps)."*
  [[create-an-oauth-client]](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)
- **Grant:** Authorization Code + PKCE. Cloudflare supports **only** the
  authorization-code flow for third-party clients (no device, no client-creds).
  [[self-managed OAuth changelog]](https://developers.cloudflare.com/changelog/post/2026-06-03-public-oauth-clients/)
- **The client is registered ONCE by us (grrowl), not per user.** Create it via
  `POST /accounts/{grrowlAccountId}/oauth_clients` with
  `grant_types:["authorization_code"]`, `response_types:["code"]`,
  `token_endpoint_auth_method` for a public/PKCE client, and `redirect_uris` (see
  §11.3). Ship the resulting **`client_id`** in the plugin. There is no per-user
  client and no client secret in the distributed plugin.
  [[create-an-oauth-client]](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)
- **Scopes:** minimum viable set is Workers read + write, i.e.
  `workers-platform.read` and `workers-platform.write` (the two scopes the docs
  name by example), plus whatever account-read scope lets us list accounts /
  read the workers.dev subdomain. The **complete scope list is not enumerated in
  the docs**; fetch it live from `GET /client/v4/oauth/scopes` at client-build
  time and pick the narrowest that cover: list accounts, read a worker's
  subdomain/hostname, and update/delete a worker script. Mark anything beyond
  read as an **optional scope** so a cautious owner can grant read-only.
  [[create-an-oauth-client]](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)

**Doc gap, stated plainly:** the exact **authorize** and **token endpoint URLs**
are **not present** on the OAuth pages I could reach (create-an-oauth-client and
authorizing-an-application both omit them). The design below is written against
standard authorization-code+PKCE mechanics; the two endpoint URLs and the exact
account-scope identifier must be confirmed from the CF OAuth API reference (or by
inspecting a `wrangler login`, which already performs this exact flow) before
implementation. Everything else here is doc-supported.

### 11.2 Connect flow (authorization-code + PKCE)

```
1. Owner clicks "Connect Cloudflare account" in the bb-shared panel
   (surfaced once a worker is deployed and the owner wants a permanent one).
2. Plugin generates code_verifier + code_challenge (S256) and a random `state`.
3. Plugin opens the CF authorize URL in the owner's browser:
     <AUTHORIZE_URL>?response_type=code&client_id=<grrowl client_id>
       &redirect_uri=<loopback>&scope=<workers read/write + account read>
       &state=<state>&code_challenge=<challenge>&code_challenge_method=S256
4. Owner consents (and picks their account if multi-account). CF redirects to
   the loopback redirect_uri with ?code=…&state=…
5. Plugin's tiny loopback listener captures the code, checks `state`, and
   POSTs to <TOKEN_URL> with grant_type=authorization_code, code,
   code_verifier, client_id, redirect_uri → { access_token, refresh_token,
   expires_in }.
6. Plugin persists ONLY the refresh_token (see §11.4). access_token kept in
   memory.
```

`<loopback>` = `http://127.0.0.1:<ephemeral>/oauth/callback`, the standard native
/CLI redirect target (same shape `wrangler login` uses). PKCE removes the need
for a client secret on the owner's machine.

### 11.3 Discover the claimed worker

After connect, the plugin does **not** trust any persisted hostname (§10). It
resolves the worker live:

```
1. GET /client/v4/accounts                      → list accounts the owner granted
2. for each account:
     GET /accounts/{id}/workers/scripts         → find our script by name
                                                   ("bb-shared-worker")
3. on match:
     GET /accounts/{id}/workers/subdomain        → current account subdomain
     current hostname = <scriptName>.<subdomain>.workers.dev
```

Matching by **script name** is why we deploy under a fixed `scriptName`
(`WORKER_DEPLOY_DEFAULTS.scriptName`). The `<subdomain>.get` read is the
authoritative answer to §10 — whatever the hostname became on claim, we read it
rather than guess. (If two accounts both contain a `bb-shared-worker`, disambiguate
by hitting each candidate's `GET /` and matching the one whose `TUNNEL_SECRET`
handshake our in-memory/persisted tunnelSecret satisfies.)

### 11.4 Confirm, redeploy, undeploy through OAuth

- **Confirm (claimed):** a successful discovery (§11.3) that finds
  `bb-shared-worker` under a real (non-temp) account **is** the trustworthy claim
  confirmation — it is a signed, owner-consented read of CF's own state, strictly
  stronger than the survival probe. Set `claimed = true` from *this*.
- **Redeploy:** with `workers-platform.write`, re-run the existing
  `scripts.update` upload (`plugin/worker-lifecycle/cf-deploy.ts`) but against the
  **claimed account id** using an OAuth **access token** instead of the temp
  `apiToken`. Same code path, different credential + account. New worker code,
  fresh `TUNNEL_SECRET` binding, tunnel rotated as today.
- **Undeploy:** `DELETE /accounts/{id}/workers/scripts/{scriptName}` with the
  access token. No more dashboard-link hand-waving — the plugin does it directly.
- **Token refresh:** access tokens are short-lived; when one 401s, exchange the
  persisted `refresh_token` at `<TOKEN_URL>` for a new access token (+ possibly a
  rotated refresh token — store the rotation). If the refresh token is revoked
  (owner revoked consent in the CF dashboard), the plugin drops to "not connected"
  and re-prompts Connect. **Refresh/rotation lifetimes are undocumented on the
  pages read — confirm from the API reference.**

### 11.5 What gets persisted now (revises §3)

`bb.storage.kv` claimed record becomes:

```ts
oauthWorkerRecordSchema = z.object({
  claimed: z.literal(true),          // set only from an OAuth-verified discovery (§11.4)
  cfRefreshToken: z.string(),        // SECRET — NEW persisted secret (see trust note below)
  claimedAccountId: z.string(),      // which account owns the worker (for API calls)
  scriptName: z.string(),            // discovery key
  // hostname is NOT trusted from disk — re-resolved via §11.3 on every start.
  // tunnelSecret still persisted so the tunnel can re-dial without a redeploy:
  tunnelSecret: z.string(),          // SECRET
  lastKnownUrl: z.string().optional(),   // cache/UX only; re-verified, never trusted
  deploymentId: z.string(),
  generation: z.number(),
  deployedAt: z.number(),
  claimedAt: z.number(),
})
```

**Trust-model note (owner asked to weigh this).** The `cfRefreshToken` is a **new
persisted secret**, and a stronger one than anything v0 stored: it is a
long-lived, refreshable credential to the owner's **real** Cloudflare account,
scoped to Workers read/write. The old temp `apiToken` we stopped persisting was
bounded (60-min, one throwaway account); this refresh token is not. Against SPEC
§"Trust model" (local-disk-is-the-boundary, plaintext KV), that boundary now
guards a materially higher-value item. Recommended mitigations, in order:

1. **Narrowest scopes** — Workers read/write on a single account, nothing else;
   make write optional so a read-only owner never persists a write-capable token.
2. **Promote KV encryption from v1-candidate to a prerequisite for this feature.**
   The map already lists "encrypt KV with a device-tied key (macOS Keychain)" as a
   v1 candidate prioritising `apiToken`; the refresh token inherits that priority
   and arguably makes Keychain storage mandatory rather than optional.
3. **Revocable by design** — the owner can revoke consent in the CF dashboard at
   any time; document this as the kill switch, and have the plugin degrade
   gracefully (§11.4) when it happens.

`access_token` stays memory-only. `claim.url`, temp `apiToken`, temp `accountId`
remain memory-only/never-persisted as before.

## 12. Restart scenarios under OAuth

**A. Connected + claimed, restart (Invariant B happy path).**
```
start → load oauth record { claimed, cfRefreshToken, claimedAccountId, tunnelSecret, … }
      → refresh access_token from cfRefreshToken
      → discover (§11.3): GET scripts under claimedAccountId, read current subdomain
          found → current hostname resolved LIVE (stale lastKnownUrl irrelevant)
                → re-attach SharedTunnel with persisted tunnelSecret at the live host
                → state=live. No redeploy.
          not found → worker was deleted in dashboard; wipe record, idle,
                      bootstrap fresh temp worker on next mint.
      → refresh revoked → drop to "not connected", keep serving via any live
                          in-memory tunnel if present, prompt Connect.
```
Invariant B holds, and now **robustly across a hostname change on claim** (§10),
because the hostname is re-resolved from CF rather than read from disk. This is
the concrete failure the old §5.1 would have hit and OAuth fixes.

**B. Not yet connected, unclaimed worker, restart.**
Identical to §5.2: nothing persisted (no OAuth record, unclaimed worker never
written), `load()` → idle, fresh temp deploy on next mint, new `claim.url` in
memory. Invariant A holds.

**C. Claim completed in the dashboard but owner has NOT connected by OAuth,
restart (the old §5.3 window).**
No OAuth record yet, so `load()` → idle and the plugin redeploys a fresh temp
worker; the claimed one is momentarily orphaned. **OAuth shrinks but does not by
itself erase this window** — it is closed the moment the owner completes Connect,
because discovery (§11.3) then finds the real worker and re-adopts it (re-attaching
via the persisted/again-resolved tunnelSecret, or redeploying fresh code to it via
§11.4). Practically: prompt Connect immediately after the owner opens the claim
URL, so the connected state — and thus Invariant B — is established without waiting
on any TTL. The optional survival probe (§2) can still cover the gap for an owner
who claims but delays Connect.

## 13. Recorded, not adopted — "recent hosts, use the latest"

Owner's lightweight alternative to OAuth: have the local tunnel record every
worker **hostname** that successfully authenticates with our `tunnelSecret` into a
"recent hosts" list, and treat the **latest** as the live worker.

- **It is only a claim signal if the hostname changes on claim** (§10). If the
  hostname is stable, a claim produces no new host, so "latest host" tells you
  nothing about claim state — it cannot distinguish claimed from unclaimed.
- If the hostname **does** change on claim into an existing account (the likely
  case, §10.2), then a *new* host dialling in with the *same* `tunnelSecret` is a
  plausible "the worker moved / was claimed" hint — the owner's intuition is
  internally consistent with §10.
- **Why not adopted:** (a) it is a weak, inferential signal that still cannot read
  the *current* hostname authoritatively, do redeploy, or do undeploy — it only
  notices a move after the fact; (b) it depends on the very hostname-change fact
  the docs don't confirm (§10.3), so it would ship on an unverified assumption;
  (c) OAuth supplies the current hostname, claim state, and management directly and
  is the chosen path. Recorded here as the fallback we would reach for **only if
  OAuth were not built** — pair it with the §2 survival probe in that
  counterfactual.

## 14. Revised recommendation

**Build Cloudflare OAuth as the source of truth in v1.** It resolves every open
question the temp-account API leaves dangling:

- **Claim confirmation** becomes a signed, owner-consented read of CF's own state
  (§11.4) — strictly stronger than the survival probe, and available immediately
  on Connect rather than only after the 60-minute TTL.
- **The hostname question (§10) stops mattering to correctness:** the plugin reads
  the worker's *current* hostname from `GET /accounts/{id}/workers/subdomain`
  every start, so a hostname that changes on claim (the likely existing-account
  case) can never leave a stale `url` in play. This is the decisive reason to
  prefer OAuth over any persisted-hostname or "recent hosts" scheme.
- **Redeploy/undeploy** become first-class API calls (§11.4), retiring the
  dashboard-link MVP.

Persist only `cfRefreshToken` (+ `claimedAccountId`, `scriptName`, `tunnelSecret`,
non-secret metadata); re-resolve the hostname live; never trust `lastKnownUrl`.
Keep the survival probe (§2) **only** as the pre-Connect fallback, and keep
"recent hosts" (§13) recorded-but-unbuilt.

**One caveat carried forward, unresolved by docs:** the exact **authorize/token
endpoint URLs**, the **complete scope identifiers** (especially account-read), and
**refresh-token lifetimes/rotation** are not on the OAuth pages I could reach —
confirm them from the CF OAuth API reference or by inspecting `wrangler login`
before implementation. And close §10 empirically (the two-account claim test)
even though OAuth makes correctness independent of the answer — it still tells us
whether guest URLs an owner already shared survive a claim.

**Trust-model consequence to accept explicitly:** OAuth introduces a long-lived
`cfRefreshToken` to the owner's real CF account as a persisted secret, replacing a
bounded throwaway `apiToken`. This makes device-tied KV encryption (already a v1
candidate) effectively a prerequisite for shipping the OAuth path, not an optional
follow-up.
