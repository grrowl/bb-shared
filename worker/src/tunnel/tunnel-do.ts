/**
 * TunnelDO — the CF-side half of the shared tunnel.
 *
 * Responsibilities in this scaffold:
 *   1. Accept a `/__tunnel` WebSocket upgrade from the owner's local
 *      `SharedTunnel` (issue 14). Bearer-authed via `env.TUNNEL_SECRET`.
 *      Only one tunnel connection is retained at a time — a fresh dial
 *      supersedes the previous socket (the local half's reconnect loop
 *      handles the transition).
 *   2. For any other request, answer 503 with `x-bb-tunnel-offline: 1` when
 *      the tunnel isn't up. When it IS up, we forward the request — but the
 *      wire-protocol side of that forwarding is the LOCAL half's mirror
 *      (issue 14): the local tunnel client reads `open-http` / `open-ws`
 *      frames and streams responses back.
 *
 * The wire-protocol handling on THIS side (encoding open-http, decoding
 * resp-head + body, wrapping visitor WS) is deliberately not implemented
 * yet — it belongs to the same wire-protocol pass as issue 14 so the two
 * halves land together and stay compatible. This scaffold gives us the
 * dial + auth path so 14 can plug in.
 *
 * Structure mirrors bb's `apps/connect/src/tunnel-do.ts` (see spike research
 * notes) so the port later is mechanical.
 */

import type { Env } from "../env.js";

const TUNNEL_TAG = "tunnel";
const WS_READY_STATE_OPEN = 1;

/**
 * Response header the DO sets on a 503 so the worker can distinguish "no
 * tunnel connected" (infra) from a real 503 the local bb answered with. Not
 * used by any pipeline stage yet; belongs to 09's response filter surface.
 */
export const TUNNEL_OFFLINE_HEADER = "x-bb-tunnel-offline";

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

export class TunnelDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

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
    return this.proxyGuestRequest(request);
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
    // The old socket's in-flight streams are dropped; the local reconnect
    // loop is responsible for redialling if the replacement was spurious.
    for (const existing of this.state.getWebSockets(TUNNEL_TAG)) {
      try {
        existing.close(1000, "replaced by a new tunnel connection");
      } catch {
        // already closed
      }
    }

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1], [TUNNEL_TAG]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private proxyGuestRequest(_request: Request): Response {
    const tunnel = this.activeTunnelSocket();
    if (tunnel === null) return this.offlineResponse();

    // TODO(14): implement the CF-side of the wire protocol here:
    //
    //   - allocate a streamId
    //   - encode `open-http` (or `open-ws`) via @bb/tunnel-contract, send on
    //     the tunnel WS
    //   - stream request body as body-chunk frames, terminate with body-end
    //   - collect resp-head + body-chunk frames back and build a Response
    //   - for WS upgrades, mint a visitor WebSocketPair and pump ws-data
    //     frames both ways
    //
    // The local half (issue 14) is the counterpart to this code; both must
    // land together for end-to-end guest traffic. Until then, we answer 503
    // with the offline marker so the worker doesn't lie about being ready.
    return this.offlineResponse();
  }

  private activeTunnelSocket(): WebSocket | null {
    const sockets = this.state.getWebSockets(TUNNEL_TAG);
    // Most recently accepted, still open. Older sockets may linger after an
    // abrupt drop (workerd hasn't garbage-collected them yet).
    for (let i = sockets.length - 1; i >= 0; i--) {
      if (sockets[i].readyState === WS_READY_STATE_OPEN) return sockets[i];
    }
    return null;
  }

  private offlineResponse(): Response {
    return text(
      "bb-shared: no tunnel connected (owner's bb is offline or unpaired)\n",
      503,
      { [TUNNEL_OFFLINE_HEADER]: "1" },
    );
  }

  webSocketMessage(_ws: WebSocket, _message: ArrayBuffer | string): void {
    // No-op: wire-protocol framing arrives here once issue 14 lands.
  }

  webSocketClose(_ws: WebSocket, _code: number, _reason: string): void {
    // No-op: the local half reconnects on its own backoff.
  }

  webSocketError(_ws: WebSocket): void {
    // No-op: identical handling to close.
  }
}
