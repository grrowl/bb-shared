import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeFrame,
  encodeFrame,
  type Frame,
} from "@bb-shared/tunnel-contract";
import { TunnelDO, TUNNEL_OFFLINE_HEADER } from "../src/tunnel/tunnel-do.js";
import type { Env } from "../src/env.js";

// ---------------------------------------------------------------------------
// Mocks. The worker vitest pool is plain Node — no workerd — so we stand in for
// the two runtime primitives the DO leans on: the hibernatable WebSocket and
// the DurableObjectState. Frame encode/decode is the REAL vendored contract, so
// every assertion below is against the exact wire bytes the local half speaks.
// ---------------------------------------------------------------------------

let acceptedPairs: FakeWs[] = [];

class FakeWs {
  readyState = 1; // OPEN
  sent: Array<ArrayBuffer | ArrayBufferView | string> = [];
  closes: Array<{ code?: number; reason?: string }> = [];
  tags: string[] = [];
  private attachment: unknown = null;

  send(data: ArrayBuffer | ArrayBufferView | string): void {
    if (this.readyState !== 1) throw new Error("send on closed socket");
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.readyState = 3; // CLOSED
    this.closes.push({ code, reason });
  }
  serializeAttachment(a: unknown): void {
    this.attachment = a;
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }
  /** Decode the binary frames this socket has been sent so far. */
  frames(): Frame[] {
    return this.sent
      .filter((d): d is Uint8Array => d instanceof Uint8Array)
      .map((d) => decodeFrame(d));
  }
}

class FakeState {
  wss: FakeWs[] = [];
  autoResponse: unknown = null;

  getWebSockets(tag?: string): FakeWs[] {
    if (tag === undefined) return [...this.wss];
    return this.wss.filter((w) => w.tags.includes(tag));
  }
  acceptWebSocket(ws: FakeWs, tags?: string[]): void {
    ws.tags = tags ?? [];
    this.wss.push(ws);
    acceptedPairs.push(ws);
  }
  getTags(ws: FakeWs): string[] {
    return ws.tags;
  }
  setWebSocketAutoResponse(pair: unknown): void {
    this.autoResponse = pair;
  }
}

// workerd's WebSocketPair: an indexable pair of sockets. Node lacks it, so the
// visitor-upgrade path installs a fake for the duration of these tests.
class FakeWebSocketPair {
  0: FakeWs;
  1: FakeWs;
  constructor() {
    this[0] = new FakeWs();
    this[1] = new FakeWs();
  }
}

const ENV = { TUNNEL_SECRET: "s".repeat(43), AUTHZ_TOKEN: "a" } as Env;

function withTunnel(state: FakeState): FakeWs {
  const tunnel = new FakeWs();
  state.acceptWebSocket(tunnel, ["tunnel"]);
  acceptedPairs = []; // don't count the tunnel as a "pair" for visitor assertions
  return tunnel;
}

/** Deliver a frame to the DO exactly as workerd would: as an ArrayBuffer. */
function deliver(
  doInstance: TunnelDO,
  tunnel: FakeWs,
  frame: Frame,
): void {
  const bytes = encodeFrame(frame);
  const ab = (bytes.buffer as ArrayBuffer).slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  doInstance.webSocketMessage(tunnel as unknown as WebSocket, ab);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * Drive a WebSocket upgrade through the DO. The open-ws frame is sent and the
 * visitor socket accepted synchronously, BEFORE the 101 Response is built; Node
 * (undici) rejects a status-101 Response that workerd accepts, so we swallow
 * that runtime-only throw — every assertion is on the framing side effects.
 */
function upgrade(doInstance: TunnelDO, url: string, headers: HeadersInit): void {
  void Promise.resolve(
    doInstance.fetch(new Request(url, { headers })),
  ).catch(() => {});
}

beforeEach(() => {
  acceptedPairs = [];
  (globalThis as { WebSocketPair?: unknown }).WebSocketPair =
    FakeWebSocketPair as unknown;
});
afterEach(() => {
  delete (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
});

function makeDO(state: FakeState): TunnelDO {
  return new TunnelDO(state as unknown as DurableObjectState, ENV);
}

// ---------------------------------------------------------------------------
// Offline behaviour
// ---------------------------------------------------------------------------

describe("proxy — no tunnel connected", () => {
  it("answers 503 with the offline marker when no tunnel socket exists", async () => {
    const state = new FakeState();
    const doInstance = makeDO(state);
    const res = await doInstance.fetch(
      new Request("https://guests-abc.workers.dev/api/v1/system/config"),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get(TUNNEL_OFFLINE_HEADER)).toBe("1");
  });

  it("treats a non-OPEN tunnel socket as offline", async () => {
    const state = new FakeState();
    const tunnel = withTunnel(state);
    tunnel.readyState = 3; // CLOSED but still tagged/lingering
    const doInstance = makeDO(state);
    const res = await doInstance.fetch(
      new Request("https://guests-abc.workers.dev/api/v1/x"),
    );
    expect(res.status).toBe(503);
  });

  it("404s an internal /__ path that is not /__tunnel", async () => {
    const state = new FakeState();
    withTunnel(state);
    const doInstance = makeDO(state);
    const res = await doInstance.fetch(
      new Request("https://guests-abc.workers.dev/__secret"),
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// HTTP round-trip framing
// ---------------------------------------------------------------------------

describe("proxyHttp — request framing", () => {
  it("encodes a bodyless GET as an open-http frame with forwarded headers", async () => {
    const state = new FakeState();
    const tunnel = withTunnel(state);
    const doInstance = makeDO(state);

    void doInstance.fetch(
      new Request("https://guests-abc.workers.dev/api/v1/threads?limit=5", {
        method: "GET",
        headers: { "x-demo": "1", origin: "https://guests-abc.workers.dev" },
      }),
    );

    const frames = tunnel.frames();
    expect(frames).toHaveLength(1);
    const open = frames[0];
    expect(open.type).toBe("open-http");
    if (open.type !== "open-http") throw new Error("wrong frame");
    expect(open.method).toBe("GET");
    expect(open.path).toBe("/api/v1/threads?limit=5");
    expect(open.hasBody).toBe(false);
    const headerNames = open.headers.map(([n]) => n.toLowerCase());
    expect(headerNames).toContain("x-demo");
    expect(headerNames).toContain("origin");
    // hop-by-hop headers never cross the tunnel
    expect(headerNames).not.toContain("host");
    expect(headerNames).not.toContain("connection");
    // no port-sharing in bb-shared: never a target
    expect(open.target).toBeUndefined();
  });

  it("streams a request body as body-chunk + body-end after the open frame", async () => {
    const state = new FakeState();
    const tunnel = withTunnel(state);
    const doInstance = makeDO(state);

    void doInstance.fetch(
      new Request("https://guests-abc.workers.dev/api/v1/threads/t1/send", {
        method: "POST",
        body: "hello body",
        headers: { "content-type": "text/plain" },
      }),
    );
    await flush();

    const types = tunnel.frames().map((f) => f.type);
    expect(types[0]).toBe("open-http");
    expect(types).toContain("body-chunk");
    expect(types[types.length - 1]).toBe("body-end");

    const chunk = tunnel.frames().find((f) => f.type === "body-chunk");
    if (chunk?.type !== "body-chunk") throw new Error("no body chunk");
    expect(new TextDecoder().decode(chunk.data)).toBe("hello body");

    const open = tunnel.frames()[0];
    if (open.type !== "open-http") throw new Error("wrong frame");
    expect(open.hasBody).toBe(true);
  });

  it("reassembles resp-head + body-chunk + body-end into a streamed Response", async () => {
    const state = new FakeState();
    const tunnel = withTunnel(state);
    const doInstance = makeDO(state);

    const resPromise = doInstance.fetch(
      new Request("https://guests-abc.workers.dev/api/v1/hello"),
    );
    const open = tunnel.frames()[0];
    if (open.type !== "open-http") throw new Error("wrong frame");
    const streamId = open.streamId;

    deliver(doInstance, tunnel, {
      type: "resp-head",
      streamId,
      status: 201,
      headers: [["content-type", "application/json"]],
    });
    deliver(doInstance, tunnel, {
      type: "body-chunk",
      streamId,
      data: new TextEncoder().encode('{"ok":'),
    });
    deliver(doInstance, tunnel, {
      type: "body-chunk",
      streamId,
      data: new TextEncoder().encode("true}"),
    });
    deliver(doInstance, tunnel, { type: "body-end", streamId });

    const res = await resPromise;
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe('{"ok":true}');
  });

  it("resolves a 204 as a bodiless Response", async () => {
    const state = new FakeState();
    const tunnel = withTunnel(state);
    const doInstance = makeDO(state);

    const resPromise = doInstance.fetch(
      new Request("https://guests-abc.workers.dev/api/v1/nothing"),
    );
    const streamId = (tunnel.frames()[0] as { streamId: number }).streamId;
    deliver(doInstance, tunnel, {
      type: "resp-head",
      streamId,
      status: 204,
      headers: [],
    });
    const res = await resPromise;
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("strips hop-by-hop headers off the relayed response", async () => {
    const state = new FakeState();
    const tunnel = withTunnel(state);
    const doInstance = makeDO(state);

    const resPromise = doInstance.fetch(
      new Request("https://guests-abc.workers.dev/api/v1/hello"),
    );
    const streamId = (tunnel.frames()[0] as { streamId: number }).streamId;
    deliver(doInstance, tunnel, {
      type: "resp-head",
      streamId,
      status: 200,
      headers: [
        ["content-type", "text/plain"],
        ["transfer-encoding", "chunked"],
        ["connection", "keep-alive"],
      ],
    });
    deliver(doInstance, tunnel, { type: "body-end", streamId });
    const res = await resPromise;
    expect(res.headers.get("transfer-encoding")).toBeNull();
    expect(res.headers.get("connection")).toBeNull();
    expect(res.headers.get("content-type")).toBe("text/plain");
  });

  it("fails a pending HTTP stream with 502 on a close-stream frame", async () => {
    const state = new FakeState();
    const tunnel = withTunnel(state);
    const doInstance = makeDO(state);

    const resPromise = doInstance.fetch(
      new Request("https://guests-abc.workers.dev/api/v1/hello"),
    );
    const streamId = (tunnel.frames()[0] as { streamId: number }).streamId;
    deliver(doInstance, tunnel, {
      type: "close-stream",
      streamId,
      code: 1011,
      reason: "origin unreachable",
    });
    const res = await resPromise;
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("origin unreachable");
  });

  it("allocates a distinct stream id per concurrent request", async () => {
    const state = new FakeState();
    const tunnel = withTunnel(state);
    const doInstance = makeDO(state);

    void doInstance.fetch(new Request("https://guests-abc.workers.dev/a"));
    void doInstance.fetch(new Request("https://guests-abc.workers.dev/b"));

    const ids = tunnel
      .frames()
      .filter((f) => f.type === "open-http")
      .map((f) => (f as { streamId: number }).streamId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tunnel teardown cleans up in-flight streams
// ---------------------------------------------------------------------------

describe("tunnel disconnect", () => {
  it("fails in-flight HTTP with 502 when the tunnel socket closes", async () => {
    const state = new FakeState();
    const tunnel = withTunnel(state);
    const doInstance = makeDO(state);

    const resPromise = doInstance.fetch(
      new Request("https://guests-abc.workers.dev/api/v1/hello"),
    );
    // socket drops
    tunnel.readyState = 3;
    doInstance.webSocketClose(
      tunnel as unknown as WebSocket,
      1006,
      "abnormal",
    );
    const res = await resPromise;
    expect(res.status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// WebSocket passthrough framing
// ---------------------------------------------------------------------------

describe("openVisitorWebSocket — WS passthrough", () => {
  it("sends an open-ws frame and registers a visitor socket on upgrade", () => {
    const state = new FakeState();
    const tunnel = withTunnel(state);
    const doInstance = makeDO(state);

    upgrade(doInstance, "https://guests-abc.workers.dev/ws", {
      upgrade: "websocket",
      "sec-websocket-protocol": "bb-v1",
    });

    const open = tunnel.frames().find((f) => f.type === "open-ws");
    if (open?.type !== "open-ws") throw new Error("no open-ws frame");
    expect(open.path).toBe("/ws");
    expect(open.protocols).toEqual(["bb-v1"]);

    // a visitor socket was accepted, tagged with its stream id
    const visitor = state.getWebSockets(`visitor:${open.streamId}`)[0];
    expect(visitor).toBeDefined();
  });

  it("relays a ws-data frame from the tunnel to the visitor socket", () => {
    const state = new FakeState();
    const tunnel = withTunnel(state);
    const doInstance = makeDO(state);

    upgrade(doInstance, "https://guests-abc.workers.dev/ws", {
      upgrade: "websocket",
    });
    const open = tunnel.frames().find((f) => f.type === "open-ws");
    if (open?.type !== "open-ws") throw new Error("no open-ws frame");
    const visitor = state.getWebSockets(`visitor:${open.streamId}`)[0];

    deliver(doInstance, tunnel, {
      type: "ws-data",
      streamId: open.streamId,
      isBinary: false,
      data: new TextEncoder().encode('{"type":"pong"}'),
    });
    expect(visitor.sent).toContain('{"type":"pong"}');
  });

  it("wraps a visitor message into a ws-data frame toward the tunnel", () => {
    const state = new FakeState();
    const tunnel = withTunnel(state);
    const doInstance = makeDO(state);

    upgrade(doInstance, "https://guests-abc.workers.dev/ws", {
      upgrade: "websocket",
    });
    const open = tunnel.frames().find((f) => f.type === "open-ws");
    if (open?.type !== "open-ws") throw new Error("no open-ws frame");
    const visitor = state.getWebSockets(`visitor:${open.streamId}`)[0];

    doInstance.webSocketMessage(
      visitor as unknown as WebSocket,
      '{"type":"ping"}',
    );

    const wsData = tunnel.frames().find((f) => f.type === "ws-data");
    if (wsData?.type !== "ws-data") throw new Error("no ws-data frame");
    expect(wsData.streamId).toBe(open.streamId);
    expect(wsData.isBinary).toBe(false);
    expect(new TextDecoder().decode(wsData.data)).toBe('{"type":"ping"}');
  });

  it("closes the visitor socket on a close-stream frame", () => {
    const state = new FakeState();
    const tunnel = withTunnel(state);
    const doInstance = makeDO(state);

    upgrade(doInstance, "https://guests-abc.workers.dev/ws", {
      upgrade: "websocket",
    });
    const open = tunnel.frames().find((f) => f.type === "open-ws");
    if (open?.type !== "open-ws") throw new Error("no open-ws frame");
    const visitor = state.getWebSockets(`visitor:${open.streamId}`)[0];

    deliver(doInstance, tunnel, {
      type: "close-stream",
      streamId: open.streamId,
      code: 1000,
      reason: "bye",
    });
    expect(visitor.readyState).toBe(3);
    expect(visitor.closes[0]).toEqual({ code: 1000, reason: "bye" });
  });
});

// ---------------------------------------------------------------------------
// Hibernation: stream-id allocation resumes above surviving sockets
// ---------------------------------------------------------------------------

describe("hibernation — stream id resume", () => {
  it("resumes stream ids above the max surviving visitor attachment", () => {
    const state = new FakeState();
    const tunnel = withTunnel(state);
    // A visitor socket that survived hibernation, holding stream id 7.
    const survivor = new FakeWs();
    survivor.serializeAttachment({ streamId: 7 });
    state.acceptWebSocket(survivor, ["visitor:7"]);

    const doInstance = makeDO(state);
    void doInstance.fetch(new Request("https://guests-abc.workers.dev/x"));
    const open = tunnel.frames().find((f) => f.type === "open-http");
    expect((open as { streamId: number }).streamId).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Tunnel dial auth (unchanged from the scaffold, re-covered here)
// ---------------------------------------------------------------------------

describe("acceptTunnel — dial auth", () => {
  it("426s a non-websocket dial", async () => {
    const state = new FakeState();
    const doInstance = makeDO(state);
    const res = await doInstance.fetch(
      new Request("https://guests-abc.workers.dev/__tunnel"),
    );
    expect(res.status).toBe(426);
  });

  it("401s a dial with no bearer", async () => {
    const state = new FakeState();
    const doInstance = makeDO(state);
    const res = await doInstance.fetch(
      new Request("https://guests-abc.workers.dev/__tunnel", {
        headers: { upgrade: "websocket" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("401s a dial with the wrong bearer", async () => {
    const state = new FakeState();
    const doInstance = makeDO(state);
    const res = await doInstance.fetch(
      new Request("https://guests-abc.workers.dev/__tunnel", {
        headers: { upgrade: "websocket", authorization: "Bearer nope" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("accepts a correctly-bearer'd dial and abandons a replaced tunnel's streams", async () => {
    const state = new FakeState();
    const oldTunnel = withTunnel(state);
    const doInstance = makeDO(state);

    // An in-flight request over the old tunnel.
    const resPromise = doInstance.fetch(
      new Request("https://guests-abc.workers.dev/api/v1/inflight"),
    );

    // A fresh dial replaces it. (Node's undici rejects a status-101 Response
    // that workerd builds fine; the accept/replace side effects run first, so
    // we assert on those rather than the unbuildable 101.)
    await doInstance
      .fetch(
        new Request("https://guests-abc.workers.dev/__tunnel", {
          headers: {
            upgrade: "websocket",
            authorization: `Bearer ${ENV.TUNNEL_SECRET}`,
          },
        }),
      )
      .catch(() => {});
    // a replacement tunnel socket was accepted
    expect(state.getWebSockets("tunnel").length).toBeGreaterThanOrEqual(1);
    // old socket was closed by the replace
    expect(oldTunnel.readyState).toBe(3);
    // the in-flight request was failed, not left hanging
    const failed = await resPromise;
    expect(failed.status).toBe(502);
  });
});
