import { describe, expect, it } from "vitest";
import {
  filterClientFrame,
  filterServerFrame,
  wsFrameFilterStage,
  type ClientFrameDecision,
  type ServerFrameDecision,
} from "../src/stages/ws-frame-filter.js";
import type { GuestScope } from "../src/scope.js";
import type { RequestContext } from "../src/pipeline.js";
import type { TunnelRouter } from "../src/tunnel/interface.js";

// Synthetic scope: thread T1 (in project P1) is shared; thread T2 / project P2
// are NOT. Every case below is stated relative to this scope.
const T_IN = "thread-in-scope";
const T_OUT = "thread-out-of-scope";
const P_IN = "project-in-scope";
const P_OUT = "project-out-of-scope";

const SCOPE: GuestScope = {
  threadIds: new Set([T_IN]),
  projectIds: new Set([P_IN]),
};

const client = (msg: unknown) => filterClientFrame(JSON.stringify(msg), SCOPE);
const server = (msg: unknown) => filterServerFrame(JSON.stringify(msg), SCOPE);

// --- helpers -------------------------------------------------------------

function expectForward(d: ClientFrameDecision | ServerFrameDecision) {
  expect(d.action).toBe("forward");
}
function expectDrop(d: ClientFrameDecision | ServerFrameDecision) {
  expect(d.action).toBe("drop");
}

// =========================================================================
// Guest → local bb: subscribe allowlist
// =========================================================================

describe("filterClientFrame — subscribe allowlist", () => {
  it("forwards ping unconditionally", () => {
    expectForward(client({ type: "ping" }));
  });

  it("forwards subscribe thread-detail for an in-scope thread", () => {
    expectForward(
      client({ type: "subscribe", target: { kind: "thread-detail", threadId: T_IN } }),
    );
  });

  it("drops subscribe thread-detail for an out-of-scope thread", () => {
    expectDrop(
      client({ type: "subscribe", target: { kind: "thread-detail", threadId: T_OUT } }),
    );
  });

  it("forwards unsubscribe thread-detail for an in-scope thread", () => {
    expectForward(
      client({ type: "unsubscribe", target: { kind: "thread-detail", threadId: T_IN } }),
    );
  });

  it("drops unsubscribe thread-detail for an out-of-scope thread", () => {
    expectDrop(
      client({ type: "unsubscribe", target: { kind: "thread-detail", threadId: T_OUT } }),
    );
  });

  it("forwards subscribe project-detail for an in-scope project", () => {
    expectForward(
      client({ type: "subscribe", target: { kind: "project-detail", projectId: P_IN } }),
    );
  });

  it("drops subscribe project-detail for an out-of-scope project", () => {
    expectDrop(
      client({ type: "subscribe", target: { kind: "project-detail", projectId: P_OUT } }),
    );
  });

  it.each([
    "thread-list",
    "project-list",
    "environment-detail",
    "environment-list",
    "host-detail",
    "host-list",
    "system",
  ])("drops subscribe to disallowed target kind %s", (kind) => {
    // list/system/env/host targets carry no id or an irrelevant one; the kind
    // alone determines the drop.
    expectDrop(
      client({
        type: "subscribe",
        target: { kind, threadId: T_IN, projectId: P_IN, environmentId: "e", hostId: "h" },
      }),
    );
  });

  it("drops an unknown-but-parseable subscription target kind", () => {
    expectDrop(
      client({ type: "subscribe", target: { kind: "future-thing", id: "x" } }),
    );
  });

  it("closes 1008 on an unknown message type", () => {
    const d = client({ type: "resubscribe-everything" });
    expect(d).toEqual({ action: "close", code: 1008, reason: "invalid-message" });
  });

  it("closes 1008 on a subscribe with no target", () => {
    const d = client({ type: "subscribe" });
    expect(d).toEqual({ action: "close", code: 1008, reason: "invalid-message" });
  });

  it("closes 1008 on unparseable input", () => {
    const d = filterClientFrame("{not json", SCOPE);
    expect(d).toEqual({ action: "close", code: 1008, reason: "invalid-message" });
  });

  it("closes 1008 on a non-object frame", () => {
    const d = filterClientFrame("42", SCOPE);
    expect(d).toEqual({ action: "close", code: 1008, reason: "invalid-message" });
  });
});

// =========================================================================
// Local bb → guest: in-scope pass / out-of-scope drop
// =========================================================================

describe("filterServerFrame — changed/thread scoping", () => {
  it("passes changed/thread for an in-scope thread (events-appended)", () => {
    const d = server({
      type: "changed",
      entity: "thread",
      id: T_IN,
      changes: ["events-appended"],
    });
    expectForward(d);
  });

  it("drops changed/thread for an out-of-scope thread", () => {
    expectDrop(
      server({ type: "changed", entity: "thread", id: T_OUT, changes: ["title-changed"] }),
    );
  });

  it("drops an id-less changed/thread (list-wide refresh)", () => {
    expectDrop(server({ type: "changed", entity: "thread", changes: ["order-changed"] }));
  });

  it("preserves an in-scope metadata.projectId verbatim", () => {
    const frame = JSON.stringify({
      type: "changed",
      entity: "thread",
      id: T_IN,
      metadata: { projectId: P_IN },
      changes: ["status-changed"],
    });
    const d = filterServerFrame(frame, SCOPE);
    expect(d.action).toBe("forward");
    if (d.action === "forward") {
      expect(JSON.parse(d.frame).metadata.projectId).toBe(P_IN);
    }
  });

  it("strips an out-of-scope metadata.projectId before relaying", () => {
    const frame = JSON.stringify({
      type: "changed",
      entity: "thread",
      id: T_IN,
      metadata: { projectId: P_OUT, hasPendingInteraction: true },
      changes: ["status-changed"],
    });
    const d = filterServerFrame(frame, SCOPE);
    expect(d.action).toBe("forward");
    if (d.action === "forward") {
      const parsed = JSON.parse(d.frame);
      expect(parsed.metadata.projectId).toBeUndefined();
      // other metadata survives
      expect(parsed.metadata.hasPendingInteraction).toBe(true);
    }
  });
});

describe("filterServerFrame — changed/project scoping", () => {
  it("passes changed/project for an in-scope project", () => {
    expectForward(
      server({ type: "changed", entity: "project", id: P_IN, changes: ["threads-changed"] }),
    );
  });

  it("drops changed/project for an out-of-scope project", () => {
    expectDrop(
      server({ type: "changed", entity: "project", id: P_OUT, changes: ["project-updated"] }),
    );
  });

  it("drops an id-less changed/project", () => {
    expectDrop(server({ type: "changed", entity: "project", changes: ["project-order-changed"] }));
  });
});

// =========================================================================
// Local bb → guest: infrastructure + ephemeral drops
// =========================================================================

describe("filterServerFrame — infrastructure changed events dropped", () => {
  it("drops changed/environment even for an id that echoes an in-scope thread", () => {
    expectDrop(
      server({ type: "changed", entity: "environment", id: T_IN, changes: ["status-changed"] }),
    );
  });

  it("drops changed/host", () => {
    expectDrop(server({ type: "changed", entity: "host", id: "h1", changes: ["host-connected"] }));
  });

  it("drops changed/system", () => {
    expectDrop(server({ type: "changed", entity: "system", changes: ["config-changed"] }));
  });
});

describe("filterServerFrame — ephemeral broadcasts dropped", () => {
  it("drops thread-open even for an in-scope thread/project", () => {
    expectDrop(
      server({
        type: "thread-open",
        projectId: P_IN,
        threadId: T_IN,
        split: "none",
        file: null,
      }),
    );
  });

  it("drops thread-pane-action even for an in-scope thread", () => {
    expectDrop(
      server({ type: "thread-pane-action", projectId: P_IN, threadId: T_IN, action: "maximize" }),
    );
  });

  it("drops plugin-signal unconditionally", () => {
    expectDrop(
      server({ type: "plugin-signal", pluginId: "bb-shared", channel: "x", payload: { secret: 1 } }),
    );
  });
});

describe("filterServerFrame — pong + defaults", () => {
  it("passes pong through", () => {
    expectForward(server({ type: "pong" }));
  });

  it("drops an unrecognised server frame type (default-drop)", () => {
    expectDrop(server({ type: "some-future-broadcast", data: 1 }));
  });

  it("drops an unparseable server frame without closing", () => {
    const d = filterServerFrame("<<garbage", SCOPE);
    expect(d).toEqual({ action: "drop", reason: "unparseable server frame" });
  });
});

// =========================================================================
// Full synthetic frame streams
// =========================================================================

describe("synthetic streams", () => {
  it("guest→local: only in-scope subscribes + ping survive", () => {
    const stream = [
      { type: "ping" },
      { type: "subscribe", target: { kind: "thread-detail", threadId: T_IN } },
      { type: "subscribe", target: { kind: "thread-detail", threadId: T_OUT } },
      { type: "subscribe", target: { kind: "project-detail", projectId: P_IN } },
      { type: "subscribe", target: { kind: "thread-list" } },
      { type: "subscribe", target: { kind: "system" } },
    ];
    const forwarded = stream.map(client).filter((d) => d.action === "forward");
    expect(forwarded).toHaveLength(3);
  });

  it("local→guest: only in-scope thread/project changes + pong survive", () => {
    const stream = [
      { type: "pong" },
      { type: "changed", entity: "thread", id: T_IN, changes: ["events-appended"] },
      { type: "changed", entity: "thread", id: T_OUT, changes: ["events-appended"] },
      { type: "changed", entity: "project", id: P_IN, changes: ["threads-changed"] },
      { type: "changed", entity: "environment", id: "e1", changes: ["git-refs-changed"] },
      { type: "changed", entity: "host", id: "h1", changes: ["host-connected"] },
      { type: "thread-open", projectId: P_IN, threadId: T_IN, split: "none", file: null },
      { type: "plugin-signal", pluginId: "p", channel: "c", payload: {} },
    ];
    const forwarded = stream.map(server).filter((d) => d.action === "forward");
    expect(forwarded).toHaveLength(3);
  });
});

// =========================================================================
// Stage wiring: terminal reject + pass-through
// =========================================================================

// The stage never reaches this router for the terminal-reject or non-upgrade
// paths; dispatch would throw if wrongly invoked, proving those branches short.
const explodingRouter: TunnelRouter = {
  acceptTunnelDial: () => {
    throw new Error("acceptTunnelDial should not be called");
  },
  dispatch: () => {
    throw new Error("dispatch should not be called for this case");
  },
};

function ctxFor(pathname: string, headers: Record<string, string>): RequestContext {
  const url = new URL(`https://guests-abc.workers.dev${pathname}`);
  return {
    request: new Request(url, { headers }),
    url,
    env: {} as never,
    ctx: {} as never,
    workerPublicOrigin: url.origin,
    token: "bbsh_" + "A".repeat(32),
    scope: SCOPE,
  };
}

describe("wsFrameFilterStage — routing", () => {
  it("rejects a guest terminal WS upgrade with 403", async () => {
    const stage = wsFrameFilterStage(explodingRouter);
    const result = await stage.run(
      ctxFor("/ws/terminals/term-123", { upgrade: "websocket" }),
    );
    expect(result.kind).toBe("respond");
    if (result.kind === "respond") {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      expect(body).toMatchObject({ error: "scope" });
    }
  });

  it("passes a plain HTTP request straight through (continue)", async () => {
    const stage = wsFrameFilterStage(explodingRouter);
    const result = await stage.run(ctxFor("/api/v1/system/config", {}));
    expect(result.kind).toBe("continue");
  });

  it("passes a non-upgrade request to /ws through (continue)", async () => {
    const stage = wsFrameFilterStage(explodingRouter);
    const result = await stage.run(ctxFor("/ws", {}));
    expect(result.kind).toBe("continue");
  });

  it("lets a non-terminal, non-/ws upgrade fall through to dispatch", async () => {
    const stage = wsFrameFilterStage(explodingRouter);
    const result = await stage.run(
      ctxFor("/some/other/ws", { upgrade: "websocket" }),
    );
    expect(result.kind).toBe("continue");
  });

  it("dispatches an in-scope /ws upgrade through the tunnel", async () => {
    let dispatched = false;
    const router: TunnelRouter = {
      acceptTunnelDial: () => {
        throw new Error("nope");
      },
      // Simulate a tunnel that is offline: no webSocket on the response, so the
      // stage returns it untouched without touching WebSocketPair (unavailable
      // in the node test pool).
      dispatch: async () => {
        dispatched = true;
        return new Response(JSON.stringify({ error: "tunnel_offline" }), {
          status: 503,
        });
      },
    };
    const stage = wsFrameFilterStage(router);
    const result = await stage.run(ctxFor("/ws", { upgrade: "websocket" }));
    expect(dispatched).toBe(true);
    expect(result.kind).toBe("respond");
    if (result.kind === "respond") {
      expect(result.response.status).toBe(503);
    }
  });
});
