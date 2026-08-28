// Live end-to-end temp-deploy verification (spike/cf-verification, TASK 1).
//
// Mirrors the plugin's real pipeline (plugin/worker-lifecycle/cf-deploy.ts +
// pow.ts): challenge -> solve PoW -> POST /previews -> scripts.update via the
// cloudflare SDK -> resolve *.workers.dev URL. NO Cloudflare login/credentials.
//
// Records the provisioning envelope SHAPE ONLY (apiToken/claimToken redacted to
// length), whether the worker serves, the real expiresAt TTL, and claim.url
// format. Prints a JSON report at the end.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import Cloudflare from "cloudflare";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const BUNDLE = "/tmp/bb-worker-bundle/worker.js";

// ---- PoW solver: byte-for-byte the plugin's pow.ts algorithm ----
function sha256(buf) {
  return createHash("sha256").update(buf).digest();
}
function iterate(from, rounds) {
  let cur = from;
  for (let i = 0; i < rounds; i++) cur = sha256(cur);
  return cur;
}
// AUTHORITATIVE algorithm, from wrangler packages/workers-auth/src/pow.ts:
// h0 = SHA256(seed) is checkpoint[0]; each of k segments adds g more hashes.
function solvePow(seed, k, g) {
  const checkpoints = new Array(k + 1);
  let h = sha256(seed);
  checkpoints[0] = h;
  for (let j = 0; j < k; j++) {
    h = iterate(h, g);
    checkpoints[j + 1] = h;
  }
  return Buffer.concat(checkpoints).toString("base64");
}

async function cfPost(path, body) {
  const res = await fetch(`${CF_API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`CF POST ${path} -> HTTP ${res.status}, non-JSON: ${text.slice(0, 300)}`);
  }
  if (!res.ok || json.success === false) {
    throw new Error(`CF POST ${path} -> HTTP ${res.status}: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.result;
}

const redact = (v) => (typeof v === "string" ? `<redacted len=${v.length}>` : v);

function shapeOf(obj, redactKeys = []) {
  // Recursively describe an object's shape: key -> type (redacting secrets).
  if (Array.isArray(obj)) return `array[${obj.length}]`;
  if (obj === null) return "null";
  if (typeof obj !== "object") return typeof obj;
  const out = {};
  for (const [k, val] of Object.entries(obj)) {
    if (redactKeys.includes(k)) out[k] = redact(val);
    else if (val && typeof val === "object") out[k] = shapeOf(val, redactKeys);
    else out[k] = `${typeof val}${typeof val === "string" ? ` len=${val.length}` : `=${val}`}`;
  }
  return out;
}

async function main() {
  const report = {};
  const t0 = Date.now();

  // 1. challenge
  const challenge = await cfPost("/provisioning/previews/challenge", {});
  report.challenge = {
    shape: shapeOf(challenge, ["challengeToken", "seed"]),
    k: challenge.k,
    g: challenge.g,
    s: challenge.s,
    kTimesG: challenge.k * challenge.g,
  };
  console.error(`[challenge] k=${challenge.k} g=${challenge.g} s=${challenge.s} k*g=${challenge.k * challenge.g}`);

  // 2. solve PoW (wrangler decodes seed as "base64url")
  const seed = Buffer.from(challenge.seed, "base64url");
  console.error(`[pow] seed decoded to ${seed.length} bytes; solving...`);
  const tPow = Date.now();
  const checkpoints = solvePow(seed, challenge.k, challenge.g);
  report.pow = { seedBytes: seed.length, solveMs: Date.now() - tPow };
  console.error(`[pow] solved in ${report.pow.solveMs}ms`);

  // 3. provision
  const provisioned = await cfPost("/provisioning/previews", {
    termsOfService: "https://www.cloudflare.com/terms/",
    privacyPolicy: "https://www.cloudflare.com/privacypolicy/",
    acceptTermsOfService: "yes",
    challengeToken: challenge.challengeToken,
    solution: { checkpoints },
  });
  report.provisionEnvelope = shapeOf(provisioned, ["apiToken", "token", "seed"]);
  console.error(`[provision] account id=${provisioned.account?.id}`);

  const account = provisioned.account;
  const claim = provisioned.claim;
  const apiToken = account.apiToken;
  const accountId = account.id;

  // TTLs
  const accountExpiresAt = account.expiresAt;
  const claimExpiresAt = claim?.expiresAt;
  report.ttl = {
    accountExpiresAt,
    accountTtlMinutes: accountExpiresAt ? (Date.parse(accountExpiresAt) - Date.now()) / 60000 : null,
    claimExpiresAt,
    claimTtlMinutes: claimExpiresAt ? (Date.parse(claimExpiresAt) - Date.now()) / 60000 : null,
  };
  // claim.url format (redact the token query value)
  if (claim?.url) {
    const u = new URL(claim.url);
    const params = {};
    for (const [key, val] of u.searchParams) params[key] = redact(val);
    report.claimUrl = { origin: u.origin, pathname: u.pathname, query: params };
  }

  // 4. upload via RAW multipart PUT (exactly what wrangler does). The cloudflare
  //    SDK v7 `new File(...)` path mis-transmits the module body (CF returns a
  //    syntax error at worker.js:1:4), so we build the multipart form ourselves.
  const scriptContent = await readFile(BUNDLE, "utf8");
  const scriptName = "bb-shared-worker";
  const metadata = {
    main_module: "worker.js",
    compatibility_date: "2025-06-01",
    bindings: [
      { type: "durable_object_namespace", name: "TUNNEL_DO", class_name: "TunnelDO" },
      { type: "secret_text", name: "TUNNEL_SECRET", text: "spike-tunnel-secret-value-000000000000000000" },
      { type: "secret_text", name: "AUTHZ_TOKEN", text: "spike-authz-token-value-00000000000000000000" },
    ],
    // Temp accounts are free-plan → DO must be SQLite-backed (code 10097 on new_classes).
    migrations: { new_tag: "v1", new_sqlite_classes: ["TunnelDO"] },
  };
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  form.set(
    "worker.js",
    new Blob([scriptContent], { type: "application/javascript+module" }),
    "worker.js",
  );
  const tUp = Date.now();
  const upRes = await fetch(
    `${CF_API_BASE}/accounts/${accountId}/workers/scripts/${scriptName}`,
    { method: "PUT", headers: { authorization: `Bearer ${apiToken}` }, body: form },
  );
  const upJson = await upRes.json();
  if (!upRes.ok || upJson.success === false) {
    throw new Error(`scripts PUT -> HTTP ${upRes.status}: ${JSON.stringify(upJson.errors ?? upJson)}`);
  }
  report.upload = { ms: Date.now() - tUp, deploymentId: upJson.result?.id ?? null };
  console.error(`[upload] done in ${report.upload.ms}ms, deploymentId=${upJson.result?.id}`);

  // account-level subdomain
  const subRes = await fetch(
    `${CF_API_BASE}/accounts/${accountId}/workers/subdomain`,
    { headers: { authorization: `Bearer ${apiToken}` } },
  );
  const subJson = await subRes.json();
  const subdomain = subJson.result?.subdomain;
  report.subdomainLookup = { status: subRes.status, subdomain };

  // ENABLE the per-script workers.dev route (the plugin's cf-deploy.ts omits this):
  // POST /accounts/{id}/workers/scripts/{name}/subdomain { enabled, previews_enabled }
  const enRes = await fetch(
    `${CF_API_BASE}/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, previews_enabled: false }),
    },
  );
  const enJson = await enRes.json();
  report.enableRoute = { status: enRes.status, ok: enRes.ok, result: enJson.result ?? enJson.errors };
  console.error(`[enable-route] HTTP ${enRes.status}: ${JSON.stringify(enJson.result ?? enJson.errors)}`);

  const url = `https://${scriptName}.${subdomain}.workers.dev`;
  report.url = url;
  report.subdomain = subdomain;
  console.error(`[url] ${url}`);

  // 5. curl the worker: does it serve? (retry a few times for propagation)
  let serveResult = null;
  for (let attempt = 1; attempt <= 8; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const res = await fetch(url, { redirect: "manual" });
      const body = await res.text();
      serveResult = {
        attempt,
        status: res.status,
        headers: {
          "content-type": res.headers.get("content-type"),
          server: res.headers.get("server"),
          location: res.headers.get("location"),
        },
        bodyLen: body.length,
        bodySnippet: body.slice(0, 200),
      };
      console.error(`[serve] attempt ${attempt}: HTTP ${res.status}, ${body.length} bytes`);
      if (res.status !== 404 && res.status !== 522 && res.status !== 523) break;
    } catch (err) {
      serveResult = { attempt, error: String(err) };
      console.error(`[serve] attempt ${attempt} error: ${err}`);
    }
  }
  report.serve = serveResult;
  report.totalMs = Date.now() - t0;

  console.log("\n===REPORT_JSON_BEGIN===");
  console.log(JSON.stringify(report, null, 2));
  console.log("===REPORT_JSON_END===");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
