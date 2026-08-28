Status: resolved
Type: task
Blocked by: 01, 04, 14

Plugin-side manager for the CF worker lifecycle. Owns deploy, redeploy,
health, and secret provisioning end-to-end. (Absorbs former issue 13.)

## Lifecycle

- **Persist worker state in `PluginSettings`** (bb's per-plugin durable
  storage). Fields:
  `{ deploymentId, url, apiToken, expiresAt, claim: { url, expiresAt } }`.
  Narrow exception to v0's "no persistence" stance — worker state
  only, tokens still in-memory.
- On plugin start: read PluginSettings; if a worker record exists,
  health-check it. Alive → reuse. Dead / missing / expired → wipe
  settings and bootstrap fresh on next mint.
- Lazy deploy on first mint / share (if no worker in settings yet).
- Health check: ping worker on panel open + every 60s while any token
  is live.
- On health-check failure: wipe settings + bootstrap fresh.
- Expose `getWorkerStatus()` RPC.
- Broadcast realtime updates on state change so the management panel
  reflects deploy / health transitions.

## CF claim nudge (v0)

Unclaimed CF temp accounts self-destruct in 60 minutes. Owner UI (via
16's management panel) surfaces the CF `claim.url` from the deploy
response as an inline nudge:

"This worker expires in NN min. Claim it to keep it alive: [claim link]"

Countdown driven by `account.expiresAt`. On expiry: worker health-check
fails, 07 wipes settings and bootstraps fresh — guest URLs already
handed out die anyway because tokens are in-memory. v0 does NOT track
claim state — if the user claims via OAuth, the worker keeps running
until our `apiToken` is revoked or account behavior changes; we notice
via health check and re-bootstrap. v2 wraps claim in a proper OAuth
flow that captures the claimed account and continues managing under
it. `claim.url` is a bearer credential — never send to guests, never
log it.

## Deploy pipeline (absorbed from former issue 13)

- Bundle the worker output (issues 08–12).
- Deploy via the CF SDK / API identified in spike 01.
- Returns `{ url, deploymentId }`.
- Redeploy handles rotation and secret refresh.
- CF error handling + retry with backoff.

## Secret provisioning

Two secrets are minted / retrieved at deploy time, injected into the
worker as env vars, and made available to the tunnel client (14) at
startup.

1. **Authz endpoint secret** — worker calls
   `GET /api/v1/plugins/bb-shared/http/authz` with a bearer. Source:
   bb's built-in `PluginHttp` `auth: 'token'` mechanism, retrieved on
   plugin start via bb's `bb plugin token bb-shared` equivalent. Not
   our design — just plumb it.

2. **Tunnel handshake secret** — between the local tunnel client (14)
   and our worker (08). Source: TBD by spike 02 — either reuse bb's
   `bbcm_…` machine-credential shape or mint our own.

   **This design must get an adversarial review pass before
   implementation lands** — a bb codex/sol subthread review. Threat
   model to test:
   - Worker impersonation (attacker deploys look-alike worker, tunnel
     client dials it).
   - Tunnel-secret leak from deployment logs / env inspection.
   - Replay across redeploys.
   - Cross-owner secret reuse if a worker deploy is misrouted.

   If we mint our own: HMAC the tunnel-identifier, rotate on every
   redeploy, no bearer reuse across deploys.

Flow:

- On deploy: 07 gathers both secrets, passes them to the deploy call
  as env vars for the worker.
- On tunnel client start (14): 07 hands the tunnel secret to
  `startTunnel(url, secret)`.
- On redeploy: 07 mints a fresh tunnel secret, redeploys with it,
  restarts the tunnel client with the new secret.

## Comments

## Answer

Delivered a single `WorkerLifecycle` service mounted under
`bb.background.service("worker-lifecycle", …)` that owns the CF worker
end-to-end: deploy pipeline, secret provisioning, health/redeploy loop, the
`SharedTunnel` it drives, and the CF claim nudge.

### Module structure — `plugin/worker-lifecycle/`

- `pow.ts` — PoW solver (SHA-256 checkpoint chain, `k*g ≤ 64M` cap). Pure +
  unit-tested (real SHA-256 oracle) since there's no CF egress in the sandbox.
- `cf-deploy.ts` — the always-temp deploy path: challenge → solve → provision
  (`POST /provisioning/previews`) → upload via the `cloudflare` SDK
  (`workers.scripts.update` + `workers.subdomains.get`). Uploads the DO binding
  + two `secret_text` bindings (`TUNNEL_SECRET`, `AUTHZ_TOKEN`) + first-time DO
  migration. Retry with capped exponential backoff; non-retriable CF 4xx fail
  fast. Returns `{ url, deploymentId, accountId, apiToken, expiresAt, claim }`.
- `worker-bundle.ts` — bundles `worker/` via `wrangler deploy --dry-run
  --outdir` (worker's own devDep bin; no wrangler runtime dep, `worker/` never
  modified) and returns the ESM string.
- `tunnel-secret.ts` — mints the tunnel handshake secret (32B CSPRNG →
  base64url, rotated every deploy). Full **design + threat-model header
  comment** covering worker impersonation, deploy-log leak, replay across
  redeploys, and cross-owner reuse — flagged for the adversarial review pass.
- `worker-record.ts` — persists worker state in `bb.storage.kv` (the concrete
  durable surface behind SPEC's "PluginSettings"); zod-validated, malformed →
  wipe + fresh bootstrap.
- `worker-lifecycle.ts` — the service. Bootstrap-or-reuse on start (health-check
  persisted record; alive → reuse + re-attach tunnel with the persisted secret,
  dead/expired → wipe), lazy first-deploy via `ensureDeployed()` (called from
  `mintToken`), 60s health loop while any token exists, health-fail → wipe +
  fresh deploy, and tunnel rotation (stop old → mint fresh secret → deploy →
  start new).

### Wiring in `server.ts`

- Extended `workerStatusSchema` to `{ url?, state, expiresAt?, claim?: { url,
  expiresAt }, healthy, tunnel? }` and implemented `getWorkerStatus` →
  `lifecycle.getStatus()` (redacted: apiToken/tunnelSecret never cross the
  boundary; `claim`/`expiresAt` feed 16's nav-panel nudge + countdown).
- `mintToken` awaits `lifecycle.ensureDeployed()` (lazy first-deploy) and passes
  the live worker origin to `buildShareUrl`.
- Broadcasts on `REALTIME_CHANNELS.workerChanged` ("worker-changed") on every
  state/tunnel transition.

### Secrets

1. Authz endpoint secret — `bb.sdk.plugins.token({ pluginId })`, plumbed to the
   deploy as the `AUTHZ_TOKEN` secret-text binding.
2. Tunnel handshake secret — minted here, planted as `TUNNEL_SECRET`, handed to
   `SharedTunnel`, rotated on every redeploy. Persisted with the record so a
   plugin restart can re-attach to a still-healthy worker.

### Dependency

Added `cloudflare` ^7.1.0 to root `package.json` (+ `package-lock.json`); it
bundles cleanly into the built `dist/server.js`.

### Verification

- `tsc --noEmit` clean.
- `bb plugin build .` succeeds (cloudflare bundled in).
- 59 vitest tests pass (15 new: PoW known-answer + cap, secret shape, record
  round-trip/wipe, and lifecycle state machine — deploy/persist/tunnel, secret
  redaction, dedupe, error state, reuse-on-restart, dead-wipe, rotation).
- Full CF integration not run (no CF creds in sandbox, per ticket).
