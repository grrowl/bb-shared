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
// Deploy-time constants — mirror worker/wrangler.toml + worker/README.md.
// ---------------------------------------------------------------------------

export const WORKER_DEPLOY_DEFAULTS = {
  scriptName: "bb-shared-worker",
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

  /** Current worker origin (for buildShareUrl), or null if none deployed. */
  currentWorkerUrl(): string | null {
    return this.record?.url ?? null;
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
      tunnel: this.tunnelState,
    };
    if (this.record) {
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

  /**
   * Lazy first-deploy trigger — called from the mintToken handler (SPEC: deploy
   * lazily on first mint). No-op once a worker is live; dedupes concurrent
   * callers; swallows deploy errors so minting a token never fails on a worker
   * hiccup (the health loop retries).
   */
  async ensureDeployed(): Promise<void> {
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

  private async bootstrapFromSettings(): Promise<void> {
    const rec = await this.deps.recordStore.load();
    if (!rec) {
      this.setState("idle");
      return;
    }
    if (this.isExpired(rec) || !(await this.healthCheck(rec.url))) {
      this.deps.log.info(
        "persisted worker is dead/expired on start — wiping settings",
      );
      await this.deps.recordStore.clear();
      this.record = null;
      this.setState("idle");
      return;
    }
    // Alive → reuse without redeploying. Re-attach the tunnel with the
    // persisted handshake secret (matches the still-live worker's env var).
    this.record = rec;
    this.startTunnel(rec);
    this.setState("live");
    this.deps.log.info(`reusing healthy worker at ${rec.url}`);
  }

  // -------------------------------------------------------------------------
  // Periodic maintenance (every healthIntervalMs while any token is live).
  // -------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (!(await this.deps.hasTokens())) return; // idle while no shares exist

    if (!this.record) {
      // Tokens exist but no worker (e.g. an earlier deploy errored) — bootstrap.
      await this.ensureDeployed();
      return;
    }

    const healthy =
      !this.isExpired(this.record) && (await this.healthCheck(this.record.url));
    if (healthy) {
      if (!this.tunnel) this.startTunnel(this.record); // re-arm a dropped tunnel
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
      this.startTunnel(record);
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

  private startTunnel(record: WorkerRecord): void {
    const opts: SharedTunnelOptions = {
      workerUrl: record.url,
      tunnelSecret: record.tunnelSecret,
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
