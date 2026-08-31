import { z } from "zod";
import { decryptRecord, encryptRecord, SecretEnvelopeError, type KeyProvider, type SecretFieldPath } from "../lib/device-key";

/** The only durable lifecycle record. It intentionally contains no CF API credential. */
export const WORKER_RECORD_KEY = "worker-record";
/** Legacy OAuth state, read exactly once during migration. */
export const OAUTH_RECORD_KEY = "oauth-worker-record";
export const WORKER_RECORD_SECRET_FIELDS: readonly SecretFieldPath[] = ["url", "tunnelSecret", "claim.url"];

const workerUrl = z.string().refine(isExpectedWorkerUrl, "expected bb-shared workers.dev origin");
const tunnelSecret = z.string().regex(/^[A-Za-z0-9_-]{32,}$/, "expected a base64url tunnel secret");
const claimUrl = z.string().refine(isClaimUrl, "expected Cloudflare claim URL");

export const workerRecordSchema = z.object({
  deploymentId: z.string(), url: workerUrl, tunnelSecret,
  claim: z.object({ url: claimUrl, expiresAt: z.number().nullable() }).nullable(),
  deployedAt: z.number(), generation: z.number(),
}).strict();
export type WorkerRecord = z.infer<typeof workerRecordSchema>;

export interface RecordKv { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void>; }
export interface WorkerRecordStore {
  load(): Promise<WorkerRecord | null>;
  /** True for a malformed, unreadable, or legacy record which must not be replaced automatically. */
  requiresRecovery(): Promise<boolean>;
  save(record: WorkerRecord): Promise<void>;
  clear(): Promise<void>;
}
export interface WorkerRecordStoreOptions { keyProvider?: KeyProvider; log?: { warn?(msg: string, meta?: unknown): void; info?(msg: string, meta?: unknown): void }; }

/** A workers.dev origin which can safely receive the tunnel bearer. */
export function isExpectedWorkerUrl(value: string): boolean {
  try {
    const u = new URL(value); const labels = u.hostname.toLowerCase().split(".");
    return u.protocol === "https:" && !u.username && !u.password && !u.port && u.pathname === "/" && !u.search && !u.hash && labels[0] === "bb-shared" && labels.length >= 4 && labels.slice(-2).join(".") === "workers.dev";
  } catch { return false; }
}
/** CF claim links are bearer URLs, so accept only the documented dashboard shape. */
export function isClaimUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && u.hostname === "dash.cloudflare.com" && u.pathname === "/claim-preview" && u.searchParams.has("claimToken") && !u.hash;
  } catch { return false; }
}
function legacyToRecord(value: unknown): WorkerRecord | null {
  if (!value || typeof value !== "object") return null;
  const legacy = value as Record<string, unknown>;
  const parsed = workerRecordSchema.safeParse({
    deploymentId: typeof legacy.deploymentId === "string" ? legacy.deploymentId : "legacy-oauth",
    url: legacy.lastKnownUrl, tunnelSecret: legacy.tunnelSecret, claim: null,
    deployedAt: typeof legacy.deployedAt === "number" ? legacy.deployedAt : Date.now(),
    generation: typeof legacy.generation === "number" ? legacy.generation : 0,
  });
  return parsed.success ? parsed.data : null;
}

export function createWorkerRecordStore(kv: RecordKv, options: WorkerRecordStoreOptions = {}): WorkerRecordStore {
  const { keyProvider, log } = options; let recoveryRequired = false;
  const encode = async (record: WorkerRecord) => keyProvider ? encryptRecord(record, await keyProvider.getKey(), WORKER_RECORD_SECRET_FIELDS) : record;
  const decode = async (raw: unknown): Promise<{ record: WorkerRecord | null; migrated: boolean }> => {
    let value = raw; let migrated = false;
    if (keyProvider) try {
      const dec = decryptRecord(raw, await keyProvider.getKey(), WORKER_RECORD_SECRET_FIELDS); value = dec.record; migrated = dec.migrated;
    } catch (err) {
      if (err instanceof SecretEnvelopeError) { recoveryRequired = true; log?.warn?.("bb-shared: preserving unreadable worker record; manual recovery is required"); return { record: null, migrated: false }; }
      throw err;
    }
    // v0 records included temporary account credentials. Strip them during the
    // one-way migration before validation and re-save below, physically
    // removing encrypted apiToken bytes from durable storage.
    if (value && typeof value === "object" && ("apiToken" in value || "accountId" in value || "expiresAt" in value)) {
      const old = value as Record<string, unknown>;
      value = { deploymentId: old.deploymentId, url: old.url, tunnelSecret: old.tunnelSecret, claim: old.claim, deployedAt: old.deployedAt, generation: old.generation };
      migrated = true;
    }
    const parsed = workerRecordSchema.safeParse(value);
    if (!parsed.success) { recoveryRequired = true; log?.warn?.("bb-shared: preserving malformed worker record; manual recovery is required"); return { record: null, migrated: false }; }
    return { record: parsed.data, migrated };
  };
  return {
    async load() {
      recoveryRequired = false;
      const raw = await kv.get<unknown>(WORKER_RECORD_KEY);
      if (raw !== undefined && raw !== null) {
        const decoded = await decode(raw); if (decoded.record && decoded.migrated) await this.save(decoded.record); return decoded.record;
      }
      let legacy = await kv.get<unknown>(OAUTH_RECORD_KEY);
      if (legacy === undefined || legacy === null) return null;
      // The removed OAuth record encrypted tunnelSecret but left lastKnownUrl
      // plaintext. Read just that minimal shape; never revive a refresh grant.
      if (keyProvider) try {
        legacy = decryptRecord(legacy, await keyProvider.getKey(), ["tunnelSecret"]).record;
      } catch (err) {
        if (err instanceof SecretEnvelopeError) { recoveryRequired = true; log?.warn?.("bb-shared: preserving unreadable legacy OAuth record; manual recovery is required"); return null; }
        throw err;
      }
      const migrated = legacyToRecord(legacy);
      if (!migrated) { recoveryRequired = true; log?.warn?.("bb-shared: preserving unusable legacy OAuth record; manual recovery is required"); return null; }
      await this.save(migrated); await kv.delete(OAUTH_RECORD_KEY);
      log?.info?.("bb-shared: migrated legacy OAuth worker endpoint and purged OAuth credentials");
      return migrated;
    },
    async requiresRecovery() { return recoveryRequired; },
    async save(record) { await kv.set(WORKER_RECORD_KEY, await encode(workerRecordSchema.parse(record))); },
    async clear() { await kv.delete(WORKER_RECORD_KEY); recoveryRequired = false; },
  };
}
