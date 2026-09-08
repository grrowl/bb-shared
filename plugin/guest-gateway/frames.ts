import type { GuestScope } from "./scope";
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
