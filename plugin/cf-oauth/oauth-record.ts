// Persisted OAuth-claimed worker record (issue 28 §11.5).
//
// A SEPARATE KV entry from the temp `worker-record` (issue 07). The unclaimed
// temp-worker flow is unchanged; this record exists ONLY once the owner has
// connected Cloudflare by OAuth and a discovery confirmed a claimed worker.
//
// PERSISTED: cfRefreshToken (SECRET), claimedAccountId, scriptName, tunnelSecret
// (SECRET), non-secret metadata, and lastKnownUrl as a CACHE ONLY (the live
// hostname is re-resolved from CF every start — never trusted from disk, §10).
//
// NEVER PERSISTED: the OAuth access token (memory-only), the temp apiToken, the
// temp accountId, or the CF claim.url. `claimed` is a literal `true` — this
// record is only ever written from an OAuth-verified discovery (§11.4).
//
// AT REST (issue 29): the two SECRET fields are encrypted with the device-tied
// key via the same envelope layer the worker record uses (`../lib/device-key`).
// A record that fails to decrypt (wrong machine / tamper) is wiped and treated
// as absent → the plugin degrades to "not connected", never crashes.
import { z } from "zod";
import {
  decryptRecord,
  encryptRecord,
  SecretEnvelopeError,
  type KeyProvider,
  type SecretFieldPath,
} from "../lib/device-key";

/** KV key the OAuth-claimed record lives under (distinct from `worker-record`). */
export const OAUTH_RECORD_KEY = "oauth-worker-record";

/** Secret dot-paths encrypted at rest by issue 29. */
export const OAUTH_RECORD_SECRET_FIELDS: readonly SecretFieldPath[] = [
  "cfRefreshToken",
  "tunnelSecret",
];

export const oauthWorkerRecordSchema = z.object({
  /** Set ONLY from an OAuth-verified discovery (§11.4) — trustworthy by construction. */
  claimed: z.literal(true),
  /** Rotating long-lived refresh token to the owner's real CF account. SECRET. */
  cfRefreshToken: z.string(),
  /** Which account owns the worker — the target for every OAuth API call. */
  claimedAccountId: z.string(),
  /** Discovery key: the fixed script name we deploy under. */
  scriptName: z.string(),
  /** Handshake bearer to re-dial the tunnel without a redeploy. SECRET. */
  tunnelSecret: z.string(),
  /** True iff the owner also granted the write scope (redeploy/undeploy). */
  writeGranted: z.boolean(),
  /** Cache/UX only — re-verified live on every start, never trusted (§10). */
  lastKnownUrl: z.string().optional(),
  // ---- non-secret metadata ----
  deploymentId: z.string(),
  generation: z.number(),
  deployedAt: z.number(),
  /** When the OAuth discovery confirmed the claim (ms epoch). */
  claimedAt: z.number(),
});

export type OAuthWorkerRecord = z.infer<typeof oauthWorkerRecordSchema>;

/** Minimal KV surface (matches `bb.storage.kv`), reused from worker-record. */
export interface OAuthRecordKv {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface OAuthRecordStore {
  load(): Promise<OAuthWorkerRecord | null>;
  save(record: OAuthWorkerRecord): Promise<void>;
  clear(): Promise<void>;
}

export interface OAuthRecordStoreOptions {
  /** Device-tied key source (issue 29). Absent → plaintext (tests only). */
  keyProvider?: KeyProvider;
  log?: {
    warn?(msg: string, meta?: unknown): void;
    info?(msg: string, meta?: unknown): void;
  };
}

/**
 * KV-backed store for the OAuth-claimed record. Same defensive posture as the
 * worker record store: a malformed blob — or one whose secrets cannot be
 * decrypted — is wiped and treated as absent, degrading to "not connected"
 * rather than crashing. Legacy plaintext (should not exist for a new feature,
 * but handled for symmetry) is re-saved encrypted on first read.
 */
export function createOAuthRecordStore(
  kv: OAuthRecordKv,
  options: OAuthRecordStoreOptions = {},
): OAuthRecordStore {
  const { keyProvider, log } = options;

  return {
    async load() {
      const raw = await kv.get<unknown>(OAUTH_RECORD_KEY);
      if (raw === undefined || raw === null) return null;

      let candidate: unknown = raw;
      let migrated = false;
      if (keyProvider) {
        try {
          const key = await keyProvider.getKey();
          const dec = decryptRecord(raw, key, OAUTH_RECORD_SECRET_FIELDS);
          candidate = dec.record;
          migrated = dec.migrated;
        } catch (err) {
          if (err instanceof SecretEnvelopeError) {
            log?.warn?.(
              "bb-shared: OAuth record could not be decrypted; wiping and dropping to not-connected",
            );
            await kv.delete(OAUTH_RECORD_KEY);
            return null;
          }
          throw err; // a key-provider outage is not a corrupt-record signal
        }
      }

      const parsed = oauthWorkerRecordSchema.safeParse(candidate);
      if (!parsed.success) {
        await kv.delete(OAUTH_RECORD_KEY);
        return null;
      }

      if (keyProvider && migrated) {
        log?.info?.(
          "bb-shared: migrating plaintext OAuth record to encrypted at-rest storage",
        );
        await this.save(parsed.data);
      }
      return parsed.data;
    },
    async save(record) {
      if (keyProvider) {
        const key = await keyProvider.getKey();
        const atRest = encryptRecord(record, key, OAUTH_RECORD_SECRET_FIELDS);
        await kv.set(OAUTH_RECORD_KEY, atRest);
        return;
      }
      await kv.set(OAUTH_RECORD_KEY, record);
    },
    async clear() {
      await kv.delete(OAUTH_RECORD_KEY);
    },
  };
}
