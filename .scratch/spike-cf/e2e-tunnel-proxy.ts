// Live end-to-end verification of the CF-side tunnel proxy (ticket 27).
//
// Proves a guest request round-trips through a REAL anonymous Cloudflare temp
// deploy: guest HTTP request -> worker pipeline -> TunnelDO relay -> tunnel WS
// -> local SharedTunnel -> stub bb HTTP server -> response back. Also proves a
// WebSocket passthrough over the same tunnel. No CF account, no running bb — a
// local stub HTTP+WS server stands in for bb (it answers the worker's /authz
// probe "allow", then serves the guest request).
//
// Run: npx tsx .scratch/spike-cf/e2e-tunnel-proxy.ts
// Secrets (tunnelSecret, apiToken, CF claim url) are never printed.
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { deployWorker } from "../../plugin/worker-lifecycle/cf-deploy";
import { bundleWorker } from "../../plugin/worker-lifecycle/worker-bundle";
import { mintTunnelSecret } from "../../plugin/worker-lifecycle/tunnel-secret";
import { SharedTunnel } from "../../plugin/lib/shared-tunnel";

const WORKER_DIR = "/Users/tom/repos/grrowl/bb-shared/worker";
const TOKEN = "bbsh_" + "e2e0".repeat(10); // 40 base64url chars -> valid token
const STUB_HTTP_BODY = "HELLO-FROM-STUB-BB";

const STEP_LOG = "/tmp/e2e-steps.log";
const log = (m: string) => {
  try {
    appendFileSync(STEP_LOG, m + "\n");
  } catch {
    /* ignore */
  }
  console.error(m);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

process.on("exit", (code) => {
  try {
    appendFileSync(STEP_LOG, `[hook] exit code=${code}\n`);
  } catch {
    /* ignore */
  }
});
process.on("beforeExit", (code) => {
  try {
    appendFileSync(STEP_LOG, `[hook] beforeExit code=${code} (loop drained)\n`);
  } catch {
    /* ignore */
  }
});
process.on("unhandledRejection", (r) => {
  appendFileSync(STEP_LOG, `[hook] unhandledRejection: ${String(r)}\n`);
});
process.on("uncaughtException", (e) => {
  appendFileSync(STEP_LOG, `[hook] uncaughtException: ${String(e)}\n`);
});
// Keep the loop alive so a stray loop-drain can't exit us mid-deploy.
const keepAlive = setInterval(() => {}, 1000);

interface StubHit {
  method: string;
  url: string;
  origin: string | undefined;
}

// ---------------------------------------------------------------------------
// Stub bb server: answers the worker's /authz probe, serves guest requests,
// and echoes WebSocket messages. Records every request it saw over the tunnel.
// ---------------------------------------------------------------------------
function startStubBb(): Promise<{
  port: number;
  hits: StubHit[];
  close: () => void;
}> {
  const hits: StubHit[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    hits.push({
      method: req.method ?? "?",
      url,
      origin: req.headers.origin,
    });
    if (url.startsWith("/api/v1/plugins/shared/http/authz")) {
      // Allow everything, scoping the token to one synthetic thread/project.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          allowed: true,
          thread_scope: ["thread-e2e"],
          project_scope: ["project-e2e"],
          perms: [{ thread_id: "thread-e2e", mode: "read" }],
        }),
      );
      return;
    }
    // The guest request itself. Echo a marker body + a custom header so we can
    // prove headers and body both survive the relay round-trip.
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "x-stub-bb": "1",
    });
    res.end(`${STUB_HTTP_BODY} ${req.method} ${url}`);
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    hits.push({ method: "WS", url: req.url ?? "", origin: req.headers.origin });
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      // Echo with a prefix so the round-trip is unambiguous.
      ws.send(
        isBinary ? data : `echo:${data.toString()}`,
      );
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        hits,
        close: () => {
          wss.close();
          server.close();
        },
      });
    });
  });
}

function waitConnected(tunnel: SharedTunnel, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (tunnel.getStatus().state === "connected") return resolve();
      if (Date.now() - started > timeoutMs)
        return reject(new Error("tunnel did not connect in time"));
      setTimeout(tick, 250);
    };
    tick();
  });
}

function wsRoundTrip(
  wsUrl: string,
  timeoutMs: number,
): Promise<{ ok: boolean; reply?: string; error?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const done = (r: { ok: boolean; reply?: string; error?: string }) => {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, error: "timeout" }), timeoutMs);
    ws.on("open", () => ws.send("ping-over-tunnel"));
    ws.on("message", (data: Buffer) => {
      clearTimeout(timer);
      done({ ok: true, reply: data.toString() });
    });
    ws.on("unexpected-response", (_req, res) =>
      done({ ok: false, error: `unexpected-response HTTP ${res.statusCode}` }),
    );
    ws.on("error", (err) => {
      clearTimeout(timer);
      done({ ok: false, error: String(err) });
    });
  });
}

async function main() {
  const report: Record<string, unknown> = {};

  // 1. Bundle + deploy the worker anonymously (real CF temp account).
  const scriptContent = await bundleWorker({
    workerDir: WORKER_DIR,
    log: { warn: (m) => log(`[bundle] ${m}`) },
  });
  log(`[bundle] ${scriptContent.length} bytes`);
  const tunnelSecret = mintTunnelSecret();
  const authzToken = "bbsh_" + "Z".repeat(40);

  log("[deploy] deploying via plugin deployWorker() against live Cloudflare...");
  const deployed = await deployWorker(
    {
      scriptName: "bb-shared-e2e",
      compatibilityDate: "2025-06-01",
      scriptContent,
      tunnelSecret,
      authzToken,
      doClassName: "TunnelDO",
      doBindingName: "TUNNEL_DO",
      migrationTag: "v1",
    },
    { log: { info: (m) => log(`[deploy] ${m}`), warn: (m) => log(`[deploy:warn] ${m}`) } },
  );
  report.workerUrl = deployed.url;
  log(`[deploy] live at ${deployed.url}`);
  log("[step] deploy returned");

  // 2. Stub bb + local SharedTunnel dialing the worker.
  const stub = await startStubBb();
  const loopbackBaseUrl = `http://127.0.0.1:${stub.port}`;
  log(`[stub] bb stub on ${loopbackBaseUrl}`);

  const tunnel = new SharedTunnel({
    workerUrl: deployed.url,
    tunnelSecret,
    loopbackBaseUrl,
    log: {
      info: (m) => log(`[tunnel] ${m}`),
      warn: (m) => log(`[tunnel:warn] ${m}`),
    },
  });
  tunnel.start();
  await waitConnected(tunnel, 30_000);
  report.tunnelState = tunnel.getStatus().state;
  log(`[tunnel] ${tunnel.getStatus().state}`);

  // 3. HTTP round-trip: guest -> worker -> tunnel -> stub -> back.
  const guestUrl = `${deployed.url}/${TOKEN}/api/v1/e2e-probe`;
  const httpRes = await fetch(guestUrl, { redirect: "manual" });
  const httpBody = await httpRes.text();
  report.http = {
    status: httpRes.status,
    xStubBb: httpRes.headers.get("x-stub-bb"),
    body: httpBody,
    bodyMatched: httpBody.startsWith(STUB_HTTP_BODY),
    sawAuthzProbe: stub.hits.some((h) => h.url.includes("/authz")),
    sawGuestReq: stub.hits.some((h) => h.url === "/api/v1/e2e-probe"),
  };

  // 4. WS passthrough: guest ws -> worker -> tunnel -> stub ws -> echo back.
  const wsUrl =
    deployed.url.replace(/^http/, "ws") + `/${TOKEN}/api/v1/e2e-ws`;
  const wsResult = await wsRoundTrip(wsUrl, 15_000);
  report.ws = {
    ...wsResult,
    replyMatched: wsResult.reply === "echo:ping-over-tunnel",
  };

  // 5. Redacted view of what the stub saw over the tunnel.
  report.stubHits = stub.hits.map((h) => ({
    method: h.method,
    url: h.url.replace(/token=[^&]+/, "token=[redacted]"),
    origin: h.origin,
  }));

  tunnel.stop();
  stub.close();

  const httpOk =
    httpRes.status === 200 &&
    httpBody.startsWith(STUB_HTTP_BODY) &&
    httpRes.headers.get("x-stub-bb") === "1";
  const wsOk = wsResult.reply === "echo:ping-over-tunnel";
  report.result = { httpOk, wsOk };

  // Write evidence synchronously — process.exit() can drop buffered stdout.
  const json = JSON.stringify(report, null, 2);
  writeFileSync("/tmp/e2e-report.json", json + "\n");
  console.log(json);
  log(`\nRESULT: http=${httpOk ? "PASS" : "FAIL"} ws=${wsOk ? "PASS" : "FAIL"}`);
  await sleep(500);
  process.exit(httpOk && wsOk ? 0 : 1);
}

main().catch((err) => {
  log(`FATAL: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
