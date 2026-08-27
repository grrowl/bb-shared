// bb-plugin-shared — backend entry.
//
// Scaffold for issue 04 (see `.scratch/v0/issues/04-plugin-scaffold.md`). The
// RPC contract is complete and typed; the handlers are stubs that throw
// "not implemented" so downstream issues (05 token store, 06 authz, 07
// worker deploy) can fill the bodies without touching call sites.
//
// One consumer: the frontend at `app.tsx`, which reaches these methods with
// `useRpc<typeof rpcContract>()`.
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

export const workerStatusSchema = z.object({
  url: z.string().optional(),
  healthy: z.boolean(),
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

  // Broadcast helper — nudges the frontend management panel (issue 16) to
  // re-fetch after any token mutation.
  const emitTokensChanged = () => {
    bb.realtime.publish(REALTIME_CHANNELS.tokensChanged, { at: Date.now() });
  };

  const notImplemented = (method: string): never => {
    throw new Error(`not implemented: ${method}`);
  };

  bb.rpc.register(rpcContract, {
    async mintToken(input) {
      const { token, rawToken } = await store.mintToken({ label: input.label });
      // TODO(issue 07): pass a real workerOrigin once the deploy pipeline is
      // wired through — for now the URL carries a `<worker-pending>`
      // placeholder that the owner UI can badge as unclaimed.
      const url = buildShareUrl(rawToken);
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

    // Left for issue 07 (worker deploy). Falls back to the scaffold stub.
    getWorkerStatus(): WorkerStatus {
      return notImplemented("getWorkerStatus");
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
