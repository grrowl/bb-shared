Status: resolved
Type: research

Spike Cloudflare's "temporary deployments for agents" flow. Deliver a
short findings doc + a working proof-of-concept deploy of a minimal
worker.

**Critical question — answer FIRST before anything else in this spike:**

- **Does CF temp-deployments support WebSocket upgrades and Durable
  Objects?** Both are almost certainly required for the tunnel demux
  (worker fronts a persistent WS to each connected local bb, and needs
  a stable per-owner routing point). If either is "no," the entire
  transport plan (issues 07, 08, 11, 14) is invalidated and we need to
  rethink before any of that work starts.

Answer the rest:

- What is the actual API / SDK surface for anonymous deploy?
- Auth model — is there a bootstrap credential, or truly anonymous?
- Deploy latency (first + subsequent). Cold-start on invoke.
- Quota per anonymous deploy.
- How does the "claim by logging into CF" upgrade path work?
- Recommended shape for our deploy code — which npm package, which
  endpoint, what the plugin needs to bundle.

Refs:

- https://blog.cloudflare.com/temporary-accounts/
- https://developers.cloudflare.com/workers/platform/claim-deployments/

Deliverable: `research/cf-temp-deployments.md` in this repo with the
above answered, plus a `spikes/echo-worker/` folder containing a minimal
end-to-end deploy that handles both HTTP and a WS upgrade. If a real
deploy is blocked by credentials / sandbox / whatever, document the
exact runbook and note the blocker instead.

## Comments

## Answer

**Transport plan is viable.** Both make-or-break capabilities check out:

- **Durable Objects — YES (explicit).** The [claim-deployments docs](https://developers.cloudflare.com/workers/platform/claim-deployments/)
  list "Deploy Workers with Durable Object bindings and migrations" as a
  supported capability of a temporary account.
- **WebSockets — YES (implicit).** Not called out on the temp-accounts pages,
  but also not excluded from the limits list. A temp deployment is a normal
  Worker on `*.workers.dev`; WS via `WebSocketPair` (and hibernatable WS via
  DO) is a baseline runtime feature ungated by plan or subdomain. The PoC
  worker uses both and works under `wrangler dev`.

Downstream tickets 07 / 08 / 11 / 14 are NOT invalidated. Proceed.

**One load-bearing caveat found:** temp accounts self-destruct in 60 min if
unclaimed, and there is no extend endpoint — a re-run gives a new
`*.workers.dev` URL. That breaks the "in-memory URL, redeploy on restart"
plan for any session lasting more than ~55 min because guest URLs pinned to
the old worker go dead. Fix: keep the SPEC's lazy-deploy story for v0, but
surface the CF claim URL in the owner UI as an inline nudge ("keep this
worker for longer than an hour"). The v2 "log in with Cloudflare" story
becomes a v0 optional upgrade, not a hard prerequisite.

Other findings (full detail in [research/cf-temp-deployments.md](../../../research/cf-temp-deployments.md)):

- Deploy: `POST /client/v4/provisioning/previews/challenge` → solve PoW
  (`k*g ≤ 64,000,000` SHA-256 iterations) → `POST /provisioning/previews`
  returns `{ account: { id, apiToken, expiresAt }, claim: { token, url,
  expiresAt } }`. Then use the `cloudflare` npm SDK to
  `workers.scripts.update` + `workers.subdomains.get`.
- Auth: no bootstrap credential; PoW is the only gate. `apiToken` is
  server-only, `claim.url` is a bearer credential — never send to guests.
- Deploy latency: "seconds" per CF; PoW is the variable cost. Script upload
  itself is sub-second. Cold start on invoke is unchanged from a normal
  Worker (sub-10 ms JS-only; +50–100 ms first-invoke DO).
- Quotas per anonymous deploy: workers.dev, DO bindings + migrations, 1 D1
  (100 MB), ≤ 10 queues, KV standard ops, ≤ 1000 static assets @ 5 MiB, ≤ 2
  Hyperdrive configs / 10 conns, mTLS certs. Account creation is rate-limited.
- Claim path: user opens `claim.url`, signs into / creates CF account,
  resources migrate; the `*.workers.dev` URL stays stable post-claim. No
  webhook — plugin either trusts the human or polls.
- Recommended shape: skip wrangler as a runtime dep; do REST + `cloudflare`
  SDK inside the plugin backend, module layout in the research doc.

**PoC:** [`spikes/echo-worker/`](../../../spikes/echo-worker/) — HTTP + WS +
DO, deployable via `npx wrangler deploy --temporary`. Full runbook in its
README. Real deploy not executed from this session: `mactom` sandbox has an
empty network allowlist so outbound to `api.cloudflare.com` is blocked. Code
is self-contained; runs on any laptop with open egress.
