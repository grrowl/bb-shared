// Persisted worker state (issue 07) — the ONE narrow exception to v0's
// "no persistence" stance (SPEC §"Worker lifecycle"). Tokens stay in-memory;
// only the worker deployment record survives a plugin restart, so a
// still-healthy worker can be re-attached without a redeploy.
//
// Stored in bb's per-plugin durable KV (`bb.storage.kv`) — namespaced to this
// plugin, backed by bb.db. The SPEC calls this "PluginSettings"; `bb.storage.kv`
// is the concrete durable-storage surface the SDK exposes for it.
//
// SECRETS: `apiToken` (CF temp-account bearer), `tunnelSecret` (our handshake
// secret), and `claim.url` (owner-only claim bearer) all live in this record.
// They are persisted locally only, never logged, and never returned to the
// frontend or guests (see getWorkerStatus, which projects a redacted subset).
//
// AT REST (issue 29): when a `KeyProvider` is supplied, these SECRET fields are
// encrypted with a device-tied key before they touch `bb.storage.kv`
// (AES-256-GCM per field, see `../lib/device-key`). The non-secret metadata
// stays plaintext and readable. A record that fails to decrypt (missing key,
// other machine, tamper) is wiped and treated as absent — the same degrade-to-
// fresh-bootstrap path as a malformed blob. Without a KeyProvider the store
// falls back to the legacy plaintext behaviour (used by unit tests that do not
// exercise encryption).
import { z } from "zod";
import {
  decryptRecord,
  encryptRecord,
  SecretEnvelopeError,
  type KeyProvider,
  type SecretFieldPath,
} from "../lib/device-key";

/** KV key the worker record lives under. */
export const WORKER_RECORD_KEY = "worker-record";

/**
 * Secret fields (dot-paths) encrypted at rest by issue 29. Everything else in
 * the record is non-secret metadata and stays plaintext. `claim.url` is nested
 * and nullable; the crypto layer skips it when `claim` is null.
 */
export const WORKER_RECORD_SECRET_FIELDS: readonly SecretFieldPath[] = [
  "apiToken",
  "tunnelSecret",
  "claim.url",
];

export const workerRecordSchema = z.object({
  /** CF deployment/script identifier for this generation. */
  deploymentId: z.string(),
  /** Deployed worker URL, e.g. `https://bb-shared.<sub>.workers.dev`. */
  url: z.string(),
  /** CF temp account id (needed for SDK calls against this account). */
  accountId: z.string(),
  /** CF temp-account bearer. SECRET. */
  apiToken: z.string(),
  /** Account self-destruct time (ms epoch) or null if CF omitted it. */
  expiresAt: z.number().nullable(),
  /** Handshake bearer for the local SharedTunnel dial. SECRET. */
  tunnelSecret: z.string(),
  /** Owner-only CF claim affordance. `url` is a bearer — never to guests/logs. */
  claim: z
    .object({ url: z.string(), expiresAt: z.number().nullable() })
    .nullable(),
  /** When this record was written (ms epoch). */
  deployedAt: z.number(),
  /** Monotonic deploy generation; bumped on every (re)deploy. */
  generation: z.number(),
});

export type WorkerRecord = z.infer<typeof workerRecordSchema>;

/** Minimal structural subset of `bb.storage.kv` we depend on (testable). */
export interface RecordKv {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface WorkerRecordStore {
  load(): Promise<WorkerRecord | null>;
  save(record: WorkerRecord): Promise<void>;
  clear(): Promise<void>;
}

/** Options for {@link createWorkerRecordStore}. */
export interface WorkerRecordStoreOptions {
  /**
   * Device-tied key source (issue 29). When present, secret fields are
   * encrypted on save and decrypted on load; a legacy plaintext record is
   * transparently re-saved encrypted on first load. When absent, the store
   * reads/writes plaintext (legacy behaviour).
   */
  keyProvider?: KeyProvider;
  /** Optional logger for at-rest diagnostics (never logs secret material). */
  log?: {
    warn?(msg: string, meta?: unknown): void;
    info?(msg: string, meta?: unknown): void;
  };
}

/**
 * KV-backed record store. `load` validates the stored blob and treats a
 * malformed record — or one whose secret fields cannot be decrypted (issue 29:
 * missing key, other machine, tamper) — as absent, wiping it, so it degrades to
 * a fresh bootstrap rather than a crash.
 *
 * When a `keyProvider` is supplied, the SECRET fields
 * ({@link WORKER_RECORD_SECRET_FIELDS}) are encrypted at rest with a device-tied
 * key; non-secret metadata stays plaintext. A pre-encryption plaintext record
 * is read once and re-saved encrypted (migration), after which the plaintext is
 * gone from the kv.
 */
export function createWorkerRecordStore(
  kv: RecordKv,
  options: WorkerRecordStoreOptions = {},
): WorkerRecordStore {
  const { keyProvider, log } = options;

  return {
    async load() {
      const raw = await kv.get<unknown>(WORKER_RECORD_KEY);
      if (raw === undefined || raw === null) return null;

      let candidate: unknown = raw;
      let migrated = false;
      if (keyProvider) {
        try {
          const key = await keyProvider.getKey();
          const dec = decryptRecord(raw, key, WORKER_RECORD_SECRET_FIELDS);
          candidate = dec.record;
          migrated = dec.migrated;
        } catch (err) {
          // Undecryptable secret: wrong key / other machine / tamper. Wipe and
          // degrade to fresh bootstrap — never crash (issue 29).
          if (err instanceof SecretEnvelopeError) {
            log?.warn?.(
              "bb-shared: worker record could not be decrypted; wiping and re-bootstrapping",
            );
            await kv.delete(WORKER_RECORD_KEY);
            return null;
          }
          throw err; // a key-provider outage is not a corrupt-record signal
        }
      }

      const parsed = workerRecordSchema.safeParse(candidate);
      if (!parsed.success) {
        await kv.delete(WORKER_RECORD_KEY);
        return null;
      }

      // Legacy plaintext record with a key available: re-save encrypted so the
      // plaintext falls out of the kv.
      if (keyProvider && migrated) {
        log?.info?.(
          "bb-shared: migrating plaintext worker record to encrypted at-rest storage",
        );
        await this.save(parsed.data);
      }
      return parsed.data;
    },
    async save(record) {
      if (keyProvider) {
        const key = await keyProvider.getKey();
        const atRest = encryptRecord(
          record,
          key,
          WORKER_RECORD_SECRET_FIELDS,
        );
        await kv.set(WORKER_RECORD_KEY, atRest);
        return;
      }
      await kv.set(WORKER_RECORD_KEY, record);
    },
    async clear() {
      await kv.delete(WORKER_RECORD_KEY);
    },
  };
}
