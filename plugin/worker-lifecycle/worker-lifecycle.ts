import type { PluginLogger } from "@get-bb/plugin-sdk";
import { SharedTunnel, type SharedTunnelOptions, type TunnelState } from "../lib/shared-tunnel";
import { deployWorker as defaultDeployWorker, redactSecrets } from "./cf-deploy";
import { mintTunnelSecret as defaultMintTunnelSecret } from "./tunnel-secret";
import type { WorkerRecord, WorkerRecordStore } from "./worker-record";

export type WorkerState = "idle" | "deploying" | "live" | "offline";
export interface WorkerStatus { url?: string; state: WorkerState; healthy: boolean; tunnel?: TunnelState; fault?: string; }
export const WORKER_DEPLOY_DEFAULTS = { scriptName: "bb-shared", compatibilityDate: "2025-06-01", doClassName: "TunnelDO", doBindingName: "TUNNEL_DO", migrationTag: "v1" } as const;
export interface TunnelLike { start(): void; stop(): void; }
export interface WorkerLifecycleDeps {
  recordStore: WorkerRecordStore; log: PluginLogger; publishStatus: (status: WorkerStatus) => void;
  getLoopbackBaseUrl: () => string; getAuthzToken: () => Promise<string>;
  /** Retained for compatibility; probes intentionally run even with no shares. */ hasTokens: () => Promise<boolean>;
  bundleWorker: () => Promise<string>; deployWorker?: typeof defaultDeployWorker;
  mintTunnelSecret?: () => string; createTunnel?: (opts: SharedTunnelOptions) => TunnelLike;
  fetchImpl?: typeof fetch; now?: () => number; healthTimeoutMs?: number; healthIntervalMs?: number;
  deployDefaults?: typeof WORKER_DEPLOY_DEFAULTS;
}

/**
 * A preservation-first owner worker lifecycle. A saved endpoint is never
 * inferred to be replaceable: failures mean Offline and are probed again.
 * `recreateWorker` is the sole path that may create a second temporary account.
 */
export class WorkerLifecycle {
  private readonly now: () => number; private readonly healthTimeoutMs: number; private readonly healthIntervalMs: number;
  private readonly deployDefaults: typeof WORKER_DEPLOY_DEFAULTS;
  private record: WorkerRecord | null = null; private state: WorkerState = "idle"; private tunnel: TunnelLike | null = null;
  private tunnelState: TunnelState | undefined; private fault: string | undefined; private recreateInFlight: Promise<void> | null = null;
  private recoveryRequired = false;
  constructor(private readonly deps: WorkerLifecycleDeps) {
    this.now = deps.now ?? (() => Date.now()); this.healthTimeoutMs = deps.healthTimeoutMs ?? 10_000;
    this.healthIntervalMs = deps.healthIntervalMs ?? 60_000; this.deployDefaults = deps.deployDefaults ?? WORKER_DEPLOY_DEFAULTS;
  }
  async start(signal: AbortSignal): Promise<void> {
    await this.bootstrap();
    while (!signal.aborted) { await this.sleep(this.healthIntervalMs, signal); if (!signal.aborted) await this.tick().catch((err) => this.warn(`worker-lifecycle tick error: ${String(err)}`)); }
    this.teardownTunnel();
  }
  currentWorkerUrl(): string | null { return this.record?.url ?? null; }
  getStatus(): WorkerStatus {
    const status: WorkerStatus = { state: this.state, healthy: this.state === "live" };
    if (this.record) status.url = this.record.url;
    if (this.tunnelState !== undefined) status.tunnel = this.tunnelState;
    if (this.fault) status.fault = this.fault;
    return status;
  }
  /** Claim completion happens outside bb-shared; expired bearer links are hidden. */
  getClaimUrl(): { url: string; expiresAt: number | null } | null {
    const claim = this.record?.claim;
    return claim && (claim.expiresAt === null || claim.expiresAt > this.now()) ? claim : null;
  }
  async ensureDeployed(): Promise<void> {
    // First share may provision only when durable storage is genuinely empty.
    if (this.record || this.recoveryRequired) return;
    await this.recreateWorker();
  }
  async recreateWorker(): Promise<void> {
    if (this.recreateInFlight) return this.recreateInFlight;
    this.recreateInFlight = this.provisionReplacement().finally(() => { this.recreateInFlight = null; });
    return this.recreateInFlight;
  }
  private async bootstrap(): Promise<void> {
    this.record = await this.deps.recordStore.load(); this.recoveryRequired = await this.deps.recordStore.requiresRecovery();
    if (!this.record) { this.setState(this.recoveryRequired ? "offline" : "idle", this.recoveryRequired ? "Saved worker data needs manual recovery" : undefined); return; }
    if (await this.healthCheck(this.record.url)) { this.startTunnel(this.record.url, this.record.tunnelSecret); this.setState("live"); }
    else this.setState("offline", "Worker is offline. It will be checked again; use Recreate worker to replace it.");
  }
  private async tick(): Promise<void> {
    // Do not gate recovery on shares: an owner needs an accurate state after a restart.
    if (!this.record) return;
    if (await this.healthCheck(this.record.url)) {
      if (!this.tunnel) this.startTunnel(this.record.url, this.record.tunnelSecret);
      if (this.state !== "live") this.setState("live");
      return;
    }
    this.setState("offline", "Worker is offline. It will be checked again; use Recreate worker to replace it.");
  }
  private async provisionReplacement(): Promise<void> {
    const prior = this.record; const generation = (prior?.generation ?? -1) + 1;
    this.setState("deploying");
    try {
      const [scriptContent, authzToken] = await Promise.all([this.deps.bundleWorker(), this.deps.getAuthzToken()]);
      const tunnelSecret = (this.deps.mintTunnelSecret ?? defaultMintTunnelSecret)();
      const result = await (this.deps.deployWorker ?? defaultDeployWorker)({ scriptName: this.deployDefaults.scriptName, compatibilityDate: this.deployDefaults.compatibilityDate, scriptContent, tunnelSecret, authzToken, doClassName: this.deployDefaults.doClassName, doBindingName: this.deployDefaults.doBindingName, migrationTag: this.deployDefaults.migrationTag }, { fetchImpl: this.deps.fetchImpl, log: this.deps.log });
      // apiToken is strictly provisioning-only and deliberately never enters WorkerRecord.
      const next: WorkerRecord = { deploymentId: result.deploymentId, url: result.url, tunnelSecret, claim: result.claim, deployedAt: this.now(), generation };
      await this.deps.recordStore.save(next); // durable save happens before the old endpoint is disturbed
      this.teardownTunnel(); this.record = next; this.recoveryRequired = false; this.startTunnel(next.url, next.tunnelSecret); this.setState("live");
      this.deps.log.info(`worker provisioned at ${next.url}`);
    } catch (err) {
      this.record = prior; this.setState("offline", "Recreate worker failed; the previous worker record was kept.");
      this.deps.log.error(`worker recreate failed: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
      throw err;
    }
  }
  private startTunnel(url: string, tunnelSecret: string): void {
    let tunnel: TunnelLike;
    tunnel = (this.deps.createTunnel ?? ((opts) => new SharedTunnel(opts)))({ workerUrl: url, tunnelSecret, loopbackBaseUrl: this.deps.getLoopbackBaseUrl(), log: this.deps.log, onStatusChange: (state) => {
      this.tunnelState = state;
      // Connecting/reconnecting are normal and never trigger replacement. A stopped tunnel is actionable.
      if (state === "stopped") { if (this.tunnel === tunnel) this.tunnel = null; this.setState("offline", "Tunnel stopped. Check the local server, then use Recreate worker only if replacement is needed."); } else this.publish();
    }});
    this.tunnel = tunnel; tunnel.start();
  }
  private teardownTunnel(): void { this.tunnel?.stop(); this.tunnel = null; this.tunnelState = undefined; }
  /** Exact identity probe: a CF 404 HTML page and arbitrary 4xx must never look healthy. */
  private async healthCheck(url: string): Promise<boolean> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.healthTimeoutMs); timer.unref?.();
    try {
      const response = await (this.deps.fetchImpl ?? fetch)(new URL("/", url).toString(), { method: "GET", redirect: "manual", signal: controller.signal });
      if (response.status !== 401) return false;
      const body: unknown = await response.json().catch(() => null);
      return !!body && typeof body === "object" && (body as { error?: unknown }).error === "token_missing";
    } catch { return false; } finally { clearTimeout(timer); }
  }
  private setState(next: WorkerState, fault?: string): void { this.state = next; this.fault = fault; this.publish(); }
  private publish(): void { try { this.deps.publishStatus(this.getStatus()); } catch (err) { this.warn(`failed to publish worker status: ${String(err)}`); } }
  private warn(message: string): void { this.deps.log.warn(message); }
  private sleep(ms: number, signal: AbortSignal): Promise<void> { return new Promise((resolve) => { if (signal.aborted) return resolve(); const timer = setTimeout(done, ms); timer.unref?.(); const onAbort = () => { clearTimeout(timer); done(); }; function done() { signal.removeEventListener("abort", onAbort); resolve(); } signal.addEventListener("abort", onAbort, { once: true }); }); }
}
