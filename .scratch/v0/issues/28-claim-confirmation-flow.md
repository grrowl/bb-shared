Status: open
Type: task
Severity: high (unblocks claimed-worker reuse)
Blocked by:
Found by: UX grilling + hand-compute (2026-08-28)

Confirmed-claim flow so the plugin can trust that a worker was claimed, keep
claimed workers across restart, and never orphan one.

## Why

Hand-computing the worker lifecycle (see the trace in the parent thread) showed
that claiming is fire-and-forget: the owner opens a claim URL in a browser and
the plugin never learns the outcome. Two required rules cannot both hold
without a confirmation signal:

- Invariant A: a worker in use must always be claimable. Its claim link must be
  reachable while it serves guests.
- Invariant B: a claimed worker is permanent and must be reused across a bb
  restart, never orphaned.

Trace C: owner claims a worker, then restarts. The plugin persisted nothing for
the unclaimed worker, so on restart it deploys a fresh one and the claimed,
permanent worker is orphaned and runs under the owner's account serving nobody.
Naive fixes (persist and reuse every worker, or mark claimed on button click)
each break Invariant A on the restart-within-the-60-minute-window edge.

Root cause: the plugin cannot tell a disposable unclaimed worker from a
permanent claimed one, because it never learns that a claim happened.

## Target model (aligned 2026-08-28)

- Unclaimed workers: session-only, held in plugin memory, never written to
  disk, recreated fresh each session. Their claim link is always in memory
  while in use, so Invariant A holds within a session.
- Claimed workers: persisted and reused across restart. Persist ONLY url +
  tunnelSecret plus non-secret metadata. apiToken, accountId, and the claim
  link are never written to disk; they live in memory for the session only.
- A trustworthy `claimed` flag, settable only from a CONFIRMED claim, not a
  button click. This is the thing to build.

Consequence for the persistence model (supersedes the "persist the full worker
record" design in issue 07): disk holds a worker record only for a claimed
worker, and only url + tunnelSecret + metadata. See the worker-record schema in
`plugin/worker-lifecycle/worker-record.ts` (currently persists apiToken /
accountId / claim — all three come off disk under this model).

## Research (in progress)

Design subthread `thr_vt4cfz8uxz` is researching the specifics and will write
`research/claim-confirmation.md`. Targets:
- https://developers.cloudflare.com/changelog/post/2026-07-14-temporary-accounts-api/
- https://developers.cloudflare.com/workers/platform/claim-deployments/#integrate-with-the-rest-api

Open questions it must answer:
1. Can the plugin observe claim status (poll endpoint, status field, webhook)?
2. What does the claim-deployments REST integration return that we can key off?
3. Does the workers.dev url survive a claim, or does the subdomain change when
   the account moves to the owner? If it changes, a persisted url is stale.
4. Can the WORKER detect it is claimed and call back to the plugin over the
   existing tunnel/authz channel to confirm? (Owner's idea.)
5. Redeploy/undeploy of a claimed worker: via Cloudflare OAuth, or a link to
   the worker's resource URL on the Cloudflare dashboard. Minimal viable path.

## Answer

Full design and citations: [research/claim-confirmation.md](../../research/claim-confirmation.md).

Reliable claimed-worker reuse IS achievable with today's Cloudflare APIs, with
one bounded residual.

Cloudflare exposes no positive claim signal at all: no poll endpoint, no status
field, no webhook, and no worker-runtime binding (both docs read in full). So
the plugin cannot be told a claim happened. It proves one to itself from the one
hard guarantee CF makes: an unclaimed temp account is deleted at 60 minutes, a
claimed one lives on. A worker still reachable meaningfully past its `expiresAt`
has therefore been claimed, and a button click cannot produce that state. That
survival probe is the trustworthy `claimed` flag.

Chosen design:
- Confirmation: the existing health tick probes the worker URL once at
  `now >= expiresAt + CONFIRM_MARGIN` (~5 min). Alive means claim confirmed;
  dead means expired-unclaimed. No CF API call, no apiToken, no OAuth, no worker
  callback. Uses `healthCheck()` already in `worker-lifecycle.ts`.
- Persistence: everything is memory-only for every worker. On confirmation the
  plugin promotes ONLY `url + tunnelSecret + claimed + non-secret metadata` to
  `bb.storage.kv`. `apiToken`, `accountId`, and `claim.url` never touch disk.
  Unclaimed workers are never persisted, so their claim link is always fresh in
  memory while in use (Invariant A).
- Reuse on restart: a claimed record re-attaches the tunnel from
  `url + tunnelSecret` with no CF call. The workers.dev URL is stable across a
  claim (confirmed from the docs), so the persisted url is valid (Invariant B).
- Redeploy/undeploy of a claimed worker (v1 MVP): treat a claimed worker as a
  frozen, stable endpoint. The plugin drives its tunnel and never pushes new
  code. To update, the owner deletes it via a CF dashboard link, the plugin's
  health probe fails, and it bootstraps a fresh temp worker to re-claim.
  Programmatic redeploy is deferred to the v2 Cloudflare OAuth path the docs
  recommend.

The residual (needs an owner decision): a bb restart that lands in the
[claim-time, expiresAt] window, before confirmation can fire, orphans the
just-claimed worker (its tunnelSecret lived only in lost session memory). It is
bounded to <=60 min, self-closing, and recoverable (the orphan shows up in the
owner's Workers dashboard to delete). It is irreducible without persisting
unclaimed workers tentatively, which breaks the never-persist-unclaimed rule for
no gain. Recommended for acceptance as an L4-class residual.

## Direction change (owner, 2026-08-28, after the survival-probe design)

The owner chose to build Cloudflare OAuth now, and to make OAuth the source of
truth for claim confirmation and worker identity. Once the owner connects the
claimed account by OAuth, the plugin reads claim state, the worker's current
hostname, and manages redeploy/undeploy from the Cloudflare API directly. So:

- The survival-past-TTL probe above is demoted. It is dropped, or kept only as
  a fallback for the short window before the owner has connected by OAuth. The
  OAuth connection is the real confirmation signal.
- One fact must be settled before either mechanism is built: does the
  workers.dev hostname change on claim? The survival-probe design assumed the
  URL is STABLE across a claim (research §1.2, from CF docs). The owner assumes
  it CHANGES, because a workers.dev host is `<script>.<account-subdomain>` and
  claiming into an existing account could move the worker to that account's
  subdomain. This is unresolved: the docs quote says resources "remain in the
  claimed account", but the claim-into-existing-account case is not covered.
  A stale persisted url depends on this too.
- Owner's lightweight alternative to OAuth, recorded but not chosen as primary:
  record every host that authenticates with our secret into a "recent hosts"
  list and use the latest. This only yields a claim signal if the hostname
  changes on claim, so it also hangs on the fact above.

The design subthread (thr_vt4cfz8uxz) is being re-tasked to settle the hostname
behavior and design the OAuth connect/confirm/manage flow that replaces the
probe. Its output updates this Answer.

## RESOLVED: OAuth is the design (supersedes the survival probe above)

Design in research/claim-confirmation.md §§9-14. The survival probe (§2) and the
"stable hostname" claim (old §1.2) are demoted/corrected in place.

- OAuth is feasible in v1. Cloudflare shipped self-managed public OAuth clients
  (changelog 2026-06-03). Use a public client with PKCE, because the plugin
  runs on the owner's machine and cannot hold a client secret. Register the
  client once and ship the `client_id` in the plugin. Authorization-code is the
  only third-party grant CF supports.
- Scopes: workers-platform read and write (write optional so a cautious owner
  can grant read only) plus an account-read scope.
- Discovery, not persistence: after the owner connects, list accounts, find the
  worker by script name, and GET the account's workers subdomain for the LIVE
  hostname. That signed, owner-consented read IS the claim confirmation. It is
  stronger than the survival probe and available at connect time instead of
  after 60 minutes.
- Redeploy and undeploy become first-class API calls against the claimed
  account (scripts.update / DELETE scripts), so a claimed worker is no longer a
  frozen endpoint.
- Hostname on claim: the owner was right. An account has exactly one workers.dev
  subdomain, so a worker claimed into an existing account serves at that
  account's subdomain, i.e. the hostname CHANGES. The docs do not state this
  outright, so it is a strong structural inference with an empirical two-account
  test noted. A persisted url can be stale, which is a second reason OAuth
  (read the live hostname every start) is the right source of truth.

Persistence under OAuth: persist `cfRefreshToken` + `claimedAccountId` +
`scriptName` + `tunnelSecret` + metadata. Re-resolve the hostname live every
start, never trust it from disk.

Two caveats carried forward:
1. The exact authorize/token endpoint URLs, the full account-scope identifiers,
   and refresh-token lifetimes are not on the OAuth pages the design thread
   could reach. Confirm from the CF OAuth API reference or by inspecting
   `wrangler login` before building.
2. The persisted `cfRefreshToken` is a long-lived credential to the owner's
   REAL Cloudflare account. This is a MORE sensitive at-rest secret than the
   temp apiToken we removed, so device-tied KV encryption is now effectively a
   prerequisite for shipping this path. See issue 29.

## Follow-ups this design creates

- Supersede `SPEC.md` §"Worker lifecycle": replace the fire-and-forget claim
  posture with the survival-confirmed claim flow.
- Change `plugin/worker-lifecycle/worker-record.ts`: split the single
  persist-everything `WorkerRecord` into a memory-only session record and a
  claimed-only disk record (`claimed` + `url` + `tunnelSecret` + metadata).
  Drop `apiToken`, `accountId`, and `claim` from disk. This also resolves the
  at-rest crown-jewel concern that the v1 "KV encryption" candidate was for.
- UX consequence for the worker status pill (surface 2): a claim is not
  confirmed until ~60 min in, so right after the owner claims, the pill must
  keep showing the temporary state, not "claimed". Add an honest interim state.
- Implementation detail to resolve: the health tick only runs while tokens are
  live, so a worker whose shares are all removed before minute 60 never gets
  its confirmation probe. Decide whether confirmation should run regardless of
  token count once a claim link has been opened.

## Comments
