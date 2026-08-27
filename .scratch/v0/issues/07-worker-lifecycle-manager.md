Status:
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
