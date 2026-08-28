import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  encryptRecord,
  decryptRecord,
} from "./record-crypto";
import { isSecretEnvelope, SecretEnvelopeError, SECRET_KEY_BYTES } from "./envelope";

const PATHS = ["apiToken", "tunnelSecret", "claim.url"] as const;
const key = () => randomBytes(SECRET_KEY_BYTES);

function sample() {
  return {
    url: "https://w.example",
    accountId: "acct-1",
    apiToken: "api-secret",
    tunnelSecret: "tunnel-secret",
    claim: { url: "https://claim/abc", expiresAt: 1 },
    generation: 3,
  };
}

describe("record-crypto", () => {
  it("encrypts only the secret fields, leaves metadata plaintext", () => {
    const rec = sample();
    const atRest = encryptRecord(rec, key(), PATHS) as Record<string, unknown>;
    expect(atRest.url).toBe("https://w.example");
    expect(atRest.accountId).toBe("acct-1");
    expect(atRest.generation).toBe(3);
    expect(isSecretEnvelope(atRest.apiToken)).toBe(true);
    expect(isSecretEnvelope(atRest.tunnelSecret)).toBe(true);
    expect(isSecretEnvelope((atRest.claim as Record<string, unknown>).url)).toBe(
      true,
    );
    // Nested non-secret sibling untouched.
    expect((atRest.claim as Record<string, unknown>).expiresAt).toBe(1);
  });

  it("round-trips through encrypt then decrypt", () => {
    const k = key();
    const rec = sample();
    const atRest = encryptRecord(rec, k, PATHS);
    const { record, migrated } = decryptRecord(atRest, k, PATHS);
    expect(record).toEqual(rec);
    expect(migrated).toBe(false);
  });

  it("does not mutate the input record", () => {
    const rec = sample();
    encryptRecord(rec, key(), PATHS);
    expect(rec.apiToken).toBe("api-secret");
  });

  it("skips a nullable nested secret (claim: null)", () => {
    const k = key();
    const rec = { ...sample(), claim: null };
    const atRest = encryptRecord(rec, k, PATHS) as Record<string, unknown>;
    expect(atRest.claim).toBeNull();
    const { record } = decryptRecord(atRest, k, PATHS);
    expect(record).toEqual(rec);
  });

  it("flags a legacy plaintext record as migrated", () => {
    const k = key();
    const legacy = sample(); // all secrets are plain strings
    const { record, migrated } = decryptRecord(legacy, k, PATHS);
    expect(migrated).toBe(true);
    expect(record).toEqual(legacy);
  });

  it("throws when a secret cannot be decrypted (wrong key)", () => {
    const atRest = encryptRecord(sample(), key(), PATHS);
    expect(() => decryptRecord(atRest, key(), PATHS)).toThrow(
      SecretEnvelopeError,
    );
  });
});
