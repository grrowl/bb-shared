// Tunnel handshake secret — bb-shared mints its own (issue 07).
//
// ===========================================================================
// DESIGN + THREAT MODEL  (adversarial review pass required — SPEC open Q #5)
// ===========================================================================
//
// WHAT IT IS
//   A per-deployment bearer that authenticates the owner's local `SharedTunnel`
//   (issue 14) to our Cloudflare worker's `/__tunnel` WebSocket upgrade. It is
//   the ENTIRE handshake: the WS upgrade carries `Authorization: Bearer
//   <secret>` and there is no back-channel (mirrors bb connect — see
//   `research/tunnel-client.md` §"Auth handshake shape").
//
// HOW IT IS MINTED
//   32 bytes from `crypto.randomBytes` (CSPRNG), base64url-encoded. 256 bits of
//   entropy → brute force is not a threat. We deliberately do NOT reuse bb
//   connect's `bbcm_` credential mechanism: that store is owned by a plugin we
//   do not control and reusing it would stomp the user's real pairing
//   (`research/tunnel-client.md` §"Coexistence").
//
// HOW IT IS PLANTED / COMPARED
//   Deploy plants the raw secret as the worker's `TUNNEL_SECRET`
//   *secret-text* binding (not plain-text — see cf-deploy.ts) and hands the
//   same raw value to `SharedTunnel`. The worker compares in constant time
//   (`worker/src/tunnel/tunnel-do.ts` `timingSafeEqual`). We keep the raw value
//   both sides because the tunnel client must PRESENT it; there is no
//   hash-only side. It is persisted (with the CF apiToken) in the plugin's
//   local durable KV so a plugin restart can re-attach to a still-healthy
//   worker without redeploying.
//
// ROTATION
//   Minted fresh on EVERY deploy and every redeploy. A redeploy provisions a
//   brand-new CF temp account (we never re-key a live account), so the new
//   worker only ever knows the new secret; the old worker + its secret die
//   with the old temp account (≤60-min unclaimed TTL, or on health-driven
//   wipe). This bounds the blast radius of any single leaked secret to one
//   deployment generation.
//
// THREAT MODEL (the four the ticket calls out)
//   1. WORKER IMPERSONATION (attacker stands up a look-alike worker; the
//      tunnel client dials it). Mitigation: the tunnel client only ever dials
//      the exact `workerUrl` returned by OUR deploy call and held in memory /
//      our own KV — never a URL supplied by a guest or the worker. An attacker
//      cannot make us dial their host without first compromising the plugin's
//      KV or the deploy response. The secret is an owner→worker proof, not a
//      worker→owner proof; a rogue worker that lacks the secret simply 401s the
//      dial (fail-closed), and one that somehow HAS the secret already owns the
//      account. Residual gap (L3, accepted for v0): we do not pin the worker's
//      TLS cert / identity beyond the `*.workers.dev` origin CF assigns us. An
//      attacker with control of CF's `*.workers.dev` subdomain assignment (i.e.
//      CF account control) could MITM. This is considered inside the CF-trust
//      boundary. v1 could add pinning by capturing the initial TLS certificate
//      fingerprint on first handshake and rejecting drift.
//   2. SECRET LEAK FROM DEPLOY LOGS / ENV INSPECTION. Mitigations: uploaded as
//      a `secret_text` binding (CF stores it encrypted, omits it from script
//      GETs) rather than plain-text; never written to `bb.log`; never included
//      in `getWorkerStatus`; never placed in a URL or query string. Residual
//      (M5): it lives in plugin KV (bb.db) in plaintext, readable by anyone
//      with local disk access — acceptable under v0's local-trust model. But
//      note the tunnel secret is NOT the crown-jewel item at rest: the CF
//      `apiToken` persisted alongside it is. An attacker with the apiToken can
//      redeploy a MALICIOUS worker under our own account name (one that logs
//      the tunnel secret and exfiltrates guest traffic), making this secret's
//      careful rotation moot — so any at-rest protection must cover `apiToken`
//      first. See SPEC.md §"Trust model".
//   3. REPLAY ACROSS REDEPLOYS. Rotation (above) means a secret captured from
//      generation N cannot dial generation N+1's worker: different account,
//      different secret. There is no long-lived secret to replay.
//   4. CROSS-OWNER SECRET REUSE (a deploy misrouted to the wrong owner's
//      worker). Each secret is generated independently per deploy and never
//      shared between owners or deployments; there is no global/shared secret.
//      A misrouted deploy would plant a fresh secret on the wrong worker and
//      the mismatched tunnel would 401 — fail-closed, no cross-owner access.
//
// NOT DEFENDED (documented, out of scope for v0 — see SPEC.md §"Trust model")
//   - Local-disk compromise (KV plaintext) — see (2) residual. The crown-jewel
//     at-rest item is the CF `apiToken`, not this tunnel secret: whoever reads
//     the KV can redeploy a malicious worker under our account and the tunnel
//     secret's rotation becomes irrelevant. A malicious co-installed bb plugin
//     with local disk access is inside this same boundary — installing an
//     untrusted plugin is equivalent to handing over the CF account.
//   - No TLS-identity pinning beyond `*.workers.dev` — see (1) L3 residual.
//   - A compromised CF temp account whose apiToken is stolen mid-life — the
//     attacker could redeploy; bounded by the 60-min TTL and detected on the
//     next health check (which re-bootstraps fresh).
//   - Stale prior-generation worker (L4). On redeploy the new worker gets a
//     fresh account + secret; the old worker runs on its old secret until CF
//     reclaims its unclaimed temp account (≤60 min). The prior-gen worker has
//     no live tunnel to bb (the secret is rotated bb-side on redeploy), so the
//     residual reduces to: guest URLs against the old worker return 5xx until
//     CF cleans it up (≤60 min unclaimed). Guest URLs also change on redeploy,
//     so the window is narrow and self-closing.
// ===========================================================================
import { randomBytes } from "node:crypto";

/** Entropy of the tunnel handshake secret. 256 bits — brute force is a non-threat. */
export const TUNNEL_SECRET_BYTES = 32;

function base64url(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Mint a fresh tunnel handshake secret. Call once per (re)deploy. */
export function mintTunnelSecret(): string {
  return base64url(randomBytes(TUNNEL_SECRET_BYTES));
}
