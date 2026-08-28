// Live verification of the FIXED plugin deploy pipeline (ticket 30).
//
// Unlike live-deploy.mjs (standalone spike code), this driver imports the
// PLUGIN'S OWN modules — plugin/worker-lifecycle/cf-deploy.ts (which uses
// pow.ts) and tunnel-secret.ts — and runs a real anonymous Cloudflare temp
// deploy through them. It then confirms the worker serves over HTTPS and
// accepts a WebSocket upgrade into the Durable Object. No CF credentials.
//
// Run: npx tsx .scratch/spike-cf/plugin-live-deploy.ts
// Secrets (tunnelSecret, apiToken) are never printed — redacted to length.
import { readFile } from "node:fs/promises";
import { WebSocket } from "ws";
import { deployWorker } from "../../plugin/worker-lifecycle/cf-deploy";
import { bundleWorker } from "../../plugin/worker-lifecycle/worker-bundle";
import { mintTunnelSecret } from "../../plugin/worker-lifecycle/tunnel-secret";

const WORKER_DIR = "/Users/tom/repos/grrowl/bb-shared/worker";
const FALLBACK_BUNDLE = "/tmp/bb-worker-bundle/worker.js";

const redactLen = (v: string) => `<redacted len=${v.length}>`;

async function getBundle(): Promise<string> {
  try {
    const src = await bundleWorker({ workerDir: WORKER_DIR, log: { warn: (m) => console.error(`[bundle] ${m}`) } });
    console.error(`[bundle] built via plugin bundleWorker (${src.length} bytes)`);
    return src;
  } catch (err) {
    console.error(`[bundle] bundleWorker failed (${err}); falling back to ${FALLBACK_BUNDLE}`);
    return readFile(FALLBACK_BUNDLE, "utf8");
  }
}

function wsProbe(
  wsUrl: string,
  bearer: string,
): Promise<{ opened: boolean; status?: number; accept?: string | null; error?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${bearer}` } });
    const finish = (r: { opened: boolean; status?: number; accept?: string | null; error?: string }) => {
      try {
        ws.terminate();
      } catch {}
      resolve(r);
    };
    ws.on("open", () => finish({ opened: true, status: 101 }));
    ws.on("upgrade", (res) => {
      // captured on success; Sec-WebSocket-Accept proves a real 101 handshake
      if (res.statusCode === 101) {
        /* open handler resolves */
      }
    });
    ws.on("unexpected-response", (_req, res) =>
      finish({ opened: false, status: res.statusCode }),
    );
    ws.on("error", (err) => finish({ opened: false, error: String(err) }));
    setTimeout(() => finish({ opened: false, error: "timeout" }), 20_000);
  });
}

async function main() {
  const report: Record<string, unknown> = {};
  const t0 = Date.now();

  const scriptContent = await getBundle();
  const tunnelSecret = mintTunnelSecret();
  const authzToken = "bbsh_" + "L".repeat(40); // dummy; authz not exercised here

  console.error("[deploy] running plugin deployWorker() against live Cloudflare...");
  const result = await deployWorker(
    {
      scriptName: "bb-shared-worker",
      compatibilityDate: "2025-06-01",
      scriptContent,
      tunnelSecret,
      authzToken,
      doClassName: "TunnelDO",
      doBindingName: "TUNNEL_DO",
      migrationTag: "v1",
    },
    { log: { info: (m) => console.error(`[deploy] ${m}`), warn: (m) => console.error(`[deploy:warn] ${m}`) } },
  );

  report.deploy = {
    url: result.url,
    deploymentId: result.deploymentId,
    accountId: result.accountId,
    apiToken: redactLen(result.apiToken),
    tunnelSecret: redactLen(tunnelSecret),
    expiresAt: result.expiresAt,
    accountTtlMinutes: result.expiresAt ? (result.expiresAt - Date.now()) / 60000 : null,
    claim: { url: redactLen(result.claim.url), expiresAt: result.claim.expiresAt },
  };
  console.error(`[deploy] live at ${result.url}`);

  // 1. HTTPS GET / — the worker's own token gate should answer 401 token_missing.
  const httpRes = await fetch(result.url, { redirect: "manual" });
  const httpBody = await httpRes.text();
  report.httpGet = {
    status: httpRes.status,
    contentType: httpRes.headers.get("content-type"),
    server: httpRes.headers.get("server"),
    bodySnippet: httpBody.slice(0, 200),
  };
  console.error(`[https] GET / -> ${httpRes.status} ${httpBody.slice(0, 120)}`);

  const host = new URL(result.url).host;
  const wsUrl = `wss://${host}/__tunnel`;

  // 2a. /__tunnel with NO upgrade header -> 426 (from inside TunnelDO.acceptTunnel).
  const noUpgrade = await fetch(`${result.url}/__tunnel`, { redirect: "manual" });
  const noUpgradeBody = await noUpgrade.text();
  report.tunnelNoUpgrade = { status: noUpgrade.status, bodySnippet: noUpgradeBody.slice(0, 120) };
  console.error(`[tunnel] no-upgrade -> ${noUpgrade.status} ${noUpgradeBody.trim()}`);

  // 2b. WS upgrade with a WRONG bearer -> 401 invalid credential.
  const wrong = await wsProbe(wsUrl, "wrong-" + "x".repeat(40));
  report.tunnelWrongBearer = wrong;
  console.error(`[tunnel] wrong-bearer WS -> ${JSON.stringify(wrong)}`);

  // 2c. WS upgrade with the CORRECT bearer -> 101 Switching Protocols (DO built
  //     a WebSocketPair and accepted the hibernatable socket).
  const right = await wsProbe(wsUrl, tunnelSecret);
  report.tunnelCorrectBearer = right;
  console.error(`[tunnel] correct-bearer WS -> ${JSON.stringify(right)}`);

  report.totalMs = Date.now() - t0;

  console.log("\n===PLUGIN_LIVE_REPORT_BEGIN===");
  console.log(JSON.stringify(report, null, 2));
  console.log("===PLUGIN_LIVE_REPORT_END===");

  const ok =
    httpRes.status === 401 &&
    noUpgrade.status === 426 &&
    wrong.status === 401 &&
    right.opened === true;
  console.error(ok ? "\n[RESULT] PASS — HTTPS + WebSocket upgrade verified live" : "\n[RESULT] FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
