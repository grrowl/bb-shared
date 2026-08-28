// Versioned secret envelope — AES-256-GCM over a single secret string (issue 29).
//
// WHY
//   The plugin persists a few bearer secrets in `bb.storage.kv` (today the
//   worker record's `tunnelSecret`/`apiToken`/`claim.url`; soon issue 28's
//   long-lived `cfRefreshToken`). v0 stored them as plaintext JSON inside the
//   local-trust boundary (SPEC §"Trust model"). This envelope lets the record
//   store encrypt each secret field with a device-tied key (see
//   `key-provider.ts`) so a copied `bb.db` / kv blob is useless off the machine
//   that minted the key.
//
// FORMAT
//   A JSON-serialisable object so it can live inline in the KV record next to
//   the plaintext metadata. The `v` + `alg` header make the primitive
//   rotatable: a future version can switch algorithms and `open` gates on the
//   pair it understands rather than silently mis-decrypting.
//
//     { v: 1, alg: "AES-256-GCM", nonce: b64(12B), ct: b64, tag: b64(16B) }
//
//   Nonce is a fresh 12 random bytes per `seal` (GCM's 96-bit IV sweet spot);
//   never reused for a given key. The 128-bit GCM tag authenticates the
//   ciphertext, so tamper (or a wrong key) fails `open` loudly rather than
//   returning garbage. No associated data — the envelope stands alone.
//
// No hand-rolled primitives: everything is `node:crypto` AES-256-GCM.
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

/** Current envelope version. Bump only alongside a new `alg`/layout. */
export const SECRET_ENVELOPE_VERSION = 1 as const;

/** The one algorithm v1 understands. */
export const SECRET_ENVELOPE_ALG = "AES-256-GCM" as const;

/** Required raw key length for AES-256 (bytes). */
export const SECRET_KEY_BYTES = 32;

/** GCM nonce/IV length (bytes) — the 96-bit recommended size. */
const NONCE_BYTES = 12;

/** Versioned, self-describing ciphertext envelope for one secret string. */
export interface SecretEnvelope {
  v: typeof SECRET_ENVELOPE_VERSION;
  alg: typeof SECRET_ENVELOPE_ALG;
  /** base64 12-byte random nonce. */
  nonce: string;
  /** base64 ciphertext. */
  ct: string;
  /** base64 128-bit GCM auth tag. */
  tag: string;
}

/** Thrown when an envelope cannot be opened (wrong key, tamper, bad version). */
export class SecretEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretEnvelopeError";
  }
}

function assertKey(key: Buffer): void {
  if (key.length !== SECRET_KEY_BYTES) {
    throw new SecretEnvelopeError(
      `device key must be ${SECRET_KEY_BYTES} bytes, got ${key.length}`,
    );
  }
}

/** Encrypt a plaintext secret string into a fresh, versioned envelope. */
export function sealSecret(key: Buffer, plaintext: string): SecretEnvelope {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    v: SECRET_ENVELOPE_VERSION,
    alg: SECRET_ENVELOPE_ALG,
    nonce: nonce.toString("base64"),
    ct: ct.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/**
 * Decrypt an envelope back to its plaintext. Throws `SecretEnvelopeError` on a
 * version/alg mismatch, a malformed envelope, or a failed GCM tag check (wrong
 * key / tampered blob / different machine). Callers treat a throw as "secret
 * unrecoverable" and degrade to a fresh bootstrap — never a crash.
 */
export function openSecret(key: Buffer, env: SecretEnvelope): string {
  assertKey(key);
  if (env.v !== SECRET_ENVELOPE_VERSION || env.alg !== SECRET_ENVELOPE_ALG) {
    throw new SecretEnvelopeError(
      `unsupported secret envelope ${String(env.v)}/${String(env.alg)}`,
    );
  }
  const nonce = Buffer.from(env.nonce, "base64");
  const ct = Buffer.from(env.ct, "base64");
  const tag = Buffer.from(env.tag, "base64");
  if (nonce.length !== NONCE_BYTES) {
    throw new SecretEnvelopeError("malformed secret envelope: bad nonce");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch (err) {
    // GCM `final()` throws when the tag does not verify: wrong key, wrong
    // machine, or tampering. Normalise to our error type.
    throw new SecretEnvelopeError(
      `secret envelope failed to decrypt: ${(err as Error).message}`,
    );
  }
}

/** Structural check that `x` is a v1 envelope (vs a legacy plaintext string). */
export function isSecretEnvelope(x: unknown): x is SecretEnvelope {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    e.v === SECRET_ENVELOPE_VERSION &&
    e.alg === SECRET_ENVELOPE_ALG &&
    typeof e.nonce === "string" &&
    typeof e.ct === "string" &&
    typeof e.tag === "string"
  );
}
