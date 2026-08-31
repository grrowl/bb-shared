// bb-plugin-shared — backend entry. The typed RPC contract is consumed by the
// frontend in `app.tsx`; this module owns its handlers and worker lifecycle.
import { fileURLToPath } from "node:url";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  InMemoryStore,
  enrichToken,
  DuplicateShareError,
  ShareNotFoundError,
  TokenNotFoundError,
  type Token as StoredToken,
  type TokenSnapshot,
} from "./lib/token-store";
import { registerAuthzRoute } from "./authz/authz";
import {
  WorkerLifecycle,
  bundleWorker,
  createWorkerRecordStore,
} from "./worker-lifecycle";
import { createDeviceKeyProvider } from "./lib/device-key";
import { ShareStateRecordStore } from "./lib/share-state-record";
import { REALTIME_CHANNELS } from "./lib/realtime-channels";

// ---------------------------------------------------------------------------
// Data model exposed over the owner-only RPC boundary.
// ---------------------------------------------------------------------------

export const permSchema = z.enum(["read", "write"]);
export type Perm = z.output<typeof permSchema>;

export const shareSchema = z.object({
  thread_id: z.string(),
  project_id: z.string(),
  perm: permSchema,
  added_at: z.number(),
  // Resolved thread title (issue 32). The server looks each shared thread's
  // title up when it builds the token list and falls back to `thread_id` when
  // the thread is gone, so share rows read as titles, not raw ids.
  title: z.string(),
  // A guest URL that lands directly on this share's thread. It is rebuilt from
  // the owner-only encrypted share-state record and never crosses to guests.
  url: z.string().optional(),
});
export type Share = z.output<typeof shareSchema>;

export const tokenSchema = z.object({
  id: z.string(),
  hash: z.string(),
  label: z.string(),
  shares: z.array(shareSchema),
  created_at: z.number(),
  // Owner-only guest link, rebuilt from the encrypted durable share state so
  // Copy link continues working after a plugin or app restart.
  url: z.string().optional(),
});
export type Token = z.output<typeof tokenSchema>;

// getWorkerStatus payload (issue 07). `url` is surfaced to the owner UI; the
// worker's provisioning API token + tunnelSecret never cross this boundary.
// `state` drives the online/offline and explicit-recreate UI.
//
// H1 (ticket 20): the CF `claim.url` account-takeover bearer is NOT in this
// payload — it rode both this RPC and the worker-changed broadcast. The claim
// URL now flows only through the dedicated owner-only `getClaimUrl` RPC below,
// which the worker denies to guests (M2); it never appears on a broadcast.
export const workerStatusSchema = z.object({
  url: z.string().optional(),
  state: z.enum(["idle", "deploying", "live", "offline"]),
  healthy: z.boolean(),
  tunnel: z
    .enum([
      "disconnected",
      "connecting",
      "connected",
      "reconnecting",
      "stopped",
    ])
    .optional(),
  fault: z.string().optional(),
});
export type WorkerStatus = z.output<typeof workerStatusSchema>;

// getClaimUrl payload (H1, ticket 20). Owner-only: returns the CF claim
// affordance (an account-takeover bearer). Guest-unreachable because the worker
// deny-closes every `/api/v1/plugins/shared/rpc/*` path (M2). `null` until a
// worker is deployed.
export const claimUrlSchema = z.object({
  claim: z
    .object({ url: z.string(), expiresAt: z.number().nullable() })
    .nullable(),
});
export type ClaimUrlResult = z.output<typeof claimUrlSchema>;


// void-returning methods use { ok: true } as their wire payload — zod has no
// clean "no result" primitive for the strict-JSON envelope, and this matches
// bb's automations plugin convention.
const okSchema = z.object({ ok: z.literal(true) }).strict();

// ---------------------------------------------------------------------------
// RPC contract (issue 04). Names are camelCase per the ticket; the bb host
// only requires /^[a-zA-Z0-9_-]+$/. Every input/output is a zod schema so the
// host validates both sides at the wire boundary.
// ---------------------------------------------------------------------------

export const rpcContract = defineRpcContract({
  mintToken: {
    // `firstThread` attaches a thread in the same call so the returned `url`
    // is a usable deep link to it, not a bare token URL that resolves nowhere.
    input: z.object({
      label: z.string().min(1).max(64).optional(),
      firstThread: z
        .object({
          thread_id: z.string(),
          project_id: z.string(),
          perm: permSchema,
        })
        .optional(),
    }),
    output: z.object({ token: tokenSchema, url: z.string() }),
  },
  listTokens: {
    input: z.null(),
    output: z.object({ tokens: z.array(tokenSchema) }),
  },
  renameToken: {
    input: z.object({ id: z.string(), label: z.string().min(1).max(64) }),
    output: okSchema,
  },
  deleteToken: {
    input: z.object({ id: z.string() }),
    output: okSchema,
  },
  addShare: {
    input: z.object({
      token_id: z.string(),
      thread_id: z.string(),
      project_id: z.string(),
      perm: permSchema,
    }),
    output: okSchema,
  },
  removeShare: {
    input: z.object({
      token_id: z.string(),
      thread_id: z.string(),
    }),
    output: okSchema,
  },
  updateShare: {
    input: z.object({
      token_id: z.string(),
      thread_id: z.string(),
      perm: permSchema,
    }),
    output: okSchema,
  },
  getWorkerStatus: {
    input: z.null(),
    output: workerStatusSchema,
  },
  getClaimUrl: {
    input: z.null(),
    output: claimUrlSchema,
  },
  recreateWorker: {
    input: z.null(),
    output: okSchema,
  },
});

export type RpcContract = typeof rpcContract;

// ---------------------------------------------------------------------------
// Realtime channel names. Defined in the pure-string module
// `./lib/realtime-channels` (issue 18) so frontend consumers can import the
// names without dragging this Node-only module (and its `node:crypto` token
// store) into the browser bundle. Re-exported here for backward compatibility
// with existing backend importers.
// ---------------------------------------------------------------------------

export { REALTIME_CHANNELS } from "./lib/realtime-channels";

// ---------------------------------------------------------------------------
// Plugin factory. Bodies stubbed with `throw new Error("not implemented: X")`
// so a subagent filling them in only writes the body — the wire shape is
// already fixed by the contract above.
// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("bb-plugin-shared loaded");

  // Device-tied encryption protects both the worker connection record and the
  // durable shared-link state. On macOS the key is in Keychain; elsewhere it
  // has a 0600-file fallback. It never lives in bb.storage.kv.
  const deviceKeyProvider = createDeviceKeyProvider({
    dataDir: () => bb.server.experimental_dataDir,
    pluginId: bb.pluginId,
    log: bb.log,
  });
  const shareState = new ShareStateRecordStore(
    bb.storage.kv,
    deviceKeyProvider,
    bb.log,
  );
  const restoredShares = await shareState.load();
  // Hashes are derived under a fresh process-local HMAC key. Only the actual
  // guest bearers and their grants are persisted, inside the encrypted record.
  const store = new InMemoryStore({ initialTokens: restoredShares });
  const rawTokenById = new Map(restoredShares.map((token) => [token.id, token.rawToken]));

  const persistShares = async () => {
    const tokens = await store.listTokens();
    const snapshot: TokenSnapshot[] = tokens.map((token) => {
      const rawToken = rawTokenById.get(token.id);
      if (rawToken === undefined) throw new Error(`Missing bearer for shared link ${token.id}.`);
      const { hash: _hash, ...stored } = token;
      return { ...stored, rawToken };
    });
    await shareState.save(snapshot);
  };
  // Mutations and their encrypted snapshots are serialized: a slower earlier
  // KV write can never overwrite a newer grant change.
  let shareMutationQueue: Promise<void> = Promise.resolve();
  const mutateShares = <T,>(operation: () => Promise<T>): Promise<T> => {
    const mutation = shareMutationQueue.then(async () => {
      const priorTokens = await store.listTokens();
      const priorRawTokens = new Map(rawTokenById);
      const value = await operation();
      try {
        await persistShares();
      } catch (error) {
        // Do not claim a change succeeded when its encrypted record could not
        // be written. Restore the live authz state to the prior durable view.
        store.restoreTokens(priorTokens);
        rawTokenById.clear();
        for (const [id, rawToken] of priorRawTokens) rawTokenById.set(id, rawToken);
        throw error;
      }
      return value;
    });
    shareMutationQueue = mutation.then(() => undefined, () => undefined);
    return mutation;
  };

  // Resolve a thread's display title for the token list (issue 32, surface 5).
  // Returns null when the thread has no title yet; enrichToken falls the id
  // through when the thread is gone (get throws) or stays untitled.
  const resolveTitle = async (threadId: string): Promise<string | null> => {
    const thread = await bb.sdk.threads.get({ threadId });
    return thread.title ?? thread.titleFallback ?? null;
  };

  // Project a stored token onto its wire shape (title per share + session URL),
  // reusing the raw-token cache and the live worker origin. One code path for
  // mintToken and listTokens keeps their URLs identical.
  const toWireToken = (t: StoredToken) =>
    enrichToken(t, {
      rawToken: rawTokenById.get(t.id),
      workerOrigin: lifecycle.currentWorkerUrl() ?? undefined,
      resolveTitle,
    });

  // Authoritative authz endpoint the CF worker pulls per guest request
  // (issue 06). Token-authed; consumes the same in-memory store.
  registerAuthzRoute(bb, store);

  // Worker lifecycle manager (issue 07): owns the CF worker deploy pipeline,
  // secret provisioning, health/redeploy loop, and the SharedTunnel (issue 14)
  // it drives. Mounted as a single background service below.
  //
  // The worker source lives at `../worker` relative to this plugin package in
  // the v0 monorepo; `BB_SHARED_WORKER_DIR` overrides for packaged installs
  // where the layout differs.
  const workerDir =
    process.env.BB_SHARED_WORKER_DIR ??
    fileURLToPath(new URL("../worker", import.meta.url));

  const lifecycle = new WorkerLifecycle({
    recordStore: createWorkerRecordStore(bb.storage.kv, {
      keyProvider: deviceKeyProvider,
      log: bb.log,
    }),
    log: bb.log,
    publishStatus: (status) => {
      bb.realtime.publish(REALTIME_CHANNELS.workerChanged, status);
    },
    getLoopbackBaseUrl: () => bb.server.loopbackBaseUrl,
    // The authz endpoint secret — bb's built-in per-plugin token. We only plumb
    // it to the deploy (SPEC §"Secret provisioning" #1).
    getAuthzToken: async () => {
      const { token } = await bb.sdk.plugins.token({ pluginId: bb.pluginId });
      return token;
    },
    // Kept for API compatibility; lifecycle probes saved workers even without shares.
    hasTokens: async () => (await store.listTokens()).length > 0,
    bundleWorker: () => bundleWorker({ workerDir, log: bb.log }),
  });

  bb.background.service("worker-lifecycle", {
    start: (signal) => lifecycle.start(signal),
  });

  // Broadcast helper — nudges the frontend management panel (issue 16) to
  // re-fetch after any token mutation.
  const emitTokensChanged = () => {
    bb.realtime.publish(REALTIME_CHANNELS.tokensChanged, { at: Date.now() });
  };

  bb.rpc.register(rpcContract, {
    async mintToken(input) {
      let token: StoredToken;
      let rawToken: string;
      try {
        ({ token, rawToken } = await mutateShares(async () => {
          let minted = await store.mintToken({ label: input.label });
          rawTokenById.set(minted.token.id, minted.rawToken);
          // A new link and its initial share become durable together.
          if (input.firstThread) {
            await store.addShare(minted.token.id, {
              thread_id: input.firstThread.thread_id,
              project_id: input.firstThread.project_id,
              perm: input.firstThread.perm,
            });
            minted = {
              ...minted,
              token: (await store.getToken(minted.token.id)) ?? minted.token,
            };
          }
          return minted;
        }));
      } catch (err) {
        throw mapStoreError(err);
      }
      // Lazy first-deploy (SPEC §"Worker lifecycle"): the first mint triggers
      // the worker deploy. ensureDeployed dedupes and swallows deploy errors,
      // so minting never fails on a worker hiccup — the URL falls back to the
      // `<worker-pending>` placeholder and the owner UI badges it until the
      // health loop brings a worker up.
      await lifecycle.ensureDeployed();
      // enrichToken deep-links to shares[0] (the firstThread just attached) and
      // builds the URL from the same cached raw token, so `url` here equals the
      // one a later listTokens returns for this token.
      const wire = await toWireToken(token);
      emitTokensChanged();
      // The raw token was just cached, so enrichToken always set `wire.url`.
      return { token: wire, url: wire.url! };
    },

    async listTokens() {
      const stored = await store.listTokens();
      const tokens = await Promise.all(stored.map(toWireToken));
      return { tokens };
    },

    async renameToken(input) {
      try {
        await mutateShares(() => store.renameToken(input.id, input.label));
      } catch (err) {
        throw mapStoreError(err);
      }
      emitTokensChanged();
      return { ok: true as const };
    },

    async deleteToken(input) {
      try {
        await mutateShares(async () => {
          await store.deleteToken(input.id);
          rawTokenById.delete(input.id);
        });
      } catch (err) {
        throw mapStoreError(err);
      }
      emitTokensChanged();
      return { ok: true as const };
    },

    async addShare(input) {
      try {
        await mutateShares(() => store.addShare(input.token_id, {
          thread_id: input.thread_id,
          project_id: input.project_id,
          perm: input.perm,
        }));
      } catch (err) {
        throw mapStoreError(err);
      }
      emitTokensChanged();
      return { ok: true as const };
    },

    async removeShare(input) {
      try {
        await mutateShares(() => store.removeShare(input.token_id, input.thread_id));
      } catch (err) {
        throw mapStoreError(err);
      }
      emitTokensChanged();
      return { ok: true as const };
    },

    async updateShare(input) {
      try {
        await mutateShares(() => store.updateShare(input.token_id, input.thread_id, input.perm));
      } catch (err) {
        throw mapStoreError(err);
      }
      emitTokensChanged();
      return { ok: true as const };
    },

    getWorkerStatus(): WorkerStatus {
      return lifecycle.getStatus();
    },

    // Owner-only (H1, ticket 20): the CF claim.url is an account-takeover
    // bearer, so it is delivered on its own RPC — kept off getWorkerStatus and
    // the worker-changed broadcast — and the worker denies this path to guests
    // (M2). See worker/src/stages/authz.ts `isGuestDeniedRpcPath`.
    getClaimUrl(): ClaimUrlResult {
      return { claim: lifecycle.getClaimUrl() };
    },

    async recreateWorker() {
      await lifecycle.recreateWorker();
      emitTokensChanged();
      return { ok: true as const };
    },
  });

  bb.onDispose(() => {
    bb.log.info("bb-plugin-shared disposed");
  });
}

/**
 * Turn store errors into user-friendly RPC errors. The bb host serializes
 * plain `Error` messages back to the frontend, so a readable `.message`
 * is what surfaces in the UI.
 */
function mapStoreError(err: unknown): Error {
  if (err instanceof TokenNotFoundError) {
    return new Error(`Token not found (${err.token_id}). It may have been deleted.`);
  }
  if (err instanceof ShareNotFoundError) {
    return new Error(`Thread is not shared on this token.`);
  }
  if (err instanceof DuplicateShareError) {
    return new Error(`Thread is already shared on this token.`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
