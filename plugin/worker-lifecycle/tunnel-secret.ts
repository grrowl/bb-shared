// A per-deployment bearer authenticates the owner's local SharedTunnel to the
// Worker's `/__tunnel` WebSocket. It is generated with 256 bits of entropy,
// stored in the encrypted worker record, and installed in Cloudflare as a
// `secret_text` binding. Every recreated worker receives a new secret.
import { randomBytes } from "node:crypto";

/** Entropy of the tunnel handshake secret. */
export const TUNNEL_SECRET_BYTES = 32;

function base64url(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Mint a fresh tunnel handshake secret for one worker deployment. */
export function mintTunnelSecret(): string {
  return base64url(randomBytes(TUNNEL_SECRET_BYTES));
}
