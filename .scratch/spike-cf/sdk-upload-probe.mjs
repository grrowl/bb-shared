// Probe: with cloudflare SDK v7.1.0, which upload primitive works against the
// live scripts.update endpoint? Tests the exact pattern in cf-deploy.ts
// (new File) vs the SDK's toFile() helper. One provision, both attempts.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import Cloudflare, { toFile } from "cloudflare";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const sha256 = (b) => createHash("sha256").update(b).digest();
function solve(seed, k, g) {
  const cps = new Array(k + 1);
  let h = sha256(seed);
  cps[0] = h;
  for (let j = 0; j < k; j++) { for (let i = 0; i < g; i++) h = sha256(h); cps[j + 1] = h; }
  return Buffer.concat(cps).toString("base64");
}
async function cfPost(path, body) {
  const r = await fetch(`${CF_API_BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const j = await r.json();
  if (!r.ok || j.success === false) throw new Error(`${path} ${r.status} ${JSON.stringify(j.errors)}`);
  return j.result;
}
const ch = await cfPost("/provisioning/previews/challenge", {});
const sol = solve(Buffer.from(ch.seed, "base64url"), ch.k, ch.g);
const prov = await cfPost("/provisioning/previews", {
  termsOfService: "https://www.cloudflare.com/terms/", privacyPolicy: "https://www.cloudflare.com/privacypolicy/",
  acceptTermsOfService: "yes", challengeToken: ch.challengeToken, solution: { checkpoints: sol },
});
const accountId = prov.account.id;
const client = new Cloudflare({ apiToken: prov.account.apiToken });
const src = await readFile("/tmp/bb-worker-bundle/worker.js", "utf8");
const metadata = {
  main_module: "worker.js", compatibility_date: "2025-06-01",
  bindings: [{ type: "durable_object_namespace", name: "TUNNEL_DO", class_name: "TunnelDO" }],
  migrations: { new_tag: "v1", new_sqlite_classes: ["TunnelDO"] },
};
async function attempt(label, fileArg) {
  try {
    const res = await client.workers.scripts.update("bb-shared-worker", { account_id: accountId, metadata, files: [fileArg] });
    console.log(`${label}: OK id=${res?.id}`);
  } catch (e) {
    console.log(`${label}: FAIL ${e?.status} ${JSON.stringify(e?.errors ?? String(e).slice(0,120))}`);
  }
}
// A: the exact cf-deploy.ts pattern
await attempt("new File()", new File([src], "worker.js", { type: "application/javascript+module" }));
// B: SDK's own toFile helper
await attempt("toFile()", await toFile(Buffer.from(src), "worker.js", { type: "application/javascript+module" }));
