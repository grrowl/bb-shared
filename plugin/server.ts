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
  enrichToken,
  DuplicateShareError,
  ShareNotFoundError,
  TokenNotFoundError,
  type Store,
  type Token as StoredToken,
} from "./lib/token-store";
import { registerAuthzRoute } from "./authz/authz";
import {
  WorkerLifecycle,
  bundleWorker,
  createWorkerRecordStore,
  type ConnectionStatus,
} from "./worker-lifecycle";
import {
  createOAuthRecordStore,
  OAuthClient,
  probeTunnelSecret,
  DEFAULT_OAUTH_CALLBACK_PORT,
} from "./cf-oauth";
import { createDeviceKeyProvider } from "./lib/device-key";
import { REALTIME_CHANNELS } from "./lib/realtime-channels";

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
  // Resolved thread title (issue 32). The server looks each shared thread's
  // title up when it builds the token list and falls back to `thread_id` when
  // the thread is gone, so share rows read as titles, not raw ids.
  title: z.string(),
});
export type Share = z.output<typeof shareSchema>;

export const tokenSchema = z.object({
  id: z.string(),
  hash: z.string(),
  label: z.string(),
  shares: z.array(shareSchema),
  created_at: z.number(),
  // Session guest link (issue 32). Present while the raw token is still held in
  // memory this session so Copy link keeps working; the raw token itself never
  // crosses this boundary and is never persisted. Every listed token is from
  // this session, so in practice this is always set.
  url: z.string().optional(),
});
export type Token = z.output<typeof tokenSchema>;

// getWorkerStatus payload (issue 07). `url` is surfaced to the owner UI; the
// worker's apiToken + tunnelSecret never cross this boundary. `state` drives
// the deploy/redeploy/health UI; `expiresAt` drives the CF claim countdown.
//
// H1 (ticket 20): the CF `claim.url` account-takeover bearer is NOT in this
// payload — it rode both this RPC and the worker-changed broadcast. The claim
// URL now flows only through the dedicated owner-only `getClaimUrl` RPC below,
// which the worker denies to guests (M2); it never appears on a broadcast.
export const workerStatusSchema = z.object({
  url: z.string().optional(),
  state: z.enum(["idle", "deploying", "live", "unhealthy", "error"]),
  expiresAt: z.number().optional(),
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

// getConnectionStatus payload (issue 28). A REDACTED projection: the account id
// and LIVE hostname are surfaced to the owner UI; the OAuth refresh/access
// tokens NEVER cross this boundary (they live encrypted at rest + in memory).
export const connectionStatusSchema = z.object({
  connection: z.enum(["not-connected", "connecting", "connected"]),
  claimed: z.boolean(),
  accountId: z.string().optional(),
  hostname: z.string().optional(),
  writeGranted: z.boolean().optional(),
});
export type ConnectionStatusResult = z.output<typeof connectionStatusSchema>;

// connectCloudflare payload: the authorize URL the frontend opens in the
// owner's browser. The code exchange + discovery finish in the background; the
// UI tracks the result via getConnectionStatus / the connection-changed channel.
export const connectResultSchema = z.object({ authorizeUrl: z.string() });
export type ConnectResult = z.output<typeof connectResultSchema>;

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
  // Cloudflare OAuth (issue 28).
  getConnectionStatus: {
    input: z.null(),
    output: connectionStatusSchema,
  },
  connectCloudflare: {
    input: z.null(),
    output: connectResultSchema,
  },
  disconnectCloudflare: {
    input: z.null(),
    output: okSchema,
  },
  redeployClaimedWorker: {
    input: z.null(),
    output: okSchema,
  },
  undeployClaimedWorker: {
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

  // Per-process, in-memory token store. HMAC key + tokens die with the plugin
  // (SPEC §"Data model (in-memory only)"), guest URLs die with them.
  const store: Store = new InMemoryStore();

  // Raw guest tokens, held in memory ONLY for the session (issue 32, SPEC
  // surface 4) so Copy link keeps working after mint. Never persisted — not to
  // disk, not to bb.storage.kv — so it dies with the plugin exactly like the
  // HMAC key that would let it match. Keyed by the public token id.
  const rawTokenById = new Map<string, string>();

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

  // Device-tied key for at-rest encryption of the worker record's secret
  // fields (issue 29). macOS Keychain on this owner's Mac; a 0600 file fallback
  // elsewhere. The key never touches the repo or bb.storage.kv. `dataDir` is a
  // thunk so the bind-gated `experimental_dataDir` is only read on the
  // non-macOS fallback path, not at plugin load.
  const deviceKeyProvider = createDeviceKeyProvider({
    dataDir: () => bb.server.experimental_dataDir,
    pluginId: bb.pluginId,
    log: bb.log,
  });

  // Cloudflare OAuth configuration (issue 28). The `client_id` is CONFIGURABLE,
  // not hardcoded — grrowl's public OAuth client is registered once by the owner
  // (see the ticket's registration curl) and its id pasted here. Empty until
  // then, in which case Connect surfaces a clear "not configured" error. The
  // callback port is fixed (CF matches redirect_uris exactly) and exposed so the
  // registered redirect URI and the listener always agree.
  const cfSettingsHandle = bb.settings.define({
    cfOauthClientId: {
      type: "string",
      label: "Cloudflare OAuth client id",
      description:
        "The public OAuth client id registered for this plugin (see the plugin README). Leave blank to disable Cloudflare connect.",
      default: "",
    },
    cfOauthCallbackPort: {
      type: "string",
      label: "Cloudflare OAuth callback port",
      description:
        "Loopback port for the OAuth redirect. Must match the port in the client's registered redirect URI (http://127.0.0.1:<port>/oauth/callback).",
      default: String(DEFAULT_OAUTH_CALLBACK_PORT),
    },
  });
  // Cache settings synchronously for the lifecycle's () => value accessors;
  // refresh the cache on change (a reload is still needed for it to take full
  // effect, per the SDK, but this keeps the cache honest within a load).
  let cfSettings = await cfSettingsHandle.get();
  cfSettingsHandle.onChange((next) => {
    cfSettings = next;
  });
  const parseCallbackPort = (): number => {
    const n = Number.parseInt(cfSettings.cfOauthCallbackPort ?? "", 10);
    return Number.isFinite(n) && n > 0 && n < 65536
      ? n
      : DEFAULT_OAUTH_CALLBACK_PORT;
  };

  const lifecycle = new WorkerLifecycle({
    recordStore: createWorkerRecordStore(bb.storage.kv, {
      keyProvider: deviceKeyProvider,
      log: bb.log,
    }),
    // Cloudflare OAuth-claimed record (issue 28): a SEPARATE encrypted KV entry
    // holding the rotating refresh token + claimed metadata (§11.5). Same
    // device-tied key as the temp record.
    oauthRecordStore: createOAuthRecordStore(bb.storage.kv, {
      keyProvider: deviceKeyProvider,
      log: bb.log,
    }),
    oauthClient: new OAuthClient(),
    getOAuthClientId: () => cfSettings.cfOauthClientId ?? "",
    getOAuthCallbackPort: parseCallbackPort,
    tunnelProbe: probeTunnelSecret,
    publishConnection: (status: ConnectionStatus) => {
      bb.realtime.publish(REALTIME_CHANNELS.connectionChanged, status);
    },
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
      let { token, rawToken } = await store.mintToken({ label: input.label });
      // Hold the raw token in memory for the session (issue 32) so listTokens
      // can rebuild its URL for Copy link. Never persisted.
      rawTokenById.set(token.id, rawToken);
      // Attach the requesting thread in the same call (when given) so the
      // returned link deep-links straight to it. Without a share the link
      // resolves nowhere for a guest.
      if (input.firstThread) {
        try {
          await store.addShare(token.id, {
            thread_id: input.firstThread.thread_id,
            project_id: input.firstThread.project_id,
            perm: input.firstThread.perm,
          });
          // Re-read so the returned token carries the new share.
          token = (await store.getToken(token.id)) ?? token;
        } catch (err) {
          throw mapStoreError(err);
        }
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
      // Drop the cached raw token with the record (issue 32).
      rawTokenById.delete(input.id);
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

    // Owner-only (H1, ticket 20): the CF claim.url is an account-takeover
    // bearer, so it is delivered on its own RPC — kept off getWorkerStatus and
    // the worker-changed broadcast — and the worker denies this path to guests
    // (M2). See worker/src/stages/authz.ts `isGuestDeniedRpcPath`.
    getClaimUrl(): ClaimUrlResult {
      return { claim: lifecycle.getClaimUrl() };
    },

    // ---- Cloudflare OAuth (issue 28) ----

    // Owner-only connection snapshot: account id + live hostname + write grant.
    // Never carries the refresh/access token (those stay encrypted/in-memory).
    getConnectionStatus(): ConnectionStatusResult {
      return lifecycle.getConnectionStatus();
    },

    // Start the connect flow and return the authorize URL for the FRONTEND to
    // open in the owner's browser (navigate.openUrl). The loopback listener runs
    // on the bb server host; the owner's browser must be on the same machine
    // (standard native-app OAuth). The exchange + discovery finish in the
    // background and broadcast on the connection-changed channel.
    async connectCloudflare(): Promise<ConnectResult> {
      return lifecycle.beginCloudflareConnect();
    },

    async disconnectCloudflare() {
      await lifecycle.disconnectCloudflare();
      return { ok: true as const };
    },

    async redeployClaimedWorker() {
      await lifecycle.redeployClaimedWorker();
      emitTokensChanged();
      return { ok: true as const };
    },

    async undeployClaimedWorker() {
      await lifecycle.undeployClaimedWorker();
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
