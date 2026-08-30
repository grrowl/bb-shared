// WorkerLifecycle (issue 07) — the plugin-side manager for the CF worker's
// whole life: bootstrap-or-reuse on start, lazy first deploy, periodic health,
// redeploy-on-failure, secret provisioning, the SharedTunnel it drives, and the
// CF claim nudge surfaced to the owner UI.
//
// Mounted as a single `bb.background.service("worker-lifecycle", …)`. It OWNS
// the SharedTunnel instances (issue 14): on every (re)deploy it stops the old
// tunnel, mints a fresh handshake secret, deploys a fresh worker, and starts a
// new tunnel — so secret rotation and tunnel restart are one atomic step.
//
// State transitions broadcast on the `worker-changed` realtime channel so the
// 15/16 owner UI reflects deploy / redeploy / health transitions live.
import type { PluginLogger } from "@get-bb/plugin-sdk";
import {
  SharedTunnel,
  type SharedTunnelOptions,
  type TunnelState,
} from "../lib/shared-tunnel";
import { deployWorker as defaultDeployWorker, redactSecrets } from "./cf-deploy";
import { mintTunnelSecret as defaultMintTunnelSecret } from "./tunnel-secret";
import type { WorkerRecord, WorkerRecordStore } from "./worker-record";
import {
  applyRefreshRotation,
  beginConnect as defaultBeginConnect,
  deleteClaimedWorker as defaultDeleteClaimedWorker,
  grantedWrite,
  OAuthClient,
  OAuthClientError,
  probeTunnelSecret as defaultTunnelProbe,
  redeployClaimedWorker as defaultRedeployClaimedWorker,
  resolveClaimedWorker as defaultResolveClaimedWorker,
  CF_SCOPES,
  CF_WORKER_SCRIPT_NAME,
  type BeginConnectArgs,
  type OAuthRecordStore,
  type OAuthTokenResponse,
  type OAuthWorkerRecord,
  type PendingConnect,
  type ResolvedWorker,
  type TunnelSecretProbe,
} from "../cf-oauth";

// ---------------------------------------------------------------------------
// Public status shape — the getWorkerStatus RPC payload (issue 07 + 16 nav
// panel) AND the worker-changed realtime broadcast. Deliberately a REDACTED
// projection of the record: the worker URL is surfaced (the owner needs it),
// but apiToken and tunnelSecret never leave the backend.
//
// H1 (ticket 20): the CF `claim.url` is an account-TAKEOVER bearer and is
// deliberately NOT part of this shape. It rode the worker-changed broadcast and
// the getWorkerStatus RPC, either of which a guest could potentially observe.
// The claim URL now flows only through the owner-only `getClaimUrl()` accessor
// (exposed as an RPC the worker denies to guests, M2) — never on a broadcast.
// ---------------------------------------------------------------------------

export type WorkerState =
  | "idle" // no worker; nothing deployed yet
  | "deploying" // a deploy is in flight
  | "live" // worker deployed and last health check passed
  | "unhealthy" // health check failed; a fresh deploy is being attempted
  | "error"; // deploy failed; will retry on the next tick / mint

export interface WorkerStatus {
  url?: string;
  state: WorkerState;
  expiresAt?: number;
  /** True iff the worker is currently deployed and reachable. */
  healthy: boolean;
  /** Live tunnel connection state, for richer UI (optional). */
  tunnel?: TunnelState;
}

// ---------------------------------------------------------------------------
// Cloudflare OAuth connection status (issue 28). A REDACTED projection for the
// owner UI + the connection-changed broadcast: it carries the account id, the
// live hostname, and whether write was granted — never the refresh/access
// token. `claimed` is true only after an OAuth-verified discovery found the
// worker under a real account (§11.4).
// ---------------------------------------------------------------------------

export type ConnectionState =
  | "not-connected" // no OAuth token; unclaimed temp-worker flow
  | "connecting" // authorize URL opened, awaiting the browser callback
  | "connected"; // an OAuth refresh token is held

export interface ConnectionStatus {
  connection: ConnectionState;
  /** True iff a claimed worker was confirmed under the connected account. */
  claimed: boolean;
  /** The connected/claimed account id (non-secret). */
  accountId?: string;
  /** The LIVE workers.dev hostname of the claimed worker (re-resolved). */
  hostname?: string;
  /** Whether the owner granted the write scope (redeploy/undeploy possible). */
  writeGranted?: boolean;
}

// ---------------------------------------------------------------------------
// Deploy-time constants — mirror worker/wrangler.toml + worker/README.md.
// ---------------------------------------------------------------------------

export const WORKER_DEPLOY_DEFAULTS = {
  scriptName: "bb-shared",
  compatibilityDate: "2025-06-01",
  doClassName: "TunnelDO",
  doBindingName: "TUNNEL_DO",
  migrationTag: "v1",
} as const;

/** Injectable seam matching SharedTunnel's surface (fake in tests). */
export interface TunnelLike {
  start(): void;
  stop(): void;
}

export interface WorkerLifecycleDeps {
  recordStore: WorkerRecordStore;
  log: PluginLogger;
  /** Publish a status snapshot on the worker-changed realtime channel. */
  publishStatus: (status: WorkerStatus) => void;
  /** bb.server.loopbackBaseUrl — read lazily (bind-gated). */
  getLoopbackBaseUrl: () => string;
  /** Fetch bb's per-plugin token (authz endpoint secret) fresh per deploy. */
  getAuthzToken: () => Promise<string>;
  /** Any live guest token? Gates the periodic health loop. */
  hasTokens: () => Promise<boolean>;
  /** Bundle the worker script for upload. */
  bundleWorker: () => Promise<string>;

  // ---- injectable seams (tests / config) ----
  deployWorker?: typeof defaultDeployWorker;
  mintTunnelSecret?: () => string;
  createTunnel?: (opts: SharedTunnelOptions) => TunnelLike;
  fetchImpl?: typeof fetch;
  now?: () => number;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  deployDefaults?: typeof WORKER_DEPLOY_DEFAULTS;

  // ---- Cloudflare OAuth (issue 28), all optional so the temp-worker flow and
  // its existing tests are unaffected when no OAuth wiring is supplied ----
  /** Persisted OAuth-claimed record store (encrypted, issue 29). */
  oauthRecordStore?: OAuthRecordStore;
  /** Shared OAuth token client (auth-code / refresh / revoke). */
  oauthClient?: OAuthClient;
  /** The registered CF OAuth `client_id` from plugin settings (may be ""). */
  getOAuthClientId?: () => string;
  /** The fixed loopback callback port from plugin settings. */
  getOAuthCallbackPort?: () => number;
  /** Publish a connection snapshot on the connection-changed channel. */
  publishConnection?: (status: ConnectionStatus) => void;
  /** Tunnel-secret disambiguation probe (defaults to the real ws dial). */
  tunnelProbe?: TunnelSecretProbe;
  // finer test seams for the OAuth flow
  beginConnect?: (args: BeginConnectArgs) => PendingConnect;
  resolveClaimedWorker?: typeof defaultResolveClaimedWorker;
  redeployClaimedWorker?: typeof defaultRedeployClaimedWorker;
  deleteClaimedWorker?: typeof defaultDeleteClaimedWorker;
}

export class WorkerLifecycle {
  private readonly deps: WorkerLifecycleDeps;
  private readonly now: () => number;
  private readonly healthTimeoutMs: number;
  private readonly healthIntervalMs: number;
  private readonly deployDefaults: typeof WORKER_DEPLOY_DEFAULTS;

  private record: WorkerRecord | null = null;
  private state: WorkerState = "idle";
  private tunnel: TunnelLike | null = null;
  private tunnelState: TunnelState | undefined;
  private deployInFlight: Promise<void> | null = null;
  private signal: AbortSignal | undefined;

  // ---- Cloudflare OAuth state (issue 28), all memory-only except oauthRecord's
  // persisted twin. The access token is NEVER persisted; the refresh token is
  // held here for the session and persisted only inside the OAuth record. ----
  private connection: ConnectionState = "not-connected";
  private oauthRecord: OAuthWorkerRecord | null = null;
  /** Live workers.dev URL of the adopted claimed worker (re-resolved, never trusted from disk). */
  private claimedUrl: string | null = null;
  private accessToken: string | null = null;
  private accessTokenExpiry = 0;
  /** Refresh token before a claim is confirmed/persisted (connected-but-unclaimed). */
  private sessionRefreshToken: string | null = null;
  private sessionWriteGranted = false;
  private pendingConnect: PendingConnect | null = null;

  constructor(deps: WorkerLifecycleDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.healthTimeoutMs = deps.healthTimeoutMs ?? 10_000;
    this.healthIntervalMs = deps.healthIntervalMs ?? 60_000;
    this.deployDefaults = deps.deployDefaults ?? WORKER_DEPLOY_DEFAULTS;
  }

  // -------------------------------------------------------------------------
  // bb.background.service entry.
  // -------------------------------------------------------------------------

  /** Runs until `signal` aborts (dispose/reload/disable/shutdown). */
  async start(signal: AbortSignal): Promise<void> {
    this.signal = signal;
    await this.bootstrapFromSettings();

    while (!signal.aborted) {
      await this.sleep(this.healthIntervalMs, signal);
      if (signal.aborted) break;
      try {
        await this.tick();
      } catch (err) {
        // A tick must never crash the service loop; log and carry on.
        this.deps.log.warn(
          `worker-lifecycle tick error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.teardownTunnel();
  }

  // -------------------------------------------------------------------------
  // Public surface used by server.ts.
  // -------------------------------------------------------------------------

  /** Current worker origin (for buildShareUrl), or null if none deployed. A
   * claimed worker's LIVE hostname wins over any temp record. */
  currentWorkerUrl(): string | null {
    return this.claimedUrl ?? this.record?.url ?? null;
  }

  /**
   * Redacted status snapshot for the getWorkerStatus RPC + owner UI + the
   * worker-changed broadcast. Never carries the CF `claim.url` takeover bearer
   * (H1, ticket 20) — that is owner-only via `getClaimUrl()`.
   */
  getStatus(): WorkerStatus {
    const status: WorkerStatus = {
      state: this.state,
      healthy: this.state === "live",
    };
    // Only include `tunnel` once a tunnel state exists. An explicit
    // `tunnel: undefined` is not a JSON value and the bb RPC envelope rejects
    // the whole result — omit the key instead (mirrors url/expiresAt below).
    if (this.tunnelState !== undefined) status.tunnel = this.tunnelState;
    if (this.claimedUrl) {
      // A claimed worker is permanent — surface its live hostname, no expiry.
      status.url = this.claimedUrl;
    } else if (this.record) {
      status.url = this.record.url;
      if (this.record.expiresAt !== null) status.expiresAt = this.record.expiresAt;
    }
    return status;
  }

  /**
   * The CF claim affordance — an account-TAKEOVER bearer (SPEC: "never send to
   * guests, never log"). Owner-only: exposed via the `getClaimUrl` RPC, which
   * the worker denies to guests (M2, ticket 20). Deliberately kept OFF
   * `getStatus()` / the worker-changed broadcast (H1) so the bearer can never
   * ride a channel a guest might observe. Null until a worker is deployed.
   */
  getClaimUrl(): { url: string; expiresAt: number | null } | null {
    return this.record?.claim ?? null;
  }

  // -------------------------------------------------------------------------
  // Cloudflare OAuth (issue 28) — connect / status / disconnect / manage.
  // -------------------------------------------------------------------------

  /** Redacted connection snapshot for the owner UI + connection-changed broadcast. */
  getConnectionStatus(): ConnectionStatus {
    const status: ConnectionStatus = {
      connection: this.connection,
      claimed: this.oauthRecord !== null,
    };
    if (this.oauthRecord) {
      status.accountId = this.oauthRecord.claimedAccountId;
      status.writeGranted = this.oauthRecord.writeGranted;
      if (this.claimedUrl) status.hostname = hostnameOf(this.claimedUrl);
    } else if (this.connection === "connected") {
      status.writeGranted = this.sessionWriteGranted;
    }
    return status;
  }

  /**
   * Start the OAuth connect flow (§11.2). Generates PKCE + state, arms the
   * loopback listener, and returns the authorize URL for the frontend to open
   * in the owner's browser. The code exchange + discovery run in the background
   * on the callback; the UI tracks the outcome via `getConnectionStatus` /
   * the connection-changed broadcast. Throws if the client id is unset.
   */
  async beginCloudflareConnect(): Promise<{ authorizeUrl: string }> {
    if (!this.deps.oauthRecordStore) {
      throw new Error("Cloudflare OAuth is not available in this build");
    }
    const clientId = this.deps.getOAuthClientId?.() ?? "";
    if (!clientId) {
      throw new Error(
        "Cloudflare OAuth client id is not configured — set it in the plugin settings",
      );
    }
    // Cancel any in-flight attempt so a retry never leaves a stale listener.
    this.pendingConnect?.cancel();

    const begin = this.deps.beginConnect ?? defaultBeginConnect;
    const pending = begin({
      clientId,
      port: this.deps.getOAuthCallbackPort?.() ?? 8977,
      client: this.deps.oauthClient,
      fetchImpl: this.deps.fetchImpl,
    });
    this.pendingConnect = pending;
    this.connection = "connecting";
    this.publishConnection();

    // Complete in the background — never blocks the RPC that opened the browser.
    void pending
      .complete()
      .then((tokens) => this.onConnected(tokens))
      .catch((err) => {
        this.deps.log.warn(
          `Cloudflare connect did not complete: ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
        );
        // Roll back to the last durable state (connected if a record exists).
        this.connection = this.oauthRecord ? "connected" : "not-connected";
        this.publishConnection();
      })
      .finally(() => {
        this.pendingConnect = null;
      });

    return { authorizeUrl: pending.authorizeUrl };
  }

  /**
   * Disconnect Cloudflare (§11.4): revoke the refresh token, forget the record,
   * and drop to "not connected". A claimed worker keeps running on CF — the
   * plugin simply stops managing it (the owner can reconnect or delete it in
   * the dashboard). Never throws out to the caller on a revoke hiccup.
   */
  async disconnectCloudflare(): Promise<void> {
    this.pendingConnect?.cancel();
    this.pendingConnect = null;
    const clientId = this.deps.getOAuthClientId?.() ?? "";
    const refresh = this.oauthRecord?.cfRefreshToken ?? this.sessionRefreshToken;
    if (refresh && clientId && this.deps.oauthClient) {
      try {
        await this.deps.oauthClient.revoke({ token: refresh, clientId });
      } catch (err) {
        this.deps.log.warn(
          `Cloudflare token revoke failed (forgetting locally anyway): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await this.deps.oauthRecordStore?.clear();
    this.teardownTunnel();
    this.oauthRecord = null;
    this.claimedUrl = null;
    this.accessToken = null;
    this.accessTokenExpiry = 0;
    this.sessionRefreshToken = null;
    this.sessionWriteGranted = false;
    this.connection = "not-connected";
    this.record = null;
    this.setState("idle");
    this.publishConnection();
  }

  /**
   * Redeploy the claimed worker with fresh code via the OAuth access token
   * (§11.4). Requires a claimed worker and the write scope. Rotates the tunnel
   * secret like a temp redeploy, uploads to the claimed account, and re-attaches
   * the tunnel at the (re-resolved) live hostname.
   */
  async redeployClaimedWorker(): Promise<void> {
    const rec = this.oauthRecord;
    if (!rec) throw new Error("no claimed worker to redeploy");
    if (!rec.writeGranted) {
      throw new Error(
        "redeploy needs the Cloudflare write scope — reconnect and grant it",
      );
    }
    const accessToken = await this.getAccessToken();
    const scriptContent = await this.deps.bundleWorker();
    const tunnelSecret = (this.deps.mintTunnelSecret ?? defaultMintTunnelSecret)();
    const authzToken = await this.deps.getAuthzToken();
    const redeploy = this.deps.redeployClaimedWorker ?? defaultRedeployClaimedWorker;
    const result = await redeploy({
      fetchImpl: this.deps.fetchImpl ?? fetch,
      accessToken,
      accountId: rec.claimedAccountId,
      input: {
        scriptName: rec.scriptName,
        compatibilityDate: this.deployDefaults.compatibilityDate,
        scriptContent,
        tunnelSecret,
        authzToken,
        doClassName: this.deployDefaults.doClassName,
        doBindingName: this.deployDefaults.doBindingName,
        migrationTag: this.deployDefaults.migrationTag,
      },
    });
    const updated: OAuthWorkerRecord = {
      ...rec,
      tunnelSecret,
      lastKnownUrl: result.url,
      deploymentId: result.deploymentId,
      generation: rec.generation + 1,
      deployedAt: this.now(),
    };
    await this.deps.oauthRecordStore?.save(updated);
    this.oauthRecord = updated;
    this.claimedUrl = result.url;
    this.teardownTunnel();
    this.startTunnel(result.url, tunnelSecret);
    this.setState("live");
    this.publish();
  }

  /**
   * Undeploy the claimed worker (§11.4): DELETE the script under the claimed
   * account, forget the record, and drop to "connected but unclaimed". Requires
   * the write scope.
   */
  async undeployClaimedWorker(): Promise<void> {
    const rec = this.oauthRecord;
    if (!rec) throw new Error("no claimed worker to undeploy");
    if (!rec.writeGranted) {
      throw new Error(
        "undeploy needs the Cloudflare write scope — reconnect and grant it",
      );
    }
    const accessToken = await this.getAccessToken();
    const del = this.deps.deleteClaimedWorker ?? defaultDeleteClaimedWorker;
    await del({
      fetchImpl: this.deps.fetchImpl ?? fetch,
      accessToken,
      accountId: rec.claimedAccountId,
      scriptName: rec.scriptName,
    });
    // Keep the OAuth session (refresh token) so the owner stays connected.
    this.sessionRefreshToken = rec.cfRefreshToken;
    this.sessionWriteGranted = rec.writeGranted;
    await this.deps.oauthRecordStore?.clear();
    this.teardownTunnel();
    this.oauthRecord = null;
    this.claimedUrl = null;
    this.record = null;
    this.connection = "connected";
    this.setState("idle");
    this.publish();
    this.publishConnection();
  }

  /**
   * Lazy first-deploy trigger — called from the mintToken handler (SPEC: deploy
   * lazily on first mint). No-op once a worker is live; dedupes concurrent
   * callers; swallows deploy errors so minting a token never fails on a worker
   * hiccup (the health loop retries).
   */
  async ensureDeployed(): Promise<void> {
    // A claimed worker is already serving via the OAuth-adopted tunnel — never
    // provision a throwaway temp worker alongside it (§12A).
    if (this.oauthRecord && this.state === "live") return;
    if (this.record && this.state === "live") return;
    return this.runDeploy();
  }

  /**
   * The single serialized deploy entry (M4, ticket 20). BOTH the lazy
   * `ensureDeployed` path (mintToken) and `tick()`'s health-fail redeploy
   * funnel through here, so at most one deploy is ever in flight: a concurrent
   * `mintToken` + health-fail can no longer provision two temp accounts and
   * orphan a live secret-bearing worker (leaking its SharedTunnel). Swallows
   * deploy errors — `deploy()` already sets the `error` state and logs a
   * redacted reason — so neither caller ever sees a throw (minting a token must
   * not fail on a worker hiccup; a tick must not crash the service loop).
   */
  private runDeploy(): Promise<void> {
    if (this.deployInFlight) return this.deployInFlight;
    this.deployInFlight = this.deploy()
      .catch(() => {
        // deploy() has already logged (redacted) and set state = "error".
      })
      .finally(() => {
        this.deployInFlight = null;
      });
    return this.deployInFlight;
  }

  // -------------------------------------------------------------------------
  // Bootstrap: reuse a healthy persisted worker, else wipe + start fresh.
  // -------------------------------------------------------------------------

  /**
   * The script name a persisted worker was deployed under, read from the first
   * label of its `workers.dev` hostname (`bb-shared.<sub>.workers.dev` →
   * `bb-shared`). Null if the URL is unparseable.
   */
  private deployedScriptName(url: string): string | null {
    try {
      return new URL(url).hostname.split(".")[0] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * True when a persisted worker was deployed under a script name that no longer
   * matches the current default — i.e. the worker was renamed since. Reusing it
   * would keep serving the old name (and, more importantly, the old worker
   * bundle), so we force a wipe + fresh deploy instead.
   */
  private isStaleDeployment(rec: WorkerRecord): boolean {
    const deployed = this.deployedScriptName(rec.url);
    return deployed !== null && deployed !== WORKER_DEPLOY_DEFAULTS.scriptName;
  }

  private async bootstrapFromSettings(): Promise<void> {
    // OAuth-claimed worker takes precedence (§12A): if an OAuth record exists,
    // adopt the claimed worker (refresh → discover → re-attach live). If that
    // fails (deleted in dashboard, revoked token), we fall through to the
    // unchanged temp-worker bootstrap below.
    if (await this.tryAdoptClaimedWorker()) return;

    const rec = await this.deps.recordStore.load();
    if (!rec) {
      this.setState("idle");
      return;
    }
    if (
      this.isExpired(rec) ||
      this.isStaleDeployment(rec) ||
      !(await this.healthCheck(rec.url))
    ) {
      this.deps.log.info(
        this.isStaleDeployment(rec)
          ? `persisted worker was deployed under a stale script name (${this.deployedScriptName(rec.url)} ≠ ${WORKER_DEPLOY_DEFAULTS.scriptName}) — wiping to redeploy`
          : "persisted worker is dead/expired on start — wiping settings",
      );
      await this.deps.recordStore.clear();
      this.record = null;
      this.setState("idle");
      return;
    }
    // Alive → reuse without redeploying. Re-attach the tunnel with the
    // persisted handshake secret (matches the still-live worker's env var).
    this.record = rec;
    this.startTunnel(rec.url, rec.tunnelSecret);
    this.setState("live");
    this.deps.log.info(`reusing healthy worker at ${rec.url}`);
  }

  // -------------------------------------------------------------------------
  // Periodic maintenance (every healthIntervalMs while any token is live).
  // -------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (!(await this.deps.hasTokens())) return; // idle while no shares exist

    // OAuth-claimed worker maintenance (§12A): a claimed worker is managed via
    // the OAuth API and never redeployed as a temp worker. Its own branch.
    if (this.oauthRecord) {
      await this.tickClaimed();
      return;
    }

    // Connected but not yet claimed: the owner connected OAuth before a worker
    // exists under their account. Re-run discovery so a claim completed since
    // connect is adopted without waiting on anything (§12C).
    if (this.connection === "connected") {
      await this.discoverAndAdopt().catch(() => {});
      if (this.oauthRecord) return;
    }

    if (!this.record) {
      // Tokens exist but no worker (e.g. an earlier deploy errored) — bootstrap.
      await this.ensureDeployed();
      return;
    }

    const healthy =
      !this.isExpired(this.record) &&
      !this.isStaleDeployment(this.record) &&
      (await this.healthCheck(this.record.url));
    if (healthy) {
      if (!this.tunnel) this.startTunnel(this.record.url, this.record.tunnelSecret); // re-arm a dropped tunnel
      if (this.state !== "live") this.setState("live");
      return;
    }

    // Health failed → wipe + fresh deploy (SPEC §"Worker lifecycle"). Route
    // through the serialized `runDeploy` (NOT `deploy()` directly) so a
    // concurrent mintToken → ensureDeployed dedupes onto this same deploy
    // rather than provisioning a second temp account (M4, ticket 20).
    this.deps.log.warn("worker health check failed — wiping + redeploying");
    await this.deps.recordStore.clear();
    this.teardownTunnel();
    this.record = null;
    this.setState("unhealthy");
    await this.runDeploy();
  }

  // -------------------------------------------------------------------------
  // Cloudflare OAuth internals (issue 28): adoption, discovery, token refresh.
  // -------------------------------------------------------------------------

  /**
   * On start, adopt a persisted claimed worker (§12A). Returns true when the
   * OAuth path takes over (claimed record exists) so the caller skips the temp
   * bootstrap. A revoked refresh token or a worker deleted in the dashboard
   * wipes the record and returns false → the temp-worker bootstrap resumes.
   */
  private async tryAdoptClaimedWorker(): Promise<boolean> {
    const store = this.deps.oauthRecordStore;
    if (!store) return false;
    const rec = await store.load();
    if (!rec) return false;

    this.oauthRecord = rec;
    this.sessionWriteGranted = rec.writeGranted;
    this.connection = "connected";
    try {
      const resolved = await this.discoverClaimed(rec.cfRefreshToken);
      if (resolved) {
        await this.applyClaimed(rec, resolved);
        this.publishConnection();
        return true;
      }
      // Discovery succeeded but our script is gone → deleted in the dashboard.
      this.deps.log.info(
        "claimed worker not found under the connected account — forgetting it",
      );
      await store.clear();
      this.oauthRecord = null;
      this.claimedUrl = null;
      this.connection = "not-connected";
      this.publishConnection();
      return false;
    } catch (err) {
      const invalid = err instanceof OAuthClientError && err.invalidGrant;
      this.deps.log.warn(
        `could not adopt claimed worker on start: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (invalid) {
        // Refresh token revoked — the record is useless. Wipe and fall back to
        // the temp-worker flow; the claimed worker is a bounded orphan until the
        // owner reconnects (§12C).
        await store.clear();
        this.oauthRecord = null;
        this.claimedUrl = null;
        this.connection = "not-connected";
        this.publishConnection();
        return false;
      }
      // Transient (network/CF) failure: keep the record and stay connected so a
      // later tick retries adoption. Nothing is serving yet.
      this.publishConnection();
      return true;
    }
  }

  /** Refresh an access token from `refreshToken`, then run live discovery. */
  private async discoverClaimed(
    refreshToken: string,
  ): Promise<ResolvedWorker | null> {
    const accessToken = await this.refreshAccessToken(refreshToken);
    const resolve = this.deps.resolveClaimedWorker ?? defaultResolveClaimedWorker;
    return resolve({
      fetchImpl: this.deps.fetchImpl ?? fetch,
      accessToken,
      scriptName: this.oauthRecord?.scriptName ?? CF_WORKER_SCRIPT_NAME,
      tunnelSecret: this.oauthRecord?.tunnelSecret ?? this.record?.tunnelSecret,
      probe: this.deps.tunnelProbe ?? defaultTunnelProbe,
    });
  }

  /**
   * Discover a claimed worker with the CURRENT access token and, if found,
   * persist the §11.5 record and adopt it. Used from onConnected and from a
   * connected-but-unclaimed tick (§12C). No-op when discovery finds nothing.
   */
  private async discoverAndAdopt(): Promise<void> {
    if (this.connection !== "connected") return;
    const accessToken = await this.getAccessToken();
    const tunnelSecret = this.oauthRecord?.tunnelSecret ?? this.record?.tunnelSecret;
    const resolve = this.deps.resolveClaimedWorker ?? defaultResolveClaimedWorker;
    const resolved = await resolve({
      fetchImpl: this.deps.fetchImpl ?? fetch,
      accessToken,
      scriptName: CF_WORKER_SCRIPT_NAME,
      tunnelSecret,
      probe: this.deps.tunnelProbe ?? defaultTunnelProbe,
    });
    if (!resolved) return; // connected, but no claimed worker yet

    const refresh = this.oauthRecord?.cfRefreshToken ?? this.sessionRefreshToken;
    if (!refresh) return; // no refresh token to persist — cannot claim durably
    if (!tunnelSecret) {
      // We found the worker but do not know its TUNNEL_SECRET (e.g. a fresh
      // session with no in-memory temp record), so we cannot re-dial its tunnel.
      // A write-scoped redeploy would establish a fresh secret; leave connected-
      // but-unclaimed and let the owner redeploy.
      this.deps.log.warn(
        "claimed worker found but its tunnel secret is unknown — redeploy to adopt it",
      );
      return;
    }

    const rec: OAuthWorkerRecord = this.oauthRecord
      ? {
          ...this.oauthRecord,
          claimedAccountId: resolved.accountId,
          lastKnownUrl: resolved.url,
        }
      : {
          claimed: true,
          cfRefreshToken: refresh,
          claimedAccountId: resolved.accountId,
          scriptName: CF_WORKER_SCRIPT_NAME,
          tunnelSecret,
          writeGranted: this.sessionWriteGranted,
          lastKnownUrl: resolved.url,
          deploymentId: this.record?.deploymentId ?? CF_WORKER_SCRIPT_NAME,
          generation: this.record?.generation ?? 0,
          deployedAt: this.record?.deployedAt ?? this.now(),
          claimedAt: this.now(),
        };
    await this.deps.oauthRecordStore?.save(rec);
    // The temp record (dead temp apiToken/accountId) is now stale — drop it so a
    // future restart never tries to reuse it.
    await this.deps.recordStore.clear();
    await this.applyClaimed(rec, resolved);
    this.publishConnection();
  }

  /** Completion callback for the browser connect flow (§11.2 step 5-6). */
  private async onConnected(tokens: OAuthTokenResponse): Promise<void> {
    this.connection = "connected";
    this.accessToken = tokens.accessToken;
    this.accessTokenExpiry =
      this.now() + (tokens.expiresInSeconds ?? 0) * 1000;
    this.sessionWriteGranted = grantedWrite(tokens.scope, CF_SCOPES.scriptsWrite);
    if (tokens.refreshToken) this.sessionRefreshToken = tokens.refreshToken;
    this.publishConnection();
    await this.discoverAndAdopt();
  }

  /** Periodic maintenance for an adopted claimed worker (§12A). */
  private async tickClaimed(): Promise<void> {
    const rec = this.oauthRecord;
    if (!rec) return;
    if (this.claimedUrl && (await this.healthCheck(this.claimedUrl))) {
      if (!this.tunnel) this.startTunnel(this.claimedUrl, rec.tunnelSecret);
      if (this.state !== "live") this.setState("live");
      return;
    }
    // Unhealthy or not yet attached → re-resolve the live hostname via OAuth.
    try {
      const resolved = await this.discoverClaimed(rec.cfRefreshToken);
      if (resolved) {
        await this.applyClaimed(
          { ...rec, claimedAccountId: resolved.accountId },
          resolved,
        );
        return;
      }
      // Gone from CF → the owner deleted it in the dashboard (§12A/§12C).
      this.deps.log.warn(
        "claimed worker gone from Cloudflare — forgetting it and re-bootstrapping",
      );
      await this.deps.oauthRecordStore?.clear();
      this.teardownTunnel();
      this.oauthRecord = null;
      this.claimedUrl = null;
      this.connection = "connected"; // still connected, just unclaimed now
      this.setState("idle");
      this.publishConnection();
    } catch (err) {
      if (err instanceof OAuthClientError && err.invalidGrant) {
        // Refresh revoked mid-session: drop to not-connected but keep serving
        // via the live tunnel if one is up (§12A).
        this.deps.log.warn(
          "Cloudflare refresh revoked — dropping to not-connected",
        );
        this.connection = "not-connected";
        this.publishConnection();
        return;
      }
      this.deps.log.warn(
        `claimed worker re-resolve failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Adopt a resolved claimed worker: re-attach the tunnel at the LIVE host. */
  private async applyClaimed(
    baseRec: OAuthWorkerRecord,
    resolved: ResolvedWorker,
  ): Promise<void> {
    // Base on the CURRENT in-memory record when present: a refresh during
    // discovery may have rotated `cfRefreshToken` into it, and we must not
    // clobber the rotation with the stale record the caller loaded.
    let rec = this.oauthRecord ?? baseRec;
    // Persist a hostname change so `lastKnownUrl` stays a useful cache.
    if (rec.lastKnownUrl !== resolved.url || rec.claimedAccountId !== resolved.accountId) {
      rec = { ...rec, lastKnownUrl: resolved.url, claimedAccountId: resolved.accountId };
      await this.deps.oauthRecordStore?.save(rec);
    }
    this.oauthRecord = rec;
    this.claimedUrl = resolved.url;
    this.record = null;
    this.teardownTunnel();
    this.startTunnel(resolved.url, rec.tunnelSecret);
    this.setState("live");
    this.deps.log.info(`adopted claimed worker at ${resolved.url}`);
  }

  /**
   * Return a valid access token, refreshing from the current refresh token when
   * the cached one is missing or within 30 s of expiry. Rotation is persisted.
   */
  private async getAccessToken(): Promise<string> {
    const margin = 30_000;
    if (this.accessToken && this.now() < this.accessTokenExpiry - margin) {
      return this.accessToken;
    }
    const refresh = this.oauthRecord?.cfRefreshToken ?? this.sessionRefreshToken;
    if (!refresh) throw new Error("not connected to Cloudflare");
    return this.refreshAccessToken(refresh);
  }

  /**
   * Exchange a refresh token for a new access token, applying refresh-token
   * ROTATION (RFC 6749 §6): if CF returns a new refresh token, persist it (into
   * the claimed record when one exists, else the session token). Throws
   * OAuthClientError{invalidGrant} when the refresh token is revoked.
   */
  private async refreshAccessToken(refreshToken: string): Promise<string> {
    const client = this.deps.oauthClient;
    const clientId = this.deps.getOAuthClientId?.() ?? "";
    if (!client) throw new Error("Cloudflare OAuth client is not configured");
    const tokens = await client.refresh({ refreshToken, clientId });
    this.accessToken = tokens.accessToken;
    this.accessTokenExpiry =
      this.now() + (tokens.expiresInSeconds ?? 0) * 1000;
    if (tokens.scope) {
      this.sessionWriteGranted = grantedWrite(tokens.scope, CF_SCOPES.scriptsWrite);
    }
    const rotated = applyRefreshRotation(refreshToken, tokens);
    if (this.oauthRecord) {
      if (rotated !== this.oauthRecord.cfRefreshToken) {
        this.oauthRecord = { ...this.oauthRecord, cfRefreshToken: rotated };
        await this.deps.oauthRecordStore?.save(this.oauthRecord);
      }
    } else {
      this.sessionRefreshToken = rotated;
    }
    return tokens.accessToken;
  }

  private publishConnection(): void {
    try {
      this.deps.publishConnection?.(this.getConnectionStatus());
    } catch (err) {
      this.deps.log.warn(
        `failed to publish connection status: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Deploy / redeploy — mint secret, bundle, deploy to CF, persist, (re)tunnel.
  // -------------------------------------------------------------------------

  private async deploy(): Promise<void> {
    const prevGeneration = this.record?.generation ?? -1;
    this.setState("deploying");
    try {
      const scriptContent = await this.deps.bundleWorker();
      const tunnelSecret = (this.deps.mintTunnelSecret ?? defaultMintTunnelSecret)();
      const authzToken = await this.deps.getAuthzToken();

      const deployFn = this.deps.deployWorker ?? defaultDeployWorker;
      const result = await deployFn(
        {
          scriptName: this.deployDefaults.scriptName,
          compatibilityDate: this.deployDefaults.compatibilityDate,
          scriptContent,
          tunnelSecret,
          authzToken,
          doClassName: this.deployDefaults.doClassName,
          doBindingName: this.deployDefaults.doBindingName,
          migrationTag: this.deployDefaults.migrationTag,
        },
        { fetchImpl: this.deps.fetchImpl, log: this.deps.log },
      );

      const record: WorkerRecord = {
        deploymentId: result.deploymentId,
        url: result.url,
        accountId: result.accountId,
        apiToken: result.apiToken,
        expiresAt: result.expiresAt,
        tunnelSecret,
        claim: result.claim,
        deployedAt: this.now(),
        generation: prevGeneration + 1,
      };
      await this.deps.recordStore.save(record);

      // Rotate the tunnel: stop the old one, dial the new worker with the
      // freshly-minted secret.
      this.teardownTunnel();
      this.record = record;
      this.startTunnel(record.url, record.tunnelSecret);
      this.setState("live");
      this.deps.log.info(`worker deployed at ${record.url}`);
    } catch (err) {
      // Redact before logging: a CF SDK error may embed the tunnel secret /
      // authz token from the upload request body (M3, ticket 20).
      this.deps.log.error(
        `worker deploy failed: ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
      );
      this.setState("error");
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // SharedTunnel management.
  // -------------------------------------------------------------------------

  private startTunnel(url: string, tunnelSecret: string): void {
    const opts: SharedTunnelOptions = {
      workerUrl: url,
      tunnelSecret,
      loopbackBaseUrl: this.deps.getLoopbackBaseUrl(),
      log: this.deps.log,
      onStatusChange: (s) => {
        this.tunnelState = s;
        this.publish();
      },
    };
    const tunnel = (this.deps.createTunnel ?? ((o) => new SharedTunnel(o)))(opts);
    this.tunnel = tunnel;
    tunnel.start();
  }

  private teardownTunnel(): void {
    this.tunnel?.stop();
    this.tunnel = null;
    this.tunnelState = undefined;
  }

  // -------------------------------------------------------------------------
  // Health + helpers.
  // -------------------------------------------------------------------------

  private isExpired(rec: WorkerRecord): boolean {
    return rec.expiresAt !== null && this.now() >= rec.expiresAt;
  }

  /**
   * Liveness probe (worker/README.md): a live worker answers `GET /` (no token)
   * with 401 `token_missing` — the script ran, so it is deployed and reachable.
   *
   * L2 (ticket 21): sharpened from "any non-throwing response is alive" to
   * "alive iff status < 500". A broken or hostile proxy answering 502/503 at the
   * worker URL — or a captive portal / on-path MITM returning a 5xx error page
   * (see L3, no TLS pinning) — must NOT count as "worker OK", or the plugin
   * suppresses the wipe-and-redeploy that would rotate away from a dead/hostile
   * endpoint. So a 5xx (and any network failure / timeout) → unhealthy.
   *
   * We deliberately accept ANY sub-500 status rather than only 2xx, because the
   * worker's real liveness signal for this probe is a 401, not a 200: requiring
   * `response.ok` would mark every live worker dead and spin the redeploy loop
   * forever. Sub-500 keeps the 401 signal healthy while still rejecting the
   * broken-proxy 5xx this finding is about (and stays robust if `GET /` ever
   * serves a real 2xx once the guest proxy is wired up).
   */
  private async healthCheck(url: string): Promise<boolean> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.healthTimeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(new URL("/", url).toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
      return response.status < 500;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private setState(next: WorkerState): void {
    if (this.state === next) {
      this.publish();
      return;
    }
    this.state = next;
    this.publish();
  }

  private publish(): void {
    try {
      this.deps.publishStatus(this.getStatus());
    } catch (err) {
      this.deps.log.warn(
        `failed to publish worker status: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      timer.unref?.();
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** Host portion of a URL, for the connection status (non-secret). */
function hostnameOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
