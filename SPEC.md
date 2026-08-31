# bb-shared

A bb plugin that lets the owner grant a guest live access to specific bb
threads — read or write, per thread — via a scoped, revocable capability
token. The guest gets the real bb SPA scoped to their shared threads, not
a stripped mirror.

Intended use: pair-programming / pair-prompting during grilling sessions.

## User story

1. Owner opens a thread, hits the "Share" button in the thread header.
2. Modal shows tokens grouped by name ("brave-otter", "silver-fox", …) and
   which threads each token already covers.
3. Owner picks "add this thread to `brave-otter` as write" or "mint a new
   token". Gets back a URL. Sends it over any channel.
4. Guest opens the URL, sees a bb sidebar with only their token's threads,
   can view transcript live and (if `write`) inject input as user messages.
5. Owner can remove threads from a token, downgrade/upgrade perms, or
   delete the whole token at any time. Changes take effect immediately.

## Architecture

```
    guest browser
         │
         ▼
  ┌─────────────────┐         ┌─────────────────┐
  │  CF Worker      │◄───WS──►│  local bb server│
  │  (bb-shared fork│  tunnel │  :38886         │
  │   of bb connect)│         │                 │
  └─────────────────┘         │  bb-shared      │
         │                    │  plugin         │
         │  /api/v1/          │  (in-process)   │
         │  bb-shared/*       │                 │
         └───pull-on-request─►│  - token store  │
                              │  - scope check  │
                              │  - RPC          │
                              └─────────────────┘
```

Three components:

1. **Cloudflare Worker** — fork of `apps/connect/src/worker.ts`, deployed
   per-owner via Cloudflare's temporary-deployments-for-agent flow. Replaces
   the GitHub-cookie gate with token gating + per-request scope check.
2. **Fork of bb connect tunnel client** — the local half that dials out to
   the worker. Points at our deployed worker URL instead of bb's.
3. **bb-shared plugin** — runs inside the local bb server. Holds token
   state, answers scope queries from the worker, exposes owner UI.

## Transport

### Worker lifecycle

- Each owner runs their own worker; workers are per-bb-instance, not shared.
- Deployment is **lazy** — plugin deploys on first `openShareDialog` or
  `mintToken` call, whichever comes first.
- Deployment method: Cloudflare "temporary deployments for agents"
  (see https://blog.cloudflare.com/temporary-accounts/,
  https://developers.cloudflare.com/workers/platform/claim-deployments/).
  Anonymous PoW-gated deploy; use the `cloudflare` npm SDK for uploads.
  **Always temp** — no wrangler dep, no branching, one code path.
- **Persist worker state in bb's durable KV** as
  `{ deploymentId, url, tunnelSecret, claim, deployedAt, generation }`.
  `url`, `tunnelSecret`, and `claim.url` are encrypted. The provisioning-only
  temporary API token and account id are never persisted.
- The temporary-account TTL is not lifecycle truth. The owner-only claim URL is
  hidden after its expiry, but a saved endpoint is reused after restart whenever
  its exact `401 { error: "token_missing" }` identity probe succeeds. Cloudflare
  has been observed to preserve the workers.dev hostname after the owner claims.
  bb-shared never claims to know whether the owner completed that action.
- Any probe/startup/tick failure retains the record and marks it **Offline**;
  periodic probes continue even with no shares. Connecting/reconnecting tunnels
  do not replace a worker; a stopped tunnel is an actionable fault.
- First share auto-provisions only with no record. **Recreate worker** is the
  sole replacement operation and is transactional: the old record/tunnel remain
  until new provisioning and durable save succeed. A new hostname leaves copied
  links targeting the old worker, and Cloudflare cleanup is manual.

### Local tunnel client

Vendor bb's transport-generic packages (`packages/tunnel-client` +
`packages/tunnel-contract`, ~750 LOC combined, both `private: true` so
not npm-installable) into a `packages/bb-shared-tunnel/` inside this
repo. Wrap in a ~120-line `SharedTunnel` class inside the plugin.

Origin-guard is a solved problem in the vendored code:
`headersForLoopbackRequest` rewrites visitor `Origin` from `publicOrigin`
(our worker URL) to `loopbackOrigin` (`http://127.0.0.1:38886`) before
hitting the local bb, and the loopback origin lands in bb's allowlist.

Coexists cleanly with real `bb connect` (separate plugin namespace,
separate KV, both dial the same loopback).

**Load-bearing constraint on the worker (issue 08)**: it must forward
the guest's `Origin: https://<worker-host>` unchanged into the tunnel
(or set Origin unconditionally to its own public origin). Anything
else and the header-rewrite fails to match and the local guard 403s.

### Worker knowledge of scope

The worker is dumb. On every guest request:

1. Extract token from URL path (or cookie after first hit).
2. Call over the tunnel: `GET /api/v1/bb-shared/authz?token=…&path=…&method=…`.
3. Plugin responds `{ allowed: bool, thread_scope: [id, …], perms: [{ id, mode }, …] }`.
4. Worker allows / 403s and, if allowed, forwards.

Trade-off: one extra hop per request. Acceptable for v0. Cachable at the
worker within a request's lifetime.

## Data model (in-memory only)

Everything below lives in the plugin process. No SQLite, no dotfiles.
State dies with the plugin, guest URLs become invalid on restart.
Interface designed so a persistent backend can slot in later.

```ts
Token = {
  id: string,                     // "bbsh_" + 12-char base64url — public handle for CRUD
  hash: string,                   // HMAC-SHA256(raw_token) — bearer comparison
  label: string,                  // random verb-noun, renameable
  shares: Share[],                // per-thread grants
  created_at: number,
}

Share = {
  thread_id: string,
  project_id: string,
  perm: "read" | "write",
  added_at: number,
}

// key operations
mintToken({ label? }): { token, url }
listTokens(): Token[]
renameToken(id, label): void
deleteToken(id): void
addShare(token_id, thread_id, project_id, perm): void
removeShare(token_id, thread_id): void
updateShare(token_id, thread_id, perm): void
```

Two distinct token strings, prefix collision intentional (both start with
`bbsh_`):

- **Public handle** (`Token.id`, 12 chars) — safe to pass around inside
  the plugin for CRUD (`renameToken(id, …)`, `deleteToken(id)`, etc.).
- **Raw bearer** (43 chars, 32 bytes of entropy) — returned once from
  `mintToken` as the URL-embeddable secret; never persisted. The store
  keeps only its HMAC-SHA256 as `hash` for authz comparison.

No expiry, no session tracking, no revocation timestamps — the token
either exists or it doesn't.

## Guest URL

**Primary shape**: `https://{worker-host}/{token}/projects/{p}/threads/{t}`

Token is a path segment; the guest navigates within the token prefix for
the entire session. The worker treats the first path segment as the token
and rewrites internally.

**Fallback (opt-in)**: `https://{worker-host}/projects/{p}/threads/{t}?token=…`
handled as: worker sets a cookie, 302s to the clean URL. Used only if
navigating-within-token proves fragile.

Owner copies the primary shape. It's the deep-link version — lands the
guest directly on the thread they were just being invited to.

## Scope enforcement — what the proxy does

The bb SPA has NO user or session concept (research finding). All
enforcement is at the worker via response filtering + mutation rejection.

### Response filters (allowlist by token scope)

| Endpoint | Filter |
|---|---|
| `GET /api/v1/system/config` | strip: `aiServices`, `keybindings`, `voiceTranscriptionEnabled`; keep theme + UI shell config |
| `GET /api/v1/sidebar-bootstrap` | filter `projects[].threads` to token's shares; filter `sections` to allowed; replace `personalProject` with empty-thread stub |
| `GET /api/v1/plugins` | return `{ plugins: [] }` — v0 disables all plugin frontends for guests |
| `GET /api/v1/hosts` | return `[]` |
| `GET /api/v1/projects/{p}` | allow if any share references `p` |
| `GET /api/v1/threads/{t}/*` | allow if `t` in token scope, else 403 |
| `GET /api/v1/plugin-settings/*` | return empty |

### Mutation gate

Deny by default. Guest may ONLY:

- `POST /api/v1/threads/{t}/send` — if `t` in scope AND perm == `write`.

Everything else returns `403` with `{ error: "scope" }`.

### WebSocket filter

Subscribe frames from guest → allowlist (only `thread:changed`,
`thread:output`, or equivalents scoped to allowed thread ids).

Broadcast frames to guest → drop any `changed`/`entity` invalidation
whose `entity_id`/`thread_id` isn't in scope. Without this, guests see
"something changed" for threads they can't view.

### SPA chrome shim

The SPA renders Settings, Extensions, plugin-nav buttons unconditionally
(research finding — no gate exists). Worker rewrites `index.html` to
inject:

```html
<script>document.documentElement.dataset.bbGuest = "1"</script>
<style>
  [data-bb-guest] [data-testid="app-sidebar-primary-actions"],
  [data-bb-guest] [aria-label^="Settings"],
  [data-bb-guest] [data-testid="plugin-nav-sidebar-items"],
  [data-bb-guest] [aria-label^="New thread"] { display: none !important; }
</style>
```

Selectors picked from stable `data-testid`s where available. Two
non-obvious details (verified against bb `31a190d` during 12's build,
do not "correct" back to the naive form):

- `plugin-nav-sidebar-items` is a `data-testid`, NOT a CSS class.
- `Settings` / `New thread` aria-labels are dynamic — bb appends
  `(⌘,)` when a keyboard shortcut is bound — so exact-match `[aria-label="Settings"]`
  fails in the common case. Prefix match (`^=`) is required.

Upgrade risk pinned by `scripts/check-chrome-selectors.mjs` against a
`BB_VERSION`-tracked bb checkout.

### Route lock-outs

For `/settings/*`, `/extensions/*`, `/tools/*`, `/hosts/*` — worker
returns a lightweight HTML that redirects to `/{token}/`. The SPA
never mounts those routes for guests.

## Owner UI (bb-shared as a bb plugin)

Registered surfaces (all from bb's frontend plugin contract at
`packages/plugin-sdk/src/app-contract.ts`):

- **`experimental_threadHeaderAction`** — the "Share" icon-button at the
  left of the thread header action row. Click → portalled popover with
  quick actions: "Add to `brave-otter` (read | write)", "Add to
  `silver-fox`", "Mint new share". Also "Open management panel".
- **`navPanel`** at `/plugins/shared/tokens` — the management console.
  Grouped by token. Per-token: label (renameable), share list (thread +
  perm, per-row remove/upgrade/downgrade), copy-URL, delete-token.
  Header: "Mint new" + live worker status.
- **`commandPaletteAction`** "Share this thread" — `isAvailable` when
  `ctx.threadId` is set; runs the same action as the header button.

Frontend uses `useRpc<Contract>()` for calls to the plugin backend and
`useRealtime(channel, handler)` so the management panel live-updates
when a token is mutated elsewhere. Modeled on `plugins/tasks/app.tsx`
(navPanel + threadPanelAction) and `plugins/automations/app.tsx`
(management console with useRpc CRUD).

No modal API exists in bb — for confirm-delete dialogs, use the vendored
shadcn `AlertDialog` inside the panel.

## Trust model

v0 draws its trust boundary at the **owner's local machine**. The non-secret
worker metadata (url, accountId, scriptName, generation) lives as plaintext JSON
in `bb.storage.kv` (bb.db). Anyone (or anything) with local read access to that
store is inside the trust boundary and is, by construction, already able to
compromise the deployment. This is deliberate for v0 and stated here so it is
not mistaken for an oversight. (Findings M5, L3, L4 from
`research/tunnel-secret-review.md`.)

**At-rest encryption of persisted secrets (issue 29).** The *secret* fields of
the worker record — the CF temp-account `apiToken`, the tunnel handshake
secret, the `claim.url`, and (issue 28) the long-lived `cfRefreshToken` — are no
longer plaintext at rest. Each is encrypted with AES-256-GCM under a random
32-byte **device-tied key** before it touches `bb.storage.kv`, using a versioned
envelope so the primitive can rotate. The key is generated once on first use and
held in the **macOS Keychain** (the owner runs the plugin inside their bb server
process on their Mac); on a platform without a wired-up secure store it degrades
to a `0600` file under the bb data dir, documented as weaker because the key
then sits beside the ciphertext. The key is never written to the repo or into
the kv. Consequence: a copied `bb.db` / kv blob is useless off the machine that
minted the key — a record that fails to decrypt (missing key, other machine,
tamper) is wiped and the plugin degrades to a fresh bootstrap, never a crash. A
pre-issue-29 plaintext record is read once and re-saved encrypted. This is what
makes issue 28's persistence of a real-account refresh token acceptable. The
device key itself remains inside the local-trust boundary (a co-installed
malicious plugin or full-data-dir copy on the same machine can still reach it);
the encryption defends specifically against a copied at-rest blob leaving the
device.

**Local-trust boundary.** The following are assumed trusted in v0:

- The owner's local disk / `bb.db` (KV plaintext at rest).
- Every bb plugin the owner installs — `bb.storage.kv` isolation is per-plugin
  at the API layer, but a co-installed *malicious* plugin with local disk
  access sits inside the same boundary. Installing an untrusted bb plugin is
  therefore equivalent to handing over the CF account.
- The owner's network egress path (no TLS-identity pinning — see below).

**`apiToken` is the crown-jewel item, not the tunnel secret.** The careful
per-deploy rotation of the tunnel handshake secret is moot if the CF
`apiToken` leaks: an attacker holding it can redeploy a **malicious worker
under our own account name** — one that logs the tunnel secret and exfiltrates
guest traffic — with no need for the tunnel secret at all. Any at-rest
protection worth adding should protect `apiToken` first.

**No TLS/identity pinning beyond `*.workers.dev` (L3, accepted residual).** The
tunnel dials `record.url` over `wss://` and trusts standard web PKI to
authenticate the CF-assigned `*.workers.dev` origin. An attacker with control
of CF's `*.workers.dev` subdomain assignment (i.e. CF account control) could
MITM. This is considered inside the CF-trust boundary. v1 could add pinning by
capturing the initial TLS certificate fingerprint on first handshake and
rejecting drift.

**Stale prior-generation worker (L4, accepted residual).** On redeploy the new
worker gets a fresh account + secret; the prior-gen worker keeps running with
its old secret until CF reclaims its unclaimed temp account (≤60 min). The
prior-gen worker has no live tunnel to bb (the secret is rotated bb-side on
redeploy), so the residual reduces to: guest URLs against the old worker return
5xx until CF cleans it up (≤60 min unclaimed). Guest URLs also change on
redeploy, so the window is narrow and self-closing.

**v1 candidates.** ~~Encrypt KV values with a device-tied key (macOS Keychain,
etc.), prioritising `apiToken`~~ — **done (issue 29)**, see "At-rest encryption"
above; add TLS-fingerprint pinning. Cloudflare account OAuth is intentionally
out of scope: bb-shared keeps a claimed endpoint only through exact health
probes and never attempts to confirm a claim.

## Non-goals

- **Persistent state.** In-memory only in v0; interface designed so a
  persistent store can be added later.
- **Presence UI.** No "1 guest reading" badges. Guest count is not
  tracked.
- **Transcript attribution.** Guest-typed messages appear as normal user
  input; no distinction in the transcript itself.
- **Guest identity.** Tokens are bearer credentials; no accounts, no
  per-guest tracking.
- **Multi-tenancy.** One owner per worker, one worker per bb instance.
- **Guest-side plugin frontends** (v0). Return `[]` from
  `/api/v1/plugins`. Can be relaxed later per-plugin.
- **Bypassing bb.getbb.app's own auth.** We don't try. We deploy our
  own worker.
- **Tailscale transport.** Off the table.

## Open questions

1. **Which plugins are safe to allow for guests (post-v0).** Currently
   `plugins: []`. What's the shape of a per-plugin allowlist and who
   decides — owner per-token or global?
2. **SPA chrome CSS selectors** — validate `data-testid`s used in the
   shim exist and are stable across bb versions worth targeting (owned
   by 12).
3. **Realtime frame filter fidelity.** Enumerate all `changed`/`entity`
   event shapes in `packages/sdk/src/realtime-types.ts` and confirm the
   allowlist is complete (spike 03 — still open).
4. **Worker-to-tunnel authz caching.** Per-request `authz` call is
   simple; if it's a hot path, consider per-token in-worker cache with
   invalidation on token mutation.
5. **Tunnel handshake secret design** — reuse bb's `bbcm_` credential
   mechanism or mint our own. Adversarial review required before
   implementation (owned by 07).

Resolved by spikes:

- ~~CF temp-deployments API surface / WS + DO support~~ — spike 01. WS +
  DO both work; PoW-gated deploy via `cloudflare` SDK.
- ~~Tunnel client fork vs config~~ — spike 02. Vendor bb's transport
  packages, wrap in `SharedTunnel`.

## Reference — key files in the bb repo

- `apps/connect/src/worker.ts` — fork target for the worker
- `plugins/connect/src/tunnel.ts` — fork target for the tunnel client
- `apps/server/src/browser-request-guard.ts` — local Origin check
- `apps/server/src/routes/projects.ts:257-285` — `sidebar-bootstrap` handler
- `apps/app/src/hooks/queries/system-queries.ts:401-411` — SPA calls `/system/config`
- `apps/app/src/hooks/queries/sidebar-navigation-query.ts:26-60` — SPA calls `sidebar-bootstrap`
- `apps/app/src/lib/api-server.ts:4-9` — SPA API base = `window.location.origin`
- `apps/app/src/lib/plugin-frontend.ts:66-97` — plugin frontend loader (inventory-driven)
- `apps/app/src/components/settings/settings-nav.tsx:17-34` — settings nav (unconditional)
- `apps/app/src/components/sidebar/AppSidebar.tsx:262-267` — "new thread" button (unconditional)
- `packages/plugin-sdk/src/app-contract.ts` — frontend plugin surface (all slots)
- `packages/plugin-sdk/src/backend-contract.ts` — backend plugin surface (RPC, background, events)
- `packages/sdk/src/realtime-types.ts` — WS event shapes for frame filter
- `plans/bb-mobile-research/auth-connect.md` — the auth-model map, worth re-reading
