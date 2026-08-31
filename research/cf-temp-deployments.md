# Cloudflare temporary deployments for agents — research

Spike output for issue [01](../.scratch/v0/issues/01-spike-cf-temp-deployments.md).
PoC: [spikes/echo-worker/](../spikes/echo-worker/).

Status: **transport plan viable in principle**, but the 60-minute unclaimed-account
lifetime forces the "log in with Cloudflare" flow (originally slated for v2) to
become part of v0 first-run setup for any owner who wants share URLs that outlive
one grilling session.

## TL;DR

| Question | Answer |
|---|---|
| **WebSocket upgrades supported?** | Yes (implicit — a temp deployment is a normal Worker on `*.workers.dev`, and WS is a baseline Workers feature on all plans; nothing in the temp-account limits excludes it). |
| **Durable Objects supported?** | Yes (explicit — the claim-deployments page lists "Deploy Workers with Durable Object bindings and migrations"). |
| **Anonymous deploy?** | Yes — no CF account required. `wrangler deploy --temporary` (Wrangler ≥ 4.102.0) or `POST /client/v4/provisioning/previews` (returns a scoped API token + claim URL). |
| **Deploy latency** | "Live worker in seconds" per CF; proof-of-work challenge adds a variable slice of client CPU up-front. Per-script deploy is a normal Workers PUT (sub-second typical after account exists). |
| **Cold start** | Same as any Worker: sub-10 ms for JS-only, higher for scripts with big module trees. Not different for temp accounts. |
| **Quota** | 1 D1 (100 MB), ≤ 10 queues, ≤ 1000 static assets @ 5 MiB, Hyperdrive ≤ 2 configs / 10 conns, KV standard operations, mTLS uploads. Rate-limited account creation, guarded by proof-of-work. |
| **Account lifetime** | **60 minutes to claim, otherwise account + all resources deleted.** No extension mechanism — a re-run just makes a fresh account with a fresh URL. |
| **Claim path** | Backend response contains `claim.url` (bearer, ≤ 60 min). Human opens it, signs into (or creates) a CF account, resources migrate. After claim, the Worker + its `*.workers.dev` URL stay put in the claimed account and no longer expire. |

## The critical question first — WS + DO

- **Durable Objects: yes, explicit.** The [claim-deployments docs](https://developers.cloudflare.com/workers/platform/claim-deployments/)
  list "Deploy Workers with Durable Object bindings and migrations" as a
  supported capability of a temporary account.
- **WebSockets: yes, implicit.** The docs don't call out WS anywhere, but they
  don't exclude it either. A temp deployment is served from `<script>.<sub>.workers.dev`,
  and the entire Workers WebSocket API (`WebSocketPair`, hibernatable WS via DO,
  server-side `webSocket.accept()`) is a runtime feature that has never been
  gated per plan or per subdomain type. There's no compatibility flag needed.
  Confirmed by inspection: no doc in the "limits" section mentions WS, sockets,
  upgrade headers, or `connect()`. The echo-worker PoC uses `WebSocketPair`
  and deploys against a normal `workers_dev = true` config.

**Verdict: the transport plan is not invalidated.** Proceed with 07, 08, 11, 14.

## Big caveat that IS load-bearing — 60-minute lifetime

Quoting the docs: "If the user does not complete the claim, Cloudflare deletes
the account and its resources." Claim window is 60 minutes. There is no
"extend" endpoint — you re-run `wrangler deploy --temporary`, which provisions
a **new** account with a **new** `*.workers.dev` URL. Guest URLs pinned to the
old URL become invalid.

This is fine for the SPEC's stated "in-memory only, dies with plugin restart"
guarantee **as long as** a session lasts under an hour. For anything longer,
we have three options:

1. **Redeploy + reissue URLs.** Guest URLs rotate every ~55 minutes. Ugly, but
   works for the "just for this grilling session" story. Owner reshares.
2. **Force CF claim as v0 first-run.** Owner claims within the first hour after
   ever using bb-shared. After claim, the worker sits in their real CF account,
   guest URLs stay stable forever, quotas become the CF free/paid tier. This
   was already the v2 plan; the 60-min limit means it's a hard prerequisite for
   any "stable share URL" story, so it should move to v0.
3. **Hybrid.** Ship v0 with temp-only + rotating URLs; add "claim your CF
   account for stable URLs" as an inline nudge in the share dialog. Owner
   claims when they hit the pain.

Recommendation: **(3).** Lets us ship the spike-validated transport without
blocking on a CF-login UI, and makes the upgrade path a natural user prompt
rather than a first-run wall.

## Anonymous deploy API surface

Two paths, same underlying provisioning:

### Path A — Wrangler CLI (`wrangler deploy --temporary`)

- Requires Wrangler 4.102.0+.
- Runs the proof-of-work + `POST /provisioning/previews` under the hood, then
  performs the normal script PUT with the temp API token.
- Prints a claim URL to stdout for the human.
- Requires bundling wrangler into the plugin (or shelling out to `npx wrangler`).
- Downside: heavy dependency, opaque control over the claim URL (we want to
  capture it programmatically to render in the owner UI, not just print).

### Path B — REST + Cloudflare SDK (`cloudflare` npm)

Direct control, preferred for us:

1. `POST https://api.cloudflare.com/client/v4/provisioning/previews/challenge`
   (empty body) → challenge params `{ challengeToken, seed, k, g }` where
   `k * g ≤ 64,000,000`.
2. Compute the proof-of-work: build `k+1` 32-byte checkpoints by chaining
   SHA-256 from the seed with `g` iterations per segment. Base64-encode the
   concatenated checkpoints.
3. `POST https://api.cloudflare.com/client/v4/provisioning/previews` with:
   ```json
   {
     "termsOfService": "https://www.cloudflare.com/terms/",
     "privacyPolicy": "https://www.cloudflare.com/privacypolicy/",
     "acceptTermsOfService": "yes",
     "challengeToken": "<from step 1>",
     "solution": { "checkpoints": "<base64 checkpoints>" }
   }
   ```
   Response:
   ```json
   {
     "result": {
       "account": { "id", "name", "type": "standard", "apiToken", "tokenId", "expiresAt" },
       "claim":   { "token", "url", "expiresAt" }
     }
   }
   ```
4. Use `apiToken` with the standard [`cloudflare`](https://www.npmjs.com/package/cloudflare)
   SDK to upload the script (`client.workers.scripts.update`) and read the
   account subdomain (`client.workers.subdomains.get`). Final URL:
   `https://<scriptName>.<subdomain>.workers.dev`.

Reference implementation (from CF docs, verbatim):

```typescript
import Cloudflare from "cloudflare";

export async function deployWorker(
  accountId: string,
  apiToken: string,
  scriptName: string,
  compatibilityDate: string,
  scriptContent: string,
) {
  const client = new Cloudflare({ apiToken });
  const workerModule = new File([scriptContent], "worker.mjs", {
    type: "application/javascript+module",
  });

  await client.workers.scripts.update(scriptName, {
    account_id: accountId,
    metadata: {
      main_module: "worker.mjs",
      compatibility_date: compatibilityDate,
    },
    files: [workerModule],
  });

  const { subdomain } = await client.workers.subdomains.get({
    account_id: accountId,
  });

  return `https://${scriptName}.${subdomain}.workers.dev`;
}
```

For a Worker with Durable Objects, the `metadata` payload needs `bindings`
and `migrations` fields — the SDK's `WorkersScriptUpdateParams` covers both.
See `spikes/echo-worker/deploy.ts` for the extended shape.

## Auth model

- **Bootstrap credential:** none. The proof-of-work challenge is the only
  gate. Cloudflare mints an account + token in response.
- **`account.apiToken`:** short-lived, server-only bearer. Used for all
  subsequent script/subdomain/binding operations. **Do not expose in browser
  responses or client-side code** (per CF docs).
- **`claim.token`/`claim.url`:** the humans-only bearer. Anyone with the URL
  can claim ownership. Treat as a secret; render in owner UI only, never
  send to guests.

Both credentials expire in ≤ 60 min if unclaimed. On claim, the worker
migrates into the claimed account and continues on a normal-account token
lifecycle.

## Deploy latency & cold start

- CF's blog says "live worker in seconds". Not benchmarked here — the PoC is
  ready to run but a real deploy requires network egress from a machine
  willing to hit `api.cloudflare.com`. See "Blocker" below.
- Proof-of-work is the variable cost; `k*g ≤ 64,000,000` SHA-256 iterations
  in the worst case. On a modern laptop that's low single-digit seconds.
- Once the account exists, script upload is a normal PUT — sub-second.
- Cold-start on invoke is unchanged from regular Workers: sub-10 ms for
  small JS-only Workers; DO cold-start adds ~50–100 ms on first invoke of
  a fresh DO instance, cheap on warm.

## Quota per anonymous deploy (from docs, verbatim)

| Resource | Limit |
|---|---|
| Workers | Deployments on `workers.dev` |
| Workers Static Assets | Up to 1,000 files, each ≤ 5 MiB |
| Workers KV | Standard namespace/key operations |
| D1 | 1 DB, 100 MB per DB, 100 MB total |
| Durable Objects | Bindings + migrations supported |
| Hyperdrive | ≤ 2 configs, ≤ 10 connections |
| Queues | ≤ 10 |
| mTLS / CA certs | wrangler cert upload/list/delete |

Not documented but relevant to us: WS connection count, request rate,
sub-request limits per invocation — assumed to follow the free Workers plan
(1000 sub-requests, 30 s CPU on paid, 10 ms on free, 100 WS per invocation).
Worth benchmarking before claiming pricing behaviour.

Also: `--temporary` only works in unauthenticated mode, and account creation
is rate-limited; a busy owner who redeploys every 55 min could plausibly hit
that limit — another reason to push the claim flow.

## Claim upgrade path

1. Backend receives `claim.url` from the provisioning response.
2. Owner UI surfaces it as a button ("Keep this worker: claim in Cloudflare").
3. User clicks → CF dashboard prompts sign-in / signup → claim button →
   resources move into their account. **The worker script, its bindings, and
   its `*.workers.dev` URL stay stable** — the account underneath simply
   changes ownership.
4. Post-claim, the plugin needs the owner's new account ID + a durable API
  token. Post-claim workflow is **out of scope for
   this spike** — it belongs to whichever ticket adds the "stable URL" story.

There is no webhook or callback from CF telling us the account has been
claimed; the plugin has to poll (`GET /client/v4/accounts/{account.id}`
with the original apiToken — that token *may* still be valid post-claim,
docs are silent) or trust the human to say "done".

## Recommended shape for our deploy code

Follow **Path B** (REST + `cloudflare` SDK). Keep it in a small module inside
the plugin backend (Node process; not the worker), roughly:

```
plugins/bb-shared/src/deploy/
  challenge.ts     // POST .../previews/challenge, solve PoW
  provision.ts    // POST .../previews with the solution
  upload.ts       // cloudflare SDK: scripts.update + subdomains.get
  index.ts        // deployWorker(source: string): Promise<{ url, apiToken, accountId, claim }>
```

- npm deps: `cloudflare` (SDK), Node built-in `crypto.subtle` for SHA-256.
  No wrangler dependency.
- Bundle the compiled worker source into the plugin at build time (from
  `apps/connect/src/worker.ts` fork). Read from disk at deploy time, pass
  as a string.
- Store `{ url, apiToken, accountId, claim, expiresAt }` in plugin memory
  (per SPEC). On expiry (or ping failure), redeploy.
- Expose the `claim.url` in the owner UI as an optional "claim this worker"
  affordance.

## Blocker on the PoC (real deploy)

The PoC in `spikes/echo-worker/` is complete and locally testable with
`wrangler dev` (which spins up the worker on `localhost` including WS). A
real `wrangler deploy --temporary` requires:

- Network egress to `api.cloudflare.com` — the agent sandbox on `mactom`
  restricts network hosts (allowlist empty in this session).
- Wrangler ≥ 4.102.0 installed globally or invoked via `npx`.

Runbook is in `spikes/echo-worker/README.md`. Run from a machine with open
egress:

```bash
cd spikes/echo-worker
npm install
npx wrangler dev            # local; open http://127.0.0.1:8787 and ws://127.0.0.1:8787/ws
npx wrangler deploy --temporary    # provisions + deploys; prints URL and claim link
```

## Sources

- Cloudflare blog — [Temporary Cloudflare accounts for agents](https://blog.cloudflare.com/temporary-accounts/)
- Docs — [Claim Workers deployments](https://developers.cloudflare.com/workers/platform/claim-deployments/)
- Docs — [WebSockets in Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- Docs — [Compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)
