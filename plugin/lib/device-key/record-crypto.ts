// Field-level record encryption (issue 29).
//
// Encrypts a designated set of secret fields inside an otherwise-plaintext KV
// record, leaving the non-secret metadata readable as before (SPEC §"Trust
// model"; ticket 29 scope). Each secret field is replaced, at rest, with a
// `SecretEnvelope`; the record's non-secret fields are untouched, so the stored
// blob is still inspectable (url, scriptName, accountId, generation, …).
//
// Fields are addressed by dot-path (`"apiToken"`, `"claim.url"`) so a nested,
// nullable secret can be encrypted without a bespoke transform. A path that
// resolves to a missing/non-string value is skipped — this handles nullable
// parents (`claim: null`) and future records that omit a field.
//
// MIGRATION: a legacy plaintext record has plain strings where envelopes are
// expected. `decryptRecord` reports `migrated: true` when it sees one, so the
// store can re-save it encrypted and let the plaintext fall out of the kv.
import {
  sealSecret,
  openSecret,
  isSecretEnvelope,
  SecretEnvelopeError,
} from "./envelope";

/** A dot-path into a record object, e.g. `"claim.url"`. */
export type SecretFieldPath = string;

function getByPath(obj: unknown, path: SecretFieldPath): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function setByPath(obj: unknown, path: SecretFieldPath, value: unknown): void {
  const segs = path.split(".");
  let cur: unknown = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    if (typeof cur !== "object" || cur === null) return;
    cur = (cur as Record<string, unknown>)[segs[i]];
  }
  if (typeof cur !== "object" || cur === null) return;
  (cur as Record<string, unknown>)[segs[segs.length - 1]] = value;
}

/** Deep clone via structured JSON (records are plain JSON already). */
function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/**
 * Return an at-rest copy of `record` with each present string secret field
 * replaced by a `SecretEnvelope`. Non-string / missing fields are left as-is.
 */
export function encryptRecord<T>(
  record: T,
  key: Buffer,
  paths: readonly SecretFieldPath[],
): unknown {
  const out = clone(record) as unknown;
  for (const path of paths) {
    const value = getByPath(out, path);
    if (typeof value === "string") {
      setByPath(out, path, sealSecret(key, value));
    }
  }
  return out;
}

/** Outcome of decrypting an at-rest record. */
export interface DecryptRecordResult {
  /** The record with secret fields turned back into plaintext strings. */
  record: unknown;
  /**
   * True if any secret field was found as a plaintext string rather than an
   * envelope — i.e. this is a pre-encryption record and should be re-saved.
   */
  migrated: boolean;
}

/**
 * Reverse `encryptRecord`. Each secret path holding an envelope is decrypted
 * in place; a plaintext string there is left as-is and flags `migrated`.
 * Throws `SecretEnvelopeError` if an envelope cannot be opened (wrong key /
 * tamper / other machine) — the store treats that as a wiped, absent record.
 */
export function decryptRecord(
  atRest: unknown,
  key: Buffer,
  paths: readonly SecretFieldPath[],
): DecryptRecordResult {
  const out = clone(atRest);
  let migrated = false;
  for (const path of paths) {
    const value = getByPath(out, path);
    if (value === undefined || value === null) continue;
    if (isSecretEnvelope(value)) {
      setByPath(out, path, openSecret(key, value));
    } else if (typeof value === "string") {
      // Legacy plaintext secret from before issue 29 — leave it, mark migrate.
      migrated = true;
    } else {
      // Something that is neither an envelope nor a string: corrupt.
      throw new SecretEnvelopeError(
        `secret field "${path}" is neither an envelope nor a string`,
      );
    }
  }
  return { record: out, migrated };
}
