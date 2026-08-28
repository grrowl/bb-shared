import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  sealSecret,
  openSecret,
  isSecretEnvelope,
  SecretEnvelopeError,
  SECRET_ENVELOPE_VERSION,
  SECRET_KEY_BYTES,
} from "./envelope";

const key = () => randomBytes(SECRET_KEY_BYTES);

describe("secret envelope", () => {
  it("round-trips a secret", () => {
    const k = key();
    const env = sealSecret(k, "cf-refresh-token-🔒");
    expect(openSecret(k, env)).toBe("cf-refresh-token-🔒");
  });

  it("round-trips an empty string", () => {
    const k = key();
    expect(openSecret(k, sealSecret(k, ""))).toBe("");
  });

  it("produces a versioned, self-describing envelope", () => {
    const env = sealSecret(key(), "x");
    expect(env.v).toBe(SECRET_ENVELOPE_VERSION);
    expect(env.alg).toBe("AES-256-GCM");
    expect(isSecretEnvelope(env)).toBe(true);
    // 12-byte nonce, 16-byte tag when base64-decoded.
    expect(Buffer.from(env.nonce, "base64").length).toBe(12);
    expect(Buffer.from(env.tag, "base64").length).toBe(16);
  });

  it("uses a fresh nonce per seal (no reuse)", () => {
    const k = key();
    const a = sealSecret(k, "same");
    const b = sealSecret(k, "same");
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ct).not.toBe(b.ct);
  });

  it("fails to open under the wrong key", () => {
    const env = sealSecret(key(), "secret");
    expect(() => openSecret(key(), env)).toThrow(SecretEnvelopeError);
  });

  it("detects tampering with the ciphertext", () => {
    const k = key();
    const env = sealSecret(k, "secret");
    const ct = Buffer.from(env.ct, "base64");
    ct[0] ^= 0xff;
    const tampered = { ...env, ct: ct.toString("base64") };
    expect(() => openSecret(k, tampered)).toThrow(SecretEnvelopeError);
  });

  it("detects tampering with the auth tag", () => {
    const k = key();
    const env = sealSecret(k, "secret");
    const tag = Buffer.from(env.tag, "base64");
    tag[0] ^= 0xff;
    expect(() => openSecret(k, { ...env, tag: tag.toString("base64") })).toThrow(
      SecretEnvelopeError,
    );
  });

  it("rejects a truncated auth tag (no downgraded forgery resistance)", () => {
    const k = key();
    const env = sealSecret(k, "secret");
    const short = Buffer.from(env.tag, "base64").subarray(0, 4);
    expect(() =>
      openSecret(k, { ...env, tag: short.toString("base64") }),
    ).toThrow(SecretEnvelopeError);
  });

  it("gates on the version/alg header", () => {
    const k = key();
    const env = sealSecret(k, "secret");
    expect(() => openSecret(k, { ...env, v: 2 as never })).toThrow(
      SecretEnvelopeError,
    );
    expect(() =>
      openSecret(k, { ...env, alg: "AES-128-GCM" as never }),
    ).toThrow(SecretEnvelopeError);
  });

  it("rejects a wrong-sized key", () => {
    expect(() => sealSecret(randomBytes(16), "x")).toThrow(SecretEnvelopeError);
    const env = sealSecret(key(), "x");
    expect(() => openSecret(randomBytes(31), env)).toThrow(SecretEnvelopeError);
  });

  it("isSecretEnvelope rejects plaintext and junk", () => {
    expect(isSecretEnvelope("plaintext")).toBe(false);
    expect(isSecretEnvelope(null)).toBe(false);
    expect(isSecretEnvelope({ v: 1 })).toBe(false);
    expect(isSecretEnvelope({ v: 1, alg: "AES-256-GCM", nonce: 1, ct: "", tag: "" })).toBe(
      false,
    );
  });
});
