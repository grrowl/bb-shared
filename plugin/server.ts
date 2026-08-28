// bb-plugin-shared — backend entry.
//
// Scaffold for issue 04 (see `.scratch/v0/issues/04-plugin-scaffold.md`). The
// RPC contract is complete and typed; the handlers are stubs that throw
// "not implemented" so downstream issues (05 token store, 06 authz, 07
// worker deploy) can fill the bodies without touching call sites.
//
// One consumer: the frontend at `app.tsx`, which reaches these methods with
// `useRpc<typeof rpcContract>()`.
import { fileURLToPath } from "node:url";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  InMemoryStore,
  buildShareUrl,
  DuplicateShareError,
  ShareNotFoundError,
  TokenNotFoundError,
  type Store,
} from "./lib/token-store";
import { registerAuthzRoute } from "./authz/authz";
import {
  WorkerLifecycle,
  bundleWorker,
  createWorkerRecordStore,
} from "./worker-lifecycle";

// ---------------------------------------------------------------------------
// Data model (SPEC.md §"Data model"). In-memory in v0; the shape is designed
// so a persistent store can slot in later without touching call sites.
// ---------------------------------------------------------------------------

export const permSchema = z.enum(["read", "write"]);
export type Perm = z.output<typeof permSchema>;

export const shareSchema = z.object({
  thread_id: z.string(),
  project_id: z.string(),
  perm: permSchema,
  added_at: z.number(),
});
export type Share = z.output<typeof shareSchema>;

export const tokenSchema = z.object({
  id: z.string(),
  hash: z.string(),
  label: z.string(),
  shares: z.array(shareSchema),
  created_at: z.number(),
});
export type Token = z.output<typeof tokenSchema>;

// getWorkerStatus payload (issue 07). `url`/`claim` are surfaced to the owner
// UI (the 16 nav panel reads `claim` for the "claim this worker" nudge); the
// worker's apiToken + tunnelSecret never cross this boundary. `state` drives
// the deploy/redeploy/health UI; `expiresAt` drives the CF claim countdown.
export const workerStatusSchema = z.object({
  url: z.string().optional(),
  state: z.enum(["idle", "deploying", "live", "unhealthy", "error"]),
  expiresAt: z.number().optional(),
  claim: z
    .object({ url: z.string(), expiresAt: z.number().nullable() })
    .optional(),
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
});
export type WorkerStatus = z.output<typeof workerStatusSchema>;

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
    input: z.object({ label: z.string().min(1).max(64).optional() }),
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
});

export type RpcContract = typeof rpcContract;

// ---------------------------------------------------------------------------
// Realtime channel names. The frontend subscribes with `useRealtime(...)` to
// refetch when state changes; broadcast from wherever the mutation happens.
// ---------------------------------------------------------------------------

export const REALTIME_CHANNELS = {
  /** Any token mutation (mint/rename/delete/share add/remove/update). */
  tokensChanged: "tokens-changed",
  /** Worker deploy / health transitions. Payload: { url?, healthy }. */
  workerChanged: "worker-changed",
} as const;

// ---------------------------------------------------------------------------
// Plugin factory. Bodies stubbed with `throw new Error("not implemented: X")`
// so a subagent filling them in only writes the body — the wire shape is
// already fixed by the contract above.
// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("bb-plugin-shared loaded");

  // Per-process, in-memory token store. HMAC key + tokens die with the plugin
  // (SPEC §"Data model (in-memory only)"), guest URLs die with them.
  const store: Store = new InMemoryStore();

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
    recordStore: createWorkerRecordStore(bb.storage.kv),
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
    // Health loop only runs while at least one guest token exists.
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
      const { token, rawToken } = await store.mintToken({ label: input.label });
      // Lazy first-deploy (SPEC §"Worker lifecycle"): the first mint triggers
      // the worker deploy. ensureDeployed dedupes and swallows deploy errors,
      // so minting never fails on a worker hiccup — the URL falls back to the
      // `<worker-pending>` placeholder and the owner UI badges it until the
      // health loop brings a worker up.
      await lifecycle.ensureDeployed();
      const workerOrigin = lifecycle.currentWorkerUrl() ?? undefined;
      const url = buildShareUrl(rawToken, { workerOrigin });
      emitTokensChanged();
      return { token, url };
    },

    async listTokens() {
      const tokens = await store.listTokens();
      return { tokens };
    },

    async renameToken(input) {
      try {
        await store.renameToken(input.id, input.label);
      } catch (err) {
        throw mapStoreError(err);
      }
      emitTokensChanged();
      return { ok: true as const };
    },

    async deleteToken(input) {
      try {
        await store.deleteToken(input.id);
      } catch (err) {
        throw mapStoreError(err);
      }
      emitTokensChanged();
      return { ok: true as const };
    },

    async addShare(input) {
      try {
        await store.addShare(input.token_id, {
          thread_id: input.thread_id,
          project_id: input.project_id,
          perm: input.perm,
        });
      } catch (err) {
        throw mapStoreError(err);
      }
      emitTokensChanged();
      return { ok: true as const };
    },

    async removeShare(input) {
      try {
        await store.removeShare(input.token_id, input.thread_id);
      } catch (err) {
        throw mapStoreError(err);
      }
      emitTokensChanged();
      return { ok: true as const };
    },

    async updateShare(input) {
      try {
        await store.updateShare(input.token_id, input.thread_id, input.perm);
      } catch (err) {
        throw mapStoreError(err);
      }
      emitTokensChanged();
      return { ok: true as const };
    },

    getWorkerStatus(): WorkerStatus {
      return lifecycle.getStatus();
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
