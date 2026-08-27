// Minimal echo worker demonstrating HTTP + WebSocket upgrade support in a
// Cloudflare Worker, deployed via the temporary-deployments-for-agents flow.
//
// Two routes:
//   GET  /            -> plain text greeting (proves the deploy)
//   GET  /ws          -> WebSocket upgrade; echoes any text frame back
//                        prefixed with "echo: ". Backed by a Durable Object so
//                        it also validates that DO bindings work through the
//                        temp-account provisioning path.
//   GET  /do/echo     -> HTTP round-trip through the DO (sanity for the DO
//                        binding without needing a WS client).
//
// Why the DO indirection: the point of the spike is to prove that the exact
// primitives our real transport needs (WS + DO for per-owner routing state)
// come through the temp-deployments pipe intact, not just that a Worker
// answers.

export interface Env {
  ECHO_ROOM: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("bb-shared echo worker OK\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/ws" || url.pathname === "/do/echo") {
      // One DO instance per deployment is enough for the spike. In the real
      // transport this would be keyed per bb owner.
      const id = env.ECHO_ROOM.idFromName("singleton");
      const stub = env.ECHO_ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response("not found", { status: 404 });
  },
};

export class EchoRoom {
  state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/do/echo") {
      return new Response("do OK\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname !== "/ws") {
      return new Response("not found", { status: 404 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();

    server.addEventListener("message", (event: MessageEvent) => {
      const data = typeof event.data === "string" ? event.data : "<binary>";
      try {
        server.send(`echo: ${data}`);
      } catch {
        // client gone; nothing to do
      }
    });

    server.addEventListener("close", () => {
      try {
        server.close();
      } catch {}
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
