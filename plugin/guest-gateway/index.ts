import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { computeAuthz } from "../authz/authz";
import type { Store, Token } from "../lib/token-store";
import type { KeyProvider } from "../lib/device-key";
import { Sessions, COOKIE, type RecordKv } from "./sessions";
import { matchResponseFilter } from "./responses";
import { shimForPerms, insertShimIntoHtml } from "./chrome";
import { filterClientFrame, filterServerFrame } from "./frames";
import type { GuestScope } from "./scope";
export interface GatewayOptions { loopbackBaseUrl: string; store: Store; keyProvider: KeyProvider; storage: RecordKv; log?: { warn(message: string): void } }
export function createGuestGateway(options: GatewayOptions) {
  const base = new URL(options.loopbackBaseUrl);
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new Error("Guest gateway requires a loopback HTTP server");
  const sessions = new Sessions(options.store, options.storage, options.keyProvider);
  const readinessKey = randomBytes(32);
  const proof = (challenge: string) => createHmac("sha256", readinessKey).update(challenge).digest("hex");
  const sockets = new Set<() => void>();
  const controllers = new Set<AbortController>();
  let startedUrl: string | undefined;
  const scope = (token: Token): GuestScope => ({ threadIds: new Set(token.shares.map(s => s.thread_id)), projectIds: new Set(token.shares.map(s => s.project_id)) });
  function headers(req: IncomingMessage): Headers {
    // An allowlist prevents any BB owner token, cookie, proxy credential or
    // future forwarding header from crossing this trust boundary.
    const result = new Headers();
    for (const name of ["accept", "content-type", "accept-language", "range"]) {
      const value = req.headers[name]; if (typeof value === "string") result.set(name, value);
    }
    result.set("origin", base.origin);
    result.set("accept-encoding", "identity");
    return result;
  }
  function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "referrer-policy": "no-referrer" }); res.end(JSON.stringify(body));
  }
  function requestUrl(req: IncomingMessage): URL {
    const raw = req.url ?? "/";
    if (!raw.startsWith("/") || raw.startsWith("//") || /[\\\x00-\x20]/.test(raw) || /%(?:2f|5c|2e|00)/i.test(raw)) throw new Error("Invalid request target");
    return new URL(raw, base.origin);
  }
  const server = createServer((req, res) => { void handle(req, res).catch(() => { if (!res.headersSent) json(res, 502, { error: "Guest gateway unavailable" }); else res.destroy(); }); });
  async function handle(req: IncomingMessage, res: ServerResponse) {
    let url: URL;
    try { url = requestUrl(req); } catch { json(res, 400, { error: "Invalid request target" }); return; }
    if (url.pathname === "/__bb_shared/ready" && req.method === "GET") {
      const challenge = url.searchParams.get("challenge") ?? "";
      if (challenge.length > 256) { json(res, 400, { error: "Invalid challenge" }); return; }
      const response = await fetch(new URL("/api/v1/system/version", base), { redirect: "manual", signal: AbortSignal.timeout(5000) });
      await response.body?.cancel();
      json(res, response.ok ? 200 : 503, response.ok ? { service: "bb-shared-gateway", version: 1, challenge, proof: proof(challenge) } : { error: "BB unavailable" }); return;
    }
    const id = sessions.cookieId(req.headers.cookie);
    if (url.searchParams.has("token")) {
      if (req.method !== "GET" || url.searchParams.getAll("token").length !== 1) { json(res, 400, { error: "Invalid invitation redemption" }); return; }
      const raw = url.searchParams.get("token")!;
      if (!/^bbsh_[A-Za-z0-9_-]{43}$/.test(raw)) { json(res, 401, { error: "Invalid invitation" }); return; }
      const redeemed = await sessions.redeem(raw, id);
      if (!redeemed) { json(res, 401, { error: "Invalid or revoked invitation" }); return; }
      url.searchParams.delete("token");
      res.writeHead(303, { location: url.pathname + url.search, "set-cookie": `${COOKIE}=${redeemed}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`, "cache-control": "no-store", "referrer-policy": "no-referrer" }); res.end(); return;
    }
    const token = await sessions.resolve(id);
    if (!token) { json(res, 401, { error: "Open a valid invitation to view shared threads" }); return; }
    if (!["GET", "HEAD"].includes(req.method ?? "GET")) {
      // Session cookies are browser credentials: reject cross-site writes even
      // when a same-site sibling host can cause the browser to attach them.
      const origin = req.headers.origin;
      const publicOrigin = req.headers["x-bb-shared-public-origin"];
      if (req.headers["sec-fetch-site"] === "cross-site" || (origin && publicOrigin && origin !== publicOrigin)) {
        json(res, 403, { error: "Cross-origin writes are not permitted" }); return;
      }
      if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? "")) {
        json(res, 415, { error: "Guest messages require JSON" }); return;
      }
    }
    const decision = computeAuthz(token, url.pathname, req.method ?? "GET");
    if (!decision.allowed) { json(res, 403, { error: "This invitation does not permit that request" }); return; }
    const filter = matchResponseFilter("GET", url.pathname);
    if (filter?.kind === "constant") { json(res, 200, filter.value); return; }
    // The thread endpoint can optionally embed an entire host/environment.
    // Those resources are outside the transcript grant, even for its owner.
    if (/^\/api\/v1\/threads\/[^/]+\/?$/.test(url.pathname)) url.searchParams.delete("include");
    if (["/api/v1/system/providers", "/api/v1/system/execution-options"].includes(url.pathname.replace(/\/+$/, ""))) {
      url.searchParams.delete("hostId"); url.searchParams.delete("environmentId");
    }
    const controller = new AbortController(); controllers.add(controller);
    res.on("close", () => controller.abort());
    const timer = setTimeout(() => controller.abort(), 120_000); timer.unref();
    try {
      const init: RequestInit & {duplex?: "half"} = { method: req.method, headers: headers(req), redirect: "manual", signal: controller.signal };
      if (req.method !== "GET" && req.method !== "HEAD") {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) { json(res, 413, { error: "Guest message is too large" }); return; }
          chunks.push(Buffer.from(chunk));
        }
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { json(res, 400, { error: "Invalid message JSON" }); return; }
        const message = body as { input?: unknown; mode?: unknown } | null;
        if (!message || !Array.isArray(message.input) || message.input.length === 0 || message.input.length > 128 || message.input.some(item => !item || item.type !== "text" || typeof item.text !== "string")) {
          json(res, 400, { error: "Guest messages support text input only" }); return;
        }
        if (typeof message.mode !== "string" || !["queue-if-active", "steer-if-active", "auto", "start", "steer"].includes(message.mode)) {
          json(res, 400, { error: "Invalid message mode" }); return;
        }
        // Preserve the thread owner's execution policy. The normal send API
        // also accepts permissionMode, model, senderThreadId, input sources,
        // local file attachments and mentions, none of which this grant grants.
        init.body = JSON.stringify({ input: message.input.map(item => ({type: "text", text: item.text, mentions: []})), mode: message.mode });
      }
      const upstream = await fetch(url, init);
      // Never relay owner Set-Cookie, CORS, authentication or proxy headers.
      for (const name of ["content-type", "content-range", "accept-ranges"]) { const value = upstream.headers.get(name); if (value) res.setHeader(name, value); }
      res.setHeader("cache-control", "no-store"); res.setHeader("referrer-policy", "no-referrer"); res.setHeader("x-content-type-options", "nosniff");
      res.statusCode = upstream.status;
      const location = upstream.headers.get("location");
      if (location) { const target = new URL(location, base); if (target.origin !== base.origin) { await upstream.body?.cancel(); json(res, 502, { error: "Unexpected upstream redirect" }); return; } res.setHeader("location", target.pathname + target.search + target.hash); }
      if (req.method === "HEAD" || !upstream.body) { await upstream.body?.cancel(); res.end(); return; }
      if (upstream.ok && filter?.kind === "reshape") {
        if (!upstream.headers.get("content-type")?.includes("application/json")) { await upstream.body.cancel(); json(res, 502, { error: "Unexpected BB response" }); return; }
        json(res, upstream.status, filter.filter(await upstream.json(), scope(token))); return;
      }
      if (upstream.ok && /^text\/html\b/i.test(upstream.headers.get("content-type") ?? "")) {
        res.end(insertShimIntoHtml(await upstream.text(), shimForPerms(decision.perms.map(p => ({threadId:p.thread_id,mode:p.mode}))))); return;
      }
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        // A revoke also aborts active HTTP streams via grantsChanged.
        if (!res.write(chunk)) await new Promise<void>(resolve => {
          const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
          res.once("drain", done); res.once("close", done);
          if (res.destroyed) done();
        });
      }
      res.end();
    } finally { clearTimeout(timer); controllers.delete(controller); }
  }
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const reject = (code: number) => socket.end(`HTTP/1.1 ${code} ${code === 401 ? "Unauthorized" : "Forbidden"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    void (async () => {
      const url = requestUrl(req);
      const id = sessions.cookieId(req.headers.cookie);
      if (url.pathname !== "/ws" || url.searchParams.has("token")) { reject(403); return; }
      const token = await sessions.resolve(id); if (!token) { reject(401); return; }
      wsServer.handleUpgrade(req, socket, head, guest => {
        const upstreamUrl = new URL("/ws", base); upstreamUrl.protocol = "ws:";
        const upstream = new WebSocket(upstreamUrl, { origin: base.origin, handshakeTimeout: 5000, maxPayload: 1024 * 1024 });
        const close = () => { guest.close(1008, "Session permissions changed"); upstream.terminate(); };
        sockets.add(close);
        let chain: Promise<unknown> = Promise.resolve();
        const relay = (raw: WebSocket.RawData, fromGuest: boolean) => {
          chain = chain.then(async () => {
            const current = await sessions.resolve(id); if (!current) { close(); return; }
            const decision = fromGuest ? filterClientFrame(raw.toString(), scope(current)) : filterServerFrame(raw.toString(), scope(current));
            const destination = fromGuest ? upstream : guest;
            if (decision.action === "forward" && destination.readyState === WebSocket.OPEN) destination.send(decision.frame);
            if (decision.action === "close") close();
          }).catch(close);
        };
        // Wait for the owner socket before accepting subscriptions from the app.
        guest.pause(); upstream.once("open", () => guest.resume());
        guest.on("message", data => relay(data, true)); upstream.on("message", data => relay(data, false));
        const timer = setInterval(() => { void sessions.resolve(id).then(t => { if (!t) close(); }).catch(close); }, 30_000); timer.unref();
        const cleanup = () => { clearInterval(timer); sockets.delete(close); };
        guest.on("close", () => { upstream.terminate(); cleanup(); }); upstream.on("close", () => { guest.close(1001, "Upstream disconnected"); cleanup(); });
        guest.on("error", close); upstream.on("error", close);
      });
    })().catch(() => reject(503));
  });
  return {
    async start(): Promise<string> {
      if (startedUrl) return startedUrl;
      await sessions.load();
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing gateway address");
      startedUrl = `http://127.0.0.1:${address.port}`; return startedUrl;
    },
    grantsChanged() { for (const close of sockets) close(); for (const controller of controllers) controller.abort(); },
    verifyReadiness(challenge: string, response: unknown): boolean {
      if (!response || typeof response !== "object") return false;
      const value = response as Record<string, unknown>;
      if (value.service !== "bb-shared-gateway" || value.version !== 1 || value.challenge !== challenge || typeof value.proof !== "string" || !/^[a-f0-9]{64}$/.test(value.proof)) return false;
      return timingSafeEqual(Buffer.from(proof(challenge)), Buffer.from(value.proof));
    },
    async stop(): Promise<void> {
      for (const close of sockets) close(); for (const guest of wsServer.clients) guest.terminate();
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      if (startedUrl) await new Promise<void>(resolve => server.close(() => resolve()));
      await sessions.settled(); startedUrl = undefined;
    },
  };
}
