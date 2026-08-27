/**
 * Stage 11: bidirectional WebSocket frame filter.
 *
 * Two WS surfaces reach a guest (see `research/realtime-events.md`, the spike
 * 03 catalog):
 *
 *   - `GET /ws` — the main app socket, multiplexed by subscribe/unsubscribe
 *     frames plus a handful of broadcast signals the server sends to every
 *     open client regardless of subscription. This stage sits between the
 *     guest and the tunnel and filters frames in BOTH directions against the
 *     token's `GuestScope`.
 *   - `GET /ws/terminals/:id` — per-terminal pty stream. No guest UX in v0
 *     needs it, and every frame it carries discloses owner activity, so the
 *     worker refuses the upgrade outright (403).
 *
 * The pure per-frame decision functions (`filterClientFrame`,
 * `filterServerFrame`) carry all the policy and are unit-tested against
 * synthetic frame streams. The stage wires them onto a live `WebSocketPair`
 * via `bridgeGuestWebSocket`, which only runs on the Workers runtime.
 *
 * Scope source: `ctx.scope`, populated upstream by the authz stage (issue 10)
 * from the token's shares. Absent (null) ⇒ `EMPTY_SCOPE` ⇒ deny every
 * thread/project frame; pong/ping still flow. Safe-by-default.
 */

import { jsonError } from "../errors.js";
import { cont, respond, type Stage } from "../pipeline.js";
import { EMPTY_SCOPE, type GuestScope } from "../scope.js";
import type { TunnelRouter } from "../tunnel/interface.js";

const MAIN_WS_PATH = "/ws";
const TERMINAL_WS_PREFIX = "/ws/terminals/";

// ---------------------------------------------------------------------------
// Decision types
// ---------------------------------------------------------------------------

/**
 * What the bridge should do with one guest → local frame.
 *
 * - `forward`: relay `frame` upstream unchanged.
 * - `drop`: silently discard (a scoped target the guest may not touch, or an
 *   unrecognised-but-parseable target). Preferred over closing so a guest
 *   whose scope shrank mid-session sees a stale UI, not a disconnect loop.
 * - `close`: tear the socket down with `code`/`reason`, mirroring the local
 *   server's `1008 invalid-message` on an unparseable/unknown-shape frame.
 */
export type ClientFrameDecision =
  | { action: "forward"; frame: string }
  | { action: "drop"; reason: string }
  | { action: "close"; code: number; reason: string };

/**
 * What the bridge should do with one local → guest frame. Server garbage is
 * dropped, never propagated as a close — a broadcast the worker cannot parse
 * must not knock the guest offline.
 */
export type ServerFrameDecision =
  | { action: "forward"; frame: string }
  | { action: "drop"; reason: string };

// ---------------------------------------------------------------------------
// Guest → local bb (client frames)
// ---------------------------------------------------------------------------

/**
 * Allowlist inbound client frames. The local server's client protocol accepts
 * exactly `subscribe`, `unsubscribe`, `ping` and closes `1008 invalid-message`
 * on anything else (`apps/server/src/ws/client-protocol.ts`); the worker
 * enforces its own narrower allowlist first as defence in depth.
 *
 * Permitted through: `ping`, and `subscribe`/`unsubscribe` to `thread-detail`
 * or `project-detail` for an id in scope. Everything else — `*-list`,
 * `system`, `environment-*`, `host-*` targets — is dropped silently. Malformed
 * or unknown-`type` frames close the socket, matching the server.
 */
export function filterClientFrame(
  raw: string,
  scope: GuestScope,
): ClientFrameDecision {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { action: "close", code: 1008, reason: "invalid-message" };
  }

  if (!isRecord(msg) || typeof msg.type !== "string") {
    return { action: "close", code: 1008, reason: "invalid-message" };
  }

  switch (msg.type) {
    case "ping":
      // Liveness probe, no state — always forward.
      return { action: "forward", frame: raw };

    case "subscribe":
    case "unsubscribe": {
      const target = msg.target;
      if (!isRecord(target) || typeof target.kind !== "string") {
        // A subscribe with no valid target is a malformed frame — the server
        // would 1008 it.
        return { action: "close", code: 1008, reason: "invalid-message" };
      }
      switch (target.kind) {
        case "thread-detail":
          return typeof target.threadId === "string" &&
            scope.threadIds.has(target.threadId)
            ? { action: "forward", frame: raw }
            : { action: "drop", reason: "thread-detail out of scope" };
        case "project-detail":
          return typeof target.projectId === "string" &&
            scope.projectIds.has(target.projectId)
            ? { action: "forward", frame: raw }
            : { action: "drop", reason: "project-detail out of scope" };
        // Non-detail targets are never useful to a guest and would subscribe
        // them to broadcasts about things outside scope. Drop, don't close —
        // a benign SPA subscribe should not disconnect the guest.
        case "thread-list":
        case "project-list":
        case "environment-detail":
        case "environment-list":
        case "host-detail":
        case "host-list":
        case "system":
          return { action: "drop", reason: `${target.kind} not allowed for guest` };
        default:
          // Unknown-but-parseable target: default-drop, matching the
          // conservative bias in the catalog.
          return { action: "drop", reason: "unknown subscription target" };
      }
    }

    default:
      // Unknown message type — the server's discriminated union rejects it and
      // closes 1008; mirror that.
      return { action: "close", code: 1008, reason: "invalid-message" };
  }
}

// ---------------------------------------------------------------------------
// Local bb → guest (server frames)
// ---------------------------------------------------------------------------

/**
 * Filter outbound server frames. Default-drop posture: anything the worker
 * does not explicitly recognise and clear is dropped.
 *
 * Passed through:
 *   - `pong` — reply to the guest's own liveness probe.
 *   - `changed`/`thread` when `id` is present and in `threadIds` (the primary
 *     transcript-update channel; `events-appended` is the streaming signal).
 *     A stray `metadata.projectId` outside scope is stripped before relay.
 *   - `changed`/`project` when `id` is present and in `projectIds`.
 *
 * Dropped: `changed`/`environment`, `changed`/`host`, `changed`/`system`,
 * `thread-open`, `thread-pane-action`, `plugin-signal`, id-less `changed`
 * frames, and every unrecognised `type`.
 */
export function filterServerFrame(
  raw: string,
  scope: GuestScope,
): ServerFrameDecision {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { action: "drop", reason: "unparseable server frame" };
  }

  if (!isRecord(msg) || typeof msg.type !== "string") {
    return { action: "drop", reason: "server frame missing type" };
  }

  switch (msg.type) {
    case "pong":
      return { action: "forward", frame: raw };

    case "changed": {
      const entity = msg.entity;
      const id = msg.id;
      if (entity === "thread") {
        if (typeof id !== "string" || !scope.threadIds.has(id)) {
          // Id-less ⇒ list-wide refresh the guest never subscribes to;
          // out-of-scope ⇒ a thread they cannot view. Both drop.
          return { action: "drop", reason: "thread changed out of scope" };
        }
        return relayThreadChanged(raw, msg, scope);
      }
      if (entity === "project") {
        if (typeof id !== "string" || !scope.projectIds.has(id)) {
          return { action: "drop", reason: "project changed out of scope" };
        }
        return { action: "forward", frame: raw };
      }
      // environment / host / system — owner infrastructure. Drop unconditionally.
      return { action: "drop", reason: `changed/${String(entity)} not allowed for guest` };
    }

    // Ephemeral broadcasts the server sends to every open socket regardless of
    // subscription. None carry a guest-usable purpose in v0; all leak topology.
    case "thread-open":
    case "thread-pane-action":
    case "plugin-signal":
      return { action: "drop", reason: `${msg.type} not allowed for guest` };

    default:
      // Default-drop on any unrecognised type (the SDK itself silently skips
      // unknown types, so nothing guest-side reacts to them anyway).
      return { action: "drop", reason: "unrecognised server frame type" };
  }
}

/**
 * A `changed`/`thread` frame that is otherwise in scope. Belt-and-braces:
 * strip `metadata.projectId` if it names a project outside scope (should never
 * happen — the thread being in scope implies its project is too — but the
 * guest must never learn a project id it was not granted). If nothing needs
 * stripping the original bytes are forwarded verbatim.
 */
function relayThreadChanged(
  raw: string,
  msg: Record<string, unknown>,
  scope: GuestScope,
): ServerFrameDecision {
  const metadata = msg.metadata;
  if (
    isRecord(metadata) &&
    typeof metadata.projectId === "string" &&
    !scope.projectIds.has(metadata.projectId)
  ) {
    const { projectId: _dropped, ...restMetadata } = metadata;
    const rewritten = { ...msg, metadata: restMetadata };
    return { action: "forward", frame: JSON.stringify(rewritten) };
  }
  return { action: "forward", frame: raw };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// ---------------------------------------------------------------------------
// Pipeline stage + live socket bridge
// ---------------------------------------------------------------------------

/**
 * Insert BEFORE `dispatchStage`. Handles every WebSocket upgrade itself and
 * passes all other requests straight through:
 *
 *   - `/ws/terminals/:id` upgrade → 403 (never proxied for a guest).
 *   - `/ws` upgrade → dispatch through the tunnel, then interpose the frame
 *     filter between the guest and the tunnel's server socket.
 *   - anything else → `continue` (the normal dispatch stage handles it).
 */
export function wsFrameFilterStage(router: TunnelRouter): Stage {
  return {
    name: "ws-frame-filter",
    async run(ctx) {
      const isUpgrade =
        ctx.request.headers.get("upgrade")?.toLowerCase() === "websocket";
      if (!isUpgrade) return cont(ctx);

      const path = ctx.url.pathname;

      if (path.startsWith(TERMINAL_WS_PREFIX)) {
        return respond(
          jsonError(403, {
            error: "scope",
            detail:
              "terminal streaming is not available to guests — the shared thread transcript is the guest surface in v0",
          }),
        );
      }

      if (path !== MAIN_WS_PATH) {
        // Some other upgrade path — not the main app socket. Nothing scoped to
        // filter here; let it flow through the ordinary dispatch stage.
        return cont(ctx);
      }

      const upstream = await router.dispatch(ctx.request);
      const serverSocket = upstream.webSocket;
      // Tunnel offline / non-upgrade answer (e.g. 503) — return it untouched.
      if (upstream.status !== 101 || !serverSocket) {
        return respond(upstream);
      }

      const scope = ctx.scope ?? EMPTY_SCOPE;
      const guestSocket = bridgeGuestWebSocket(serverSocket, scope);
      return respond(new Response(null, { status: 101, webSocket: guestSocket }));
    },
  };
}

/**
 * Interpose the frame filter on a live `/ws` connection.
 *
 * `serverSocket` faces the tunnel (the local bb). We mint a fresh pair facing
 * the guest, accept both ends, and pump filtered frames across. Close and
 * error events propagate in both directions so upstream close/ping/pong
 * semantics are preserved (the app-level `pong` is relayed as a normal frame;
 * WS-protocol close carries its code/reason through).
 *
 * Runs only on the Workers runtime (`WebSocketPair`). The frame policy it
 * applies is `filterClientFrame`/`filterServerFrame`, which are exercised
 * directly by the unit tests.
 */
export function bridgeGuestWebSocket(
  serverSocket: WebSocket,
  scope: GuestScope,
): WebSocket {
  const pair = new WebSocketPair();
  const guestFacing = pair[0];
  const workerFacing = pair[1];

  workerFacing.accept();
  serverSocket.accept();

  // Guest → local bb
  workerFacing.addEventListener("message", (event) => {
    const decision = filterClientFrame(toText(event.data), scope);
    if (decision.action === "forward") {
      safeSend(serverSocket, decision.frame);
    } else if (decision.action === "close") {
      safeClose(serverSocket, decision.code, decision.reason);
      safeClose(workerFacing, decision.code, decision.reason);
    }
    // drop → nothing
  });

  // Local bb → guest
  serverSocket.addEventListener("message", (event) => {
    const decision = filterServerFrame(toText(event.data), scope);
    if (decision.action === "forward") {
      safeSend(workerFacing, decision.frame);
    }
    // drop → nothing
  });

  // Close / error propagation (preserve upstream close semantics).
  workerFacing.addEventListener("close", (event) =>
    safeClose(serverSocket, event.code, event.reason),
  );
  serverSocket.addEventListener("close", (event) =>
    safeClose(workerFacing, event.code, event.reason),
  );
  workerFacing.addEventListener("error", () => safeClose(serverSocket));
  serverSocket.addEventListener("error", () => safeClose(workerFacing));

  return guestFacing;
}

/** Normalise a WS payload to text; binary is decoded UTF-8 before filtering. */
function toText(data: string | ArrayBuffer): string {
  return typeof data === "string" ? data : new TextDecoder().decode(data);
}

function safeSend(socket: WebSocket, frame: string): void {
  try {
    socket.send(frame);
  } catch {
    // Peer already closing/closed — nothing to do.
  }
}

function safeClose(socket: WebSocket, code?: number, reason?: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Already closed, or a code the runtime rejects — best-effort.
  }
}
