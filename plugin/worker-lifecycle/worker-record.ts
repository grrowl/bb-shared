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
import { z } from "zod";

/** KV key the worker record lives under. */
export const WORKER_RECORD_KEY = "worker-record";

export const workerRecordSchema = z.object({
  /** CF deployment/script identifier for this generation. */
  deploymentId: z.string(),
  /** Deployed worker URL, e.g. `https://bb-shared-worker.<sub>.workers.dev`. */
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

/**
 * KV-backed record store. `load` validates the stored blob and treats a
 * malformed record as absent (wiping it), so a schema change across versions
 * degrades to a fresh bootstrap rather than a crash.
 */
export function createWorkerRecordStore(kv: RecordKv): WorkerRecordStore {
  return {
    async load() {
      const raw = await kv.get<unknown>(WORKER_RECORD_KEY);
      if (raw === undefined || raw === null) return null;
      const parsed = workerRecordSchema.safeParse(raw);
      if (!parsed.success) {
        await kv.delete(WORKER_RECORD_KEY);
        return null;
      }
      return parsed.data;
    },
    async save(record) {
      await kv.set(WORKER_RECORD_KEY, record);
    },
    async clear() {
      await kv.delete(WORKER_RECORD_KEY);
    },
  };
}
