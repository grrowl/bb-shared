/**
 * TunnelDO — the CF-side half of the shared tunnel.
 *
 * Responsibilities:
 *   1. Accept a `/__tunnel` WebSocket upgrade from the owner's local
 *      `SharedTunnel` (issue 14). Bearer-authed via `env.TUNNEL_SECRET`.
 *      Only one tunnel connection is retained at a time — a fresh dial
 *      supersedes the previous socket (the local half's reconnect loop
 *      handles the transition).
 *   2. For any guest request, multiplex it over that one tunnel socket:
 *      allocate a `streamId`, encode `open-http` / `open-ws` via the vendored
 *      tunnel contract, stream the body across, reassemble `resp-head` + body
 *      frames into a Response, and pump `ws-data` both ways for upgrades.
 *   3. Answer 503 with `x-bb-tunnel-offline: 1` when no tunnel is connected.
 *
 * This is a faithful port of bb's `apps/connect/src/tunnel-do.ts` (issue 27,
 * decision in `.scratch/v0/issues/27-*.md`), trimmed of the bits bb-shared does
 * not need: no D1/presence/machine bookkeeping, and no `target` port-sharing
 * (bb-shared is one worker per bb instance; every stream routes to the single
 * loopback origin, so the DO never sets a `target` on any frame). The wire
 * protocol, stream demux, backpressure/cleanup, and hibernatable-WebSocket
 * handling all mirror upstream so the two halves stay bug-compatible.
 *
 * Hibernation: the DO uses the Hibernatable WebSocket API (`acceptWebSocket`,
 * `webSocketMessage`). The tunnel socket is tagged `tunnel`; each visitor WS is
 * tagged `visitor:<streamId>` with the id also in its serialized attachment so
 * the mapping survives hibernation. In-flight HTTP requests live in instance
 * memory only — an in-flight request keeps the DO active, so that state cannot
 * be lost to hibernation while it matters.
 */

import type { Env } from "../env.js";
import {
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  decodeFrame,
  encodeFrame,
  type Frame,
  type HeaderPair,
} from "@bb-shared/tunnel-contract";
import { relayedResponse } from "./response-encoding.js";

const TUNNEL_TAG = "tunnel";
const WS_READY_STATE_OPEN = 1;
const RESP_HEAD_TIMEOUT_MS = 30_000;
/** Body chunks handed to the tunnel are split to at most this many bytes. */
const MAX_CHUNK_BYTES = 1024 * 1024;

/**
 * Response header the DO sets on a 503 so the worker can distinguish "no
 * tunnel connected" (infra) from a real 503 the local bb answered with.
 */
export const TUNNEL_OFFLINE_HEADER = "x-bb-tunnel-offline";

/**
 * Headers that must not be forwarded in either direction — hop-by-hop headers
 * and the WebSocket handshake headers workerd manages itself. (bb-shared has no
 * `x-bb-tunnel-target` header; the upstream entry for it is dropped here.)
 */
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "expect",
  "host",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
]);

function forwardableHeaders(headers: Headers): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  headers.forEach((value, name) => {
    if (!HOP_HEADERS.has(name.toLowerCase())) pairs.push([name, value]);
  });
  return pairs;
}

function text(body: string, status: number, headers?: HeadersInit): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...headers,
    },
  });
}

function bearerFrom(header: string | null): string | null {
  if (header === null) return null;
  if (!header.startsWith("Bearer ")) return null;
  const value = header.slice("Bearer ".length).trim();
  return value.length > 0 ? value : null;
}

/**
 * Constant-time equality on same-length strings. The XOR loop accumulates into
 * `diff` and returns only after the FULL pass — it never short-circuits on the
 * first differing character, so there is no per-character timing oracle.
 *
 * On a length mismatch we early-return `false` before the loop. This leaks (by
 * timing) only whether the presented bearer had the right *length* — NOT its
 * contents. That is not a per-char oracle, and it is not exploitable here: the
 * secret length is fixed at 32 bytes (43 base64url chars), so a length mismatch
 * leaks only length, which is already public via the accepted secret shape. A
 * configured TUNNEL_SECRET of "" is treated as unset — never authenticate.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length === 0) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Clamp arbitrary close codes to ones close() is allowed to send. */
function safeCloseCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
}

interface PendingHttp {
  resolve: (response: Response) => void;
  /** Set once resp-head arrives and the body stream exists. */
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  /** Serializes body writes so chunk order is preserved without blocking the socket handler. */
  writeChain: Promise<void>;
  timeout: ReturnType<typeof setTimeout>;
}

export class TunnelDO {
  private readonly pendingHttp = new Map<number, PendingHttp>();
  private nextStreamId: number;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    // Resume stream-id allocation above any visitor sockets that survived
    // hibernation so ids are never reused while a socket still holds one.
    let maxSeen = 0;
    for (const ws of this.state.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as {
        streamId?: number;
      } | null;
      if (attachment?.streamId && attachment.streamId > maxSeen)
        maxSeen = attachment.streamId;
    }
    this.nextStreamId = maxSeen + 1;
    // Answer heartbeat text pings with a DO auto-response so a hibernating DO
    // keeps the tunnel alive without waking to run JS. Guarded so the DO stays
    // constructible under the Node vitest pool, where this global is absent.
    if (typeof WebSocketRequestResponsePair !== "undefined") {
      this.state.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(HEARTBEAT_REQUEST, HEARTBEAT_RESPONSE),
      );
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__tunnel") {
      return this.acceptTunnel(request);
    }
    // Reserve `/__` for internal tunnel routes; everything else is guest
    // traffic to be proxied.
    if (url.pathname.startsWith("/__")) {
      return text("bb-shared: not found\n", 404);
    }
    return this.proxyGuestRequest(request, url);
  }

  private acceptTunnel(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return text("bb-shared tunnel: expected websocket upgrade\n", 426);
    }
    const secret = this.env.TUNNEL_SECRET ?? "";
    const presented = bearerFrom(request.headers.get("authorization"));
    if (presented === null) {
      return text("bb-shared tunnel: missing bearer\n", 401);
    }
    if (!timingSafeEqual(secret, presented)) {
      return text("bb-shared tunnel: invalid credential\n", 401);
    }

    // Single tunnel per worker: a fresh dial replaces any previous socket.
    for (const existing of this.state.getWebSockets(TUNNEL_TAG)) {
      try {
        existing.close(1000, "replaced by a new tunnel connection");
      } catch {
        // already closed — must not block the replacement from connecting
      }
    }
    // Streams opened over a replaced (or hibernated-away) tunnel belong to the
    // old client session — the connecting client has no state for them, so
    // their frames will never arrive. Fail them now: a mid-body response has no
    // timeout and would otherwise hang its visitor forever.
    this.abandonStreams("tunnel reconnected mid-request", "tunnel reconnected");

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1], [TUNNEL_TAG]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private proxyGuestRequest(request: Request, url: URL): Promise<Response> {
    const tunnel = this.activeTunnelSocket();
    if (tunnel === null) return Promise.resolve(this.offlineResponse());

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return Promise.resolve(this.openVisitorWebSocket(request, url, tunnel));
    }
    return this.proxyHttp(request, url, tunnel);
  }

  private activeTunnelSocket(): WebSocket | null {
    // A tunnel socket can die without webSocketClose ever being delivered
    // (abrupt network drop), leaving it tagged but unusable. After a reconnect
    // the runtime can briefly list both the stale socket and the replacement.
    // Pick the most recently accepted OPEN socket; a dead-but-lingering socket
    // must read as "offline", never be proxied to.
    const sockets = this.state.getWebSockets(TUNNEL_TAG);
    for (let i = sockets.length - 1; i >= 0; i--) {
      if (sockets[i].readyState === WS_READY_STATE_OPEN) return sockets[i];
    }
    return null;
  }

  /**
   * send() throws once the socket is closing/closed, and that can race any
   * liveness check. Returns false instead of throwing so callers degrade to
   * their offline path rather than crashing the request.
   */
  private trySend(
    tunnel: WebSocket,
    data: ArrayBuffer | ArrayBufferView | string,
  ): boolean {
    try {
      tunnel.send(data);
      return true;
    } catch {
      return false;
    }
  }

  private offlineResponse(): Response {
    return text(
      "bb-shared: no tunnel connected (owner's bb is offline or unpaired)\n",
      503,
      { [TUNNEL_OFFLINE_HEADER]: "1" },
    );
  }

  private openVisitorWebSocket(
    request: Request,
    url: URL,
    tunnel: WebSocket,
  ): Response {
    const streamId = this.nextStreamId++;
    const protocols =
      request.headers
        .get("sec-websocket-protocol")
        ?.split(",")
        .map((p) => p.trim())
        .filter(Boolean) ?? [];

    // Send the open frame before accepting the visitor socket: if the tunnel
    // died since the liveness check, answer 503 offline instead of leaving an
    // accepted visitor socket with no stream behind it.
    const opened = this.trySend(
      tunnel,
      encodeFrame({
        type: "open-ws",
        streamId,
        path: url.pathname + url.search,
        headers: forwardableHeaders(request.headers),
        protocols,
      }),
    );
    if (!opened) return this.offlineResponse();

    const pair = new WebSocketPair();
    pair[1].serializeAttachment({ streamId });
    this.state.acceptWebSocket(pair[1], [`visitor:${streamId}`]);

    const responseHeaders = new Headers();
    if (protocols.length > 0) {
      // Echo the first offered subprotocol. Every current bb client offers at
      // most one, so this is correct; carrying the origin's negotiated
      // subprotocol back through ws-open-ack is a future refinement.
      responseHeaders.set("sec-websocket-protocol", protocols[0]);
    }
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: responseHeaders,
    });
  }

  private async proxyHttp(
    request: Request,
    url: URL,
    tunnel: WebSocket,
  ): Promise<Response> {
    const streamId = this.nextStreamId++;
    const hasBody = request.body !== null;

    const responsePromise = new Promise<Response>((resolve) => {
      const timeout = setTimeout(() => {
        this.failHttpStream(
          streamId,
          504,
          "timed out waiting for the tunnel client",
        );
      }, RESP_HEAD_TIMEOUT_MS);
      this.pendingHttp.set(streamId, {
        resolve,
        writer: null,
        writeChain: Promise.resolve(),
        timeout,
      });
    });

    const opened = this.trySend(
      tunnel,
      encodeFrame({
        type: "open-http",
        streamId,
        method: request.method,
        path: url.pathname + url.search,
        headers: forwardableHeaders(request.headers),
        hasBody,
      }),
    );
    if (!opened) {
      const entry = this.pendingHttp.get(streamId);
      if (entry) {
        this.pendingHttp.delete(streamId);
        clearTimeout(entry.timeout);
      }
      return this.offlineResponse();
    }

    if (hasBody) {
      void this.pumpRequestBody(streamId, request.body!, tunnel);
    }
    return responsePromise;
  }

  private async pumpRequestBody(
    streamId: number,
    body: ReadableStream<Uint8Array>,
    tunnel: WebSocket,
  ): Promise<void> {
    try {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Reader chunks are far smaller than MAX_CHUNK_BYTES in practice, but
        // split defensively — the contract rejects oversized body chunks.
        for (
          let offset = 0;
          offset < value.length;
          offset += MAX_CHUNK_BYTES
        ) {
          const sent = this.trySend(
            tunnel,
            encodeFrame({
              type: "body-chunk",
              streamId,
              data: value.subarray(offset, offset + MAX_CHUNK_BYTES),
            }),
          );
          // Tunnel died mid-body: nothing left to notify — the client session
          // behind this socket is gone and the stream dies with it.
          if (!sent) return;
        }
      }
      this.trySend(tunnel, encodeFrame({ type: "body-end", streamId }));
    } catch {
      this.trySend(
        tunnel,
        encodeFrame({
          type: "close-stream",
          streamId,
          code: 1011,
          reason: "request body error",
        }),
      );
    }
  }

  /** Fail every in-flight stream: pending HTTP answers 502, visitor sockets close. */
  private abandonStreams(httpReason: string, wsReason: string): void {
    for (const streamId of [...this.pendingHttp.keys()]) {
      this.failHttpStream(streamId, 502, httpReason);
    }
    for (const visitor of this.state.getWebSockets()) {
      if (!this.state.getTags(visitor).includes(TUNNEL_TAG)) {
        try {
          visitor.close(1001, wsReason);
        } catch {
          // already closed
        }
      }
    }
  }

  private failHttpStream(
    streamId: number,
    status: number,
    message: string,
  ): void {
    const entry = this.pendingHttp.get(streamId);
    if (!entry) return;
    this.pendingHttp.delete(streamId);
    clearTimeout(entry.timeout);
    if (entry.writer) {
      // Body already streaming — abort it; the status line is long gone.
      void entry.writeChain
        .then(() => entry.writer?.abort(message))
        .catch(() => {});
    } else {
      entry.resolve(text(`bb-shared: ${message}\n`, status));
    }
  }

  private cancelHttpStream(streamId: number, message: string): void {
    const entry = this.pendingHttp.get(streamId);
    if (!entry) return;
    this.pendingHttp.delete(streamId);
    clearTimeout(entry.timeout);
    const tunnel = this.activeTunnelSocket();
    if (!tunnel) return;
    this.trySend(
      tunnel,
      encodeFrame({ type: "close-stream", streamId, code: 1000, reason: message }),
    );
  }

  webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void {
    const tags = this.state.getTags(ws);
    if (tags.includes(TUNNEL_TAG)) {
      if (typeof message === "string") return; // heartbeats auto-responded; ignore other text
      this.onTunnelFrame(decodeFrame(message));
      return;
    }
    // Visitor socket → wrap into a ws-data frame toward the tunnel client.
    const attachment = ws.deserializeAttachment() as { streamId: number };
    const tunnel = this.activeTunnelSocket();
    if (!tunnel) {
      ws.close(1011, "tunnel disconnected");
      return;
    }
    const isBinary = typeof message !== "string";
    const sent = this.trySend(
      tunnel,
      encodeFrame({
        type: "ws-data",
        streamId: attachment.streamId,
        isBinary,
        data: isBinary
          ? new Uint8Array(message)
          : new TextEncoder().encode(message),
      }),
    );
    if (!sent) ws.close(1011, "tunnel disconnected");
  }

  private onTunnelFrame(frame: Frame): void {
    switch (frame.type) {
      case "resp-head": {
        const entry = this.pendingHttp.get(frame.streamId);
        if (!entry) return;
        clearTimeout(entry.timeout);
        const headers = frame.headers.filter(
          ([name]) => !HOP_HEADERS.has(name.toLowerCase()),
        );
        // Null-body statuses must resolve bodiless: Response throws on a stream
        // body for 204/205/304, and a throw here would strand the visitor's
        // request unresolved forever (its timeout is already cleared). Dev
        // servers answer 304 to every ETag revalidation, so this is the common
        // path on a reload, not an edge case. The entry stays until the
        // client's trailing body-end frame clears it.
        if (
          frame.status === 204 ||
          frame.status === 205 ||
          frame.status === 304
        ) {
          entry.resolve(new Response(null, { status: frame.status, headers }));
          return;
        }
        const { readable, writable } = new TransformStream<
          Uint8Array,
          Uint8Array
        >();
        let response: Response;
        try {
          response = relayedResponse(readable, frame.status, headers);
        } catch {
          // An unconstructable response (e.g. out-of-range status): answer 502
          // rather than leaving the request pending.
          this.pendingHttp.delete(frame.streamId);
          entry.resolve(
            text(
              `bb-shared: unrelayable bb response (status ${frame.status})\n`,
              502,
            ),
          );
          return;
        }
        entry.writer = writable.getWriter();
        void entry.writer.closed.catch(() => {
          this.cancelHttpStream(frame.streamId, "visitor canceled response body");
        });
        entry.resolve(response);
        return;
      }
      case "body-chunk": {
        const entry = this.pendingHttp.get(frame.streamId);
        if (!entry?.writer) return;
        // Copy out of the transient message buffer before queueing the write.
        const copy = frame.data.slice();
        entry.writeChain = entry.writeChain
          .then(() => entry.writer!.write(copy))
          .catch(() => {});
        return;
      }
      case "body-end": {
        const entry = this.pendingHttp.get(frame.streamId);
        if (!entry) return;
        this.pendingHttp.delete(frame.streamId);
        entry.writeChain = entry.writeChain
          .then(() => entry.writer?.close())
          .catch(() => {});
        return;
      }
      case "close-stream": {
        if (this.pendingHttp.has(frame.streamId)) {
          this.failHttpStream(
            frame.streamId,
            502,
            `tunnel client aborted: ${frame.reason}`,
          );
        } else {
          try {
            this.visitorSocket(frame.streamId)?.close(
              safeCloseCode(frame.code),
              frame.reason,
            );
          } catch {
            // already closed
          }
        }
        return;
      }
      case "ws-data": {
        const visitor = this.visitorSocket(frame.streamId);
        if (!visitor) return;
        try {
          visitor.send(
            frame.isBinary ? frame.data : new TextDecoder().decode(frame.data),
          );
        } catch {
          // Visitor socket died; its close handler tells the client.
        }
        return;
      }
      case "ws-open-ack":
        // The upgrade was already answered in openVisitorWebSocket.
        return;
      case "open-http":
      case "open-ws":
        // Streams are only opened by this relay side; ignore.
        return;
    }
  }

  private visitorSocket(streamId: number): WebSocket | null {
    return this.state.getWebSockets(`visitor:${streamId}`)[0] ?? null;
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    const tags = this.state.getTags(ws);
    if (tags.includes(TUNNEL_TAG)) {
      // Only react if this socket is still the active tunnel (a replaced socket
      // closing must not tear down the new tunnel's visitors — acceptTunnel
      // already abandoned the old socket's streams).
      if (this.activeTunnelSocket() !== null) return;
      this.abandonStreams(
        "tunnel disconnected mid-request",
        "tunnel disconnected",
      );
      return;
    }
    const attachment = ws.deserializeAttachment() as { streamId: number };
    const tunnel = this.activeTunnelSocket();
    if (tunnel) {
      this.trySend(
        tunnel,
        encodeFrame({
          type: "close-stream",
          streamId: attachment.streamId,
          code: safeCloseCode(code),
          reason,
        }),
      );
    }
    // Complete the close handshake on the visitor socket (a client-initiated
    // close is delivered here without the runtime echoing it).
    try {
      ws.close(safeCloseCode(code), reason);
    } catch {
      // already closed
    }
  }

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws, 1011, "socket error");
  }
}
