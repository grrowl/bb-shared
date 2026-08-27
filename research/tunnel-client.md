# Tunnel client — spike 02

Answering issue [`02-spike-tunnel-client.md`](../.scratch/v0/issues/02-spike-tunnel-client.md).
Source read from the bb checkout at `/tmp/claude/bb-research/bb/`.

## TL;DR

- **Recommendation: fork-lite.** Do NOT modify `plugins/connect`; do NOT add a
  config knob. Vendor bb's transport-generic tunnel package
  (`packages/tunnel-client` + `packages/tunnel-contract`, ~700 LOC combined,
  `private: true` workspace-only), and write a ~120-line
  `SharedTunnel` wrapper inside bb-shared. No pairing, no shares, no CLI —
  just: open WS with bearer, hand the socket to `TunnelSession`, reconnect.
- **Origin-guard: passes**, as long as the tunnel client rewrites the visitor
  `Origin` header to the local bb server's loopback origin (see below).
- **Coexistence**: two tunnels are fine — separate plugins, separate KV, both
  dial the same loopback. There is no shared bb-server-side state that would
  collide. Do NOT reuse the `connect` plugin's credential store, or the user's
  real pairing gets stomped.

## End-to-end request path in bb's tunnel client

Files: `plugins/connect/src/tunnel.ts` + `packages/tunnel-client/src/session.ts`
\+ `packages/tunnel-client/src/headers.ts` + `packages/tunnel-contract/src/index.ts`.

1. **Entry point.** `plugins/connect/src/server.ts` (plugin `default export`)
   is loaded by bb. It constructs a `ConnectTunnel` and mounts it as a
   `bb.background.service("tunnel", …)`. The service's `start(signal)` calls
   `tunnel.start()`; the service is aborted on plugin disable/reload.
2. **Credential lookup.** `ConnectTunnel.start()` reads `credential` from
   plugin KV (`plugins/connect/src/credential.ts`, key `"credential"`). Shape:
   `{ serverUrl, handle, credential }` where `credential` is the raw bearer
   secret returned by the redeem endpoint.
3. **Outbound dial.** `openTunnel()` builds `tunnelUrl` via
   `tunnelUrlForServer(credential.serverUrl)` — takes the paired server URL
   (e.g. `https://sawyer.getbb.app`), swaps `http→ws`, appends `/__tunnel`,
   adds `?v=1` (`TUNNEL_PROTOCOL_QUERY_PARAM`). Dials with `ws`
   `NodeWebSocket(url, { headers: { authorization: "Bearer " + credential } })`,
   `handshakeTimeout: 15s`, plus a hand-rolled per-dial deadline (the `ws`
   timeout is idle-only). No `Origin` header is sent from bb → worker.
4. **Handshake / auth.** The worker's `apps/connect/src/worker.ts`
   `/__tunnel` handler (lines 366–396) matches by host label, resolves the
   server row, checks `sha256Hex(bearer) === owner.credentialHash`. 401 →
   `credentialRejected()` clears the KV credential and lands "not paired".
   403 or 401 forgets the credential; any other unexpected-response schedules
   backoff. There is NO further app-level handshake message — the WS upgrade
   IS the handshake.
5. **Session start.** On `open`, `ConnectTunnel` constructs a
   `TunnelSession` (from `@bb/tunnel-client`) around the socket, with:
    - `resolveOrigin(target)` — per-frame origin resolver. For `target ===
      undefined` (bare-handle traffic) returns
      `{ origin: getLoopbackBaseUrl(), publicOrigin: new URL(serverUrl).origin }`.
      For `target === <port>` it consults `ShareRegistry`.
    - `onRemoteClientsChange`, `onActivity` — status plumbing.
6. **Request demux.** The relay opens streams with monotonically-increasing
   `streamId`s. Binary WS frames only; text frames are heartbeats
   (`bbt:hb` / `bbt:hb-ack`, 20s interval, 60s deadline → terminate + reconnect).
   Frame types (`packages/tunnel-contract/src/index.ts`):
    - `open-http {streamId, method, path, headers, hasBody, target?}` — start
      an HTTP request. `open-http` + optional `body-chunk*` + `body-end`.
    - `open-ws {streamId, path, headers, protocols, target?}` — start a WS
      to the origin. Then `ws-data` frames both ways, `close-stream` to end.
7. **Per-stream dispatch.** `TunnelSession.executeHttp()`:
    - Calls `resolveOrigin(frame.target)`.
    - `headersForLoopbackRequest(frame.headers, {publicOrigin, loopbackOrigin, host?})`
      — copies visitor headers, drops `host` / `content-length` / `connection`,
      and (KEY) **rewrites `Origin` header from `publicOrigin` to `loopbackOrigin`**.
      Injects a `Host` header only for share streams.
    - Node `http`/`https` request to `<loopbackOrigin><path>`, streams
      response bytes back as `resp-head` + `body-chunk*` + `body-end`.
   `openOriginWs()` does the equivalent for WebSockets: opens a new `ws`
   socket at `<loopback ws origin><path>`, ferries messages both ways.

## Every hardcoded `getbb.app` reference

- `plugins/connect/src/redeem.ts:4` — `DEFAULT_CONNECT_BASE_URL = "https://getbb.app"`.
- `plugins/connect/src/tunnel.ts:225, 393, 565` — user-facing strings and a
  fallback in `connectApexHost()`.
- `plugins/connect/src/cli.ts:73, 76, 78, 85, 96, 118, 157, 172` — CLI help/errors.
- `plugins/connect/src/shares.ts:283` — user-facing error string.
- `plugins/connect/src/rpc.ts:18` — comment.
- `plugins/connect/src/types.ts:36, 39, 46` — comments.
- `plugins/connect/app.tsx:165, 1437` — panel copy.
- `plugins/connect/package.json:6, 13` — description.
- `plugins/connect/skills/share-server-links/SKILL.md:14, 20` — skill copy.
- Test fixtures under `plugins/connect/*.test.*`.

The only **operative** references are:
- The `DEFAULT_CONNECT_BASE_URL` constant, and it is only used during
  **pair()** (redeem-code → credential), NOT during tunnel dial. Once paired,
  the tunnel URL comes from the STORED `credential.serverUrl`, not from the
  apex.
- Environment override: `BB_DEV_CONNECT_BASE_URL` (via
  `resolveDefaultConnectBaseUrl(process.env)`, `plugins/connect/src/redeem.ts:10`).
  Validated to accept **only** `http://bb.localhost:<port>` and only under
  `NODE_ENV=development`. Deliberately not a general-purpose knob.

So there is no production config knob that lets us aim `plugins/connect` at
an alternate worker apex. The dev override is host-locked to `bb.localhost`
and NODE_ENV-gated.

## Auth handshake shape

- **What.** HTTP `Authorization: Bearer <credential>` on the WS upgrade to
  `wss://<host>/__tunnel?v=1`. No cookies. No custom headers other than the
  version query param.
- **Tunnel identifier.** The tunnel is identified by the **hostname it
  connects to**, not a payload — the worker parses `<label>.<BASE_DOMAIN>`
  via `parseVisitorHost()` and looks up the server row by label. The bearer
  is the sole proof of ownership.
- **Bearer minting.** Server-side: the worker generates a random secret
  during `redeem` and stores `sha256Hex(secret)` as `credentialHash` on the
  server row. Client-side: the plaintext lives in `plugins/connect` KV
  under key `"credential"`. Comparison at dial-time is
  `sha256Hex(presented) === owner.credentialHash`.
- **No back-channel auth.** The tunnel client never fetches anything from
  the worker BEFORE the WS opens — the WS upgrade is the handshake. Post-open
  it is purely wire-level frames (see `@bb/tunnel-contract`).

For our worker, the natural mirror is: bb-shared plugin generates a random
secret at worker-deploy time (issue 07), plants it as an env var on the
worker (or a Cloudflare secret), and ships it plaintext to the local
`SharedTunnel` for use as the `Authorization: Bearer …` on the WS upgrade.

## Recommendation: fork-lite (vendor tunnel-client + tunnel-contract)

**Config knob is not viable.**

- `plugins/connect` has no knob for an alternate worker URL, and adding one
  would require a bb-repo patch we do not control (bb-shared ships as a
  third-party plugin).
- The single operative `getbb.app` reference is `DEFAULT_CONNECT_BASE_URL`,
  and it only affects the initial `pair(code)` redeem flow. Our worker will
  not implement bb's redeem protocol — it has a different auth model.
- Even if we bypassed pair() by writing a credential directly into the
  connect plugin's KV, we would (a) stomp the user's real bb-connect pairing,
  (b) tie our lifecycle to a plugin we do not own, (c) still inherit the
  full ConnectTunnel — shares, hosts, `disconnect` cloud call, machine-code
  APIs, `bb.agents.contributeInstructions` line about `<handle>.getbb.app` —
  all of it either wrong for our fork or dead weight.

**Full fork of `plugins/connect` is overkill.** That plugin is ~2500 lines
across 13 files: shares, machine codes, revoke, CLI, panel, host enrolment,
mobile pairing. We need ~200 lines of it.

**Vendor path.** Copy the two transport-generic packages into bb-shared
as a small internal library, then write a thin `SharedTunnel` in
`plugins/bb-shared/src/tunnel.ts`. Vendored surface:

- `packages/tunnel-contract/src/index.ts` (302 lines, zero deps) — wire
  format. Copy verbatim.
- `packages/tunnel-client/src/{index,session,headers,humanize,reconnect,logger}.ts`
  (~450 lines, deps: `ws`, `@bb/tunnel-contract`) — session, header rewrite,
  backoff. Copy verbatim.

Both are `private: true` workspace-only packages — no npm install, so we
must vendor. They are self-contained and unlikely to churn (this is bb's
public tunnel wire protocol; changing it breaks all deployed bb clients).
Note upstream `PROTOCOL_VERSION` in `CHANGELOG` on rebase.

Then a new module (rough shape in appendix), owned by bb-shared, that:

1. Opens a WS to our worker URL with a bearer secret it received from the
   worker-lifecycle manager (issue 07).
2. Wraps the socket in `TunnelSession` with a `resolveOrigin` that always
   returns the bare-handle case — no shares, no ports.
3. Uses `ReconnectBackoff` for retries.

Files touched in bb-shared:

- `packages/bb-shared-tunnel/**` — new, vendored bb code.
- `plugins/bb-shared/src/tunnel.ts` — new, ~120 lines. `SharedTunnel` class.
- `plugins/bb-shared/src/server.ts` — new, mounts `SharedTunnel` under a
  `bb.background.service("shared-tunnel", …)`.

Nothing in bb's own tree changes.

## Coexistence with real `bb connect`

Yes, two tunnels can run in parallel on one bb. What is / is not shared:

- **Loopback origin.** Both tunnels dial `http://127.0.0.1:<serverPort>` for
  requests. bb server does not care how many upstream tunnels are alive —
  it just serves requests.
- **`bb.background.service` names.** Namespaced per-plugin, so
  `connect:tunnel` and `bb-shared:shared-tunnel` are independent.
- **Plugin KV.** Namespaced per-plugin. bb-shared MUST use its own KV; do
  not write into `plugins/connect`'s KV.
- **`ShareRegistry` / `bb.hosts`.** Owned by `plugins/connect`. bb-shared
  does not touch either — we do not expose ports, only bb itself.
- **Cross-frame `Origin` rewrite.** Both tunnels do their own rewrites
  independently; the visitor header just becomes `http://127.0.0.1:<port>`
  before it reaches bb.

The only genuine mutual-exclusion is the connect **plugin's stored
credential** — we must not reuse it. Since bb-shared has its own plugin
KV namespace, this is automatic; the constraint is "don't cargo-cult
`createKvCredentialStore` from `plugins/connect`".

Two side-effects worth flagging:

- **`bb.agents.contributeInstructions`.** bb connect injects a system-prompt
  fragment when a remote client is active (`plugins/connect/src/server.ts:64`).
  bb-shared should NOT add a competing fragment for guests — the SPEC treats
  guests as normal users; agents don't need to know. Skip that hook.
- **Realtime channel.** bb connect publishes on `CONNECT_REALTIME_CHANNEL`.
  bb-shared publishes on its own channel (e.g. `BB_SHARED_REALTIME_CHANNEL`)
  for owner-panel status. No collision.

## Origin-guard: does a guest request pass?

**Yes, IF the tunnel client rewrites Origin to the loopback origin.**

Trace: guest browser → CF worker → tunnel WS → bb-shared `SharedTunnel` →
`TunnelSession.executeHttp` → `headersForLoopbackRequest` → local bb server →
`browserRequestProblem` (`apps/server/src/browser-request-guard.ts:147`).

`browserRequestProblem` accepts a request iff:

1. `Origin` header is absent (non-browser clients), OR
2. `Origin` matches a value in `allowedAppOrigins`, which is:
   `buildLocalAppOrigins({ serverPort, appUrl?, devAppPort? })` →
   `{"http://127.0.0.1:<serverPort>", "http://localhost:<serverPort>"}`
   plus dev-port and configured `appUrl` if present. OR
3. `Origin` matches the request's own target host+port (dev/LAN fallback).

The guest browser will send `Origin: https://<worker-host>` (whatever we
deployed). That does NOT match `allowedAppOrigins`, and does NOT match the
loopback request target either.

**The fix already exists in bb's own tunnel.** `headersForLoopbackRequest`
(`packages/tunnel-client/src/headers.ts:15`) rewrites the visitor Origin
header specifically for this reason:

```ts
lowerName === "origin" && value === rewrite.publicOrigin
  ? rewrite.loopbackOrigin
  : value
```

For it to fire we must set:

- `publicOrigin` = `new URL(<workerBaseUrl>).origin`
  (the origin the guest browser sees — e.g. `https://guests.example.com`).
- `loopbackOrigin` = `http://127.0.0.1:<bbServerPort>` (from
  `bb.server.loopbackBaseUrl` — `plugins/connect/src/server.ts:28`).

If the guest's `Origin` exactly equals `publicOrigin`, the tunnel client
substitutes the loopback origin, which is in `allowedAppOrigins`, and the
guard passes.

**Two things that could break this:**

- **Worker forwards a different Origin.** If the CF worker rewrites the
  request or adds a normalized Origin that differs from `publicOrigin`, the
  substitution won't match and bb 403s. The worker must preserve
  `guest_request.headers.origin` as-is (or, defensively, unconditionally set
  `Origin` to the worker's own public origin before forwarding into the
  tunnel).
- **Cross-origin nav from another site.** If someone opens a bb-shared URL
  as a subresource from a non-worker origin, the browser sends that other
  Origin, the substitution doesn't fire, bb 403s. Correct behavior.

**Preserve/emit exactly:** `Origin: https://<workerBaseUrl>` — same origin
the guest is browsing from, unchanged from browser to bb-shared tunnel
client. Do NOT add `X-Forwarded-*` on the worker expecting bb to honor
them — bb only reads `x-forwarded-host` / `x-forwarded-proto` for building
`requestTargets`, and even then only to widen the acceptance set for
matching the Origin against the request's own target, which is not the
path we rely on.

## Appendix — implementation shape for issue 14

Directory layout inside this repo:

```
packages/
  bb-shared-tunnel/          # vendored from bb (see NOTICE)
    src/
      contract.ts            # from @bb/tunnel-contract
      session.ts             # from @bb/tunnel-client/src/session.ts
      headers.ts             # from @bb/tunnel-client/src/headers.ts
      reconnect.ts           # from @bb/tunnel-client/src/reconnect.ts
      humanize.ts            # from @bb/tunnel-client/src/humanize.ts
      logger.ts              # from @bb/tunnel-client/src/logger.ts
      index.ts               # re-exports
plugins/
  bb-shared/
    src/
      tunnel.ts              # SharedTunnel (below)
      tunnel-config.ts       # { workerUrl, bearer } shape + validation
      server.ts              # plugin entry — mounts service
      worker-lifecycle.ts    # issue 07 — deploys worker, hands us config
```

`SharedTunnel` — rough sketch, ~120 lines:

```ts
import { WebSocket as NodeWebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  TUNNEL_PROTOCOL_QUERY_PARAM,
} from "../../../packages/bb-shared-tunnel/src/contract.js";
import {
  ReconnectBackoff,
  TunnelSession,
  humanizeTransportError,
} from "../../../packages/bb-shared-tunnel/src/index.js";
import type { PluginLogger } from "@get-bb/plugin-sdk";

interface SharedTunnelOptions {
  /** Full URL of our deployed worker, e.g. https://guests-abc.workers.dev */
  getWorkerUrl: () => string | null;
  /** Bearer we planted on the worker at deploy. */
  getBearer: () => string | null;
  /** bb.server.loopbackBaseUrl — read lazily (bind-gated). */
  getLoopbackBaseUrl: () => string;
  log: PluginLogger;
  onStatusChange?: (state: "disconnected" | "connecting" | "connected" |
                    "reconnecting") => void;
}

export class SharedTunnel {
  private socket: NodeWebSocket | undefined;
  private session: TunnelSession | undefined;
  private backoff = new ReconnectBackoff();
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: SharedTunnelOptions) {}

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.session?.dispose();
    this.session = undefined;
    this.socket?.terminate();
    this.socket = undefined;
    this.opts.onStatusChange?.("disconnected");
  }

  /** Force a redial (call after worker lifecycle redeploys). */
  restart(): void {
    this.session?.dispose();
    this.socket?.terminate();
    this.backoff.reset();
    if (!this.stopped) this.open();
  }

  private open(): void {
    const workerUrl = this.opts.getWorkerUrl();
    const bearer = this.opts.getBearer();
    if (workerUrl === null || bearer === null) {
      // Nothing to connect to; lifecycle manager will call restart()
      // when a fresh deployment lands.
      this.opts.onStatusChange?.("disconnected");
      return;
    }
    const publicOrigin = new URL(workerUrl).origin;
    const wsUrl = new URL(
      workerUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/__tunnel",
    );
    wsUrl.searchParams.set(TUNNEL_PROTOCOL_QUERY_PARAM, String(PROTOCOL_VERSION));
    this.opts.onStatusChange?.("connecting");

    const sock = new NodeWebSocket(wsUrl.toString(), {
      headers: { authorization: `Bearer ${bearer}` },
      handshakeTimeout: 15_000,
    });
    this.socket = sock;

    sock.on("open", () => {
      this.opts.log.info("shared tunnel connected");
      this.opts.onStatusChange?.("connected");
      this.session = new TunnelSession({
        tunnel: sock,
        log: this.opts.log,
        resolveOrigin: () => ({
          kind: "ok",
          resolved: {
            origin: this.opts.getLoopbackBaseUrl().replace(/\/$/, ""),
            publicOrigin,
          },
        }),
      });
      this.session.start();
    });
    sock.on("unexpected-response", (_req, res) => {
      res.resume();
      const status = res.statusCode ?? 0;
      this.opts.log.warn(`worker rejected tunnel: HTTP ${status}`);
      if (status === 401 || status === 403) {
        // Bearer wrong — worker needs redeploy w/ synced secret.
        // Don't reconnect; wait for lifecycle to hand us a fresh one.
        this.stop();
        return;
      }
      this.scheduleReconnect();
    });
    sock.on("error", (e: Error) => {
      this.opts.log.warn(humanizeTransportError(e, new URL(workerUrl).host));
    });
    sock.on("close", () => {
      this.session?.dispose();
      this.session = undefined;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.opts.onStatusChange?.("reconnecting");
    const delay = this.backoff.nextDelayAfterClose(0);
    this.retryTimer = setTimeout(() => this.open(), delay);
    this.retryTimer.unref?.();
  }
}
```

Wiring in `server.ts`:

```ts
export default async function plugin(bb: BbPluginApi) {
  const lifecycle = new WorkerLifecycle({ /* issue 07 */ });
  const tunnel = new SharedTunnel({
    getWorkerUrl: () => lifecycle.currentWorkerUrl(),
    getBearer: () => lifecycle.currentBearer(),
    getLoopbackBaseUrl: () => bb.server.loopbackBaseUrl,
    log: bb.log,
    onStatusChange: (s) => bb.realtime.publish(BB_SHARED_STATUS_CHANNEL,
                                                { tunnel: s }),
  });
  lifecycle.onRedeploy(() => tunnel.restart());

  bb.background.service("shared-tunnel", {
    async start(signal) {
      tunnel.start();
      await new Promise<void>((r) => signal.addEventListener("abort",
                                                              () => r(),
                                                              { once: true }));
      tunnel.stop();
    },
  });
  // …rpc, ui registrations elsewhere…
}
```

Not shown but part of issue 14:

- Bearer generation (32B base64url), stored in KV under a bb-shared-specific
  key so a plugin restart re-uses it (must match the worker's stored secret).
- Worker-side `/__tunnel` handler that mirrors the sha256-hash-check pattern
  from bb (`apps/connect/src/worker.ts:366`).
- Backoff jitter — `ReconnectBackoff` already handles it; nothing extra.

## Open follow-ups (out of scope for this spike)

- Worker deployment (issue 07) hands us `{ workerUrl, bearer }`. Its shape
  and lifecycle events are the interface `SharedTunnel` depends on.
- Vendor upgrade policy: pin `packages/bb-shared-tunnel` to a bb commit,
  add a rebase check to CI when bumping. Because we vendor from a private
  workspace package, a small `VENDORED.md` in the package should record the
  upstream sha the copy was taken from.
