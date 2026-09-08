import { randomBytes, randomUUID } from "node:crypto";
import { PROTOCOL_VERSION } from "@bb-shared/tunnel-contract";
import { SharedTunnel, type SharedTunnelOptions, type TunnelState, type TunnelStatus } from "../lib/shared-tunnel";
import { deployWorker, redactSecrets } from "./cf-deploy";
import { mintTunnelSecret } from "./tunnel-secret";
import { normalizeConnectionUrl, type ConnectionRecord, type ConnectionSnapshot } from "./worker-record";

export const WORKER_DEPLOY_DEFAULTS = { scriptName: "bb-shared", compatibilityDate: "2025-06-01", doClassName: "TunnelDO", doBindingName: "TUNNEL_DO", migrationTag: "v1" } as const;
export type ConnectionState = "connecting" | "ready" | "offline" | "incompatible";
export interface ConnectionStatus { id: string; url: string; state: ConnectionState; isDefault: boolean; tunnel?: TunnelState; fault?: string; }
export interface TunnelLike { start(): void; stop(): void; getStatus(): TunnelStatus; }
export interface WorkerLifecycleDeps {
  recordStore: { load(): Promise<ConnectionSnapshot>; save(value: ConnectionSnapshot): Promise<void> };
  log: SharedTunnelOptions["log"];
  publishStatus: () => void;
  getGatewayBaseUrl: () => string;
  verifyReadiness: (challenge: string, response: unknown) => boolean;
  bundleWorker: () => Promise<string>;
  deployWorker?: typeof deployWorker;
  createTunnel?: (options: SharedTunnelOptions) => TunnelLike;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  readyTimeoutMs?: number;
  probeIntervalMs?: number;
}
interface Runtime {
  record: ConnectionRecord;
  state: ConnectionState;
  fault?: string;
  tunnel?: TunnelLike;
  probe?: Promise<void>;
  generation: number;
}

/** Connections are observed independently of Cloudflare ownership or claim status. */
export class WorkerLifecycle {
  private readonly connections = new Map<string, Runtime>();
  private readonly candidates = new Set<Runtime>();
  private defaultId: string | null = null;
  private initialization?: Promise<void>;
  private mutations: Promise<unknown> = Promise.resolve();
  private readonly abort = new AbortController();
  constructor(private readonly deps: WorkerLifecycleDeps) {}

  async initialize(): Promise<void> {
    this.initialization ??= (async () => {
      const snapshot = await this.deps.recordStore.load();
      this.defaultId = snapshot.defaultId;
      for (const record of snapshot.connections) {
        const runtime: Runtime = { record, state: "connecting", generation: 0 };
        this.connections.set(record.id, runtime);
        this.connect(runtime);
      }
    })();
    return this.initialization;
  }
  async start(signal: AbortSignal): Promise<void> {
    const stop = () => this.stop();
    signal.addEventListener("abort", stop, { once: true });
    try {
      if (signal.aborted) return;
      await this.initialize();
      while (!signal.aborted && !this.abort.signal.aborted) {
        await this.sleep(this.deps.intervalMs ?? 15_000);
        if (signal.aborted || this.abort.signal.aborted) break;
        await Promise.all([...this.connections.values()].map(runtime => this.probe(runtime)));
      }
    } finally {
      signal.removeEventListener("abort", stop);
      this.stop();
    }
  }
  stop(): void {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    for (const runtime of [...this.connections.values(), ...this.candidates]) runtime.tunnel?.stop();
  }
  currentWorkerUrl(): string | null { return this.connections.get(this.defaultId ?? "")?.record.url ?? null; }
  listConnections(): ConnectionStatus[] {
    return [...this.connections.values()].map(runtime => ({
      id: runtime.record.id, url: runtime.record.url, state: runtime.state,
      isDefault: runtime.record.id === this.defaultId,
      ...(runtime.tunnel ? {tunnel: runtime.tunnel.getStatus().state} : {}),
      ...(runtime.fault === undefined ? {} : {fault: runtime.fault}),
    }));
  }
  getClaimUrl(id: string): ConnectionRecord["claim"] {
    const claim = this.connections.get(id)?.record.claim;
    return claim && (claim.expiresAt === null || claim.expiresAt > Date.now()) ? claim : null;
  }
  async ensureDeployed(): Promise<void> {
    return this.mutate(async () => {
      if (this.connections.size === 0) await this.deploy();
    });
  }
  async deployConnection(): Promise<void> { return this.mutate(() => this.deploy()); }
  async registerConnection(url: string, tunnelSecret: string): Promise<void> {
    return this.mutate(() => this.register(url, tunnelSecret, null));
  }
  async removeConnection(id: string): Promise<void> {
    return this.mutate(async () => {
      const runtime = this.requireConnection(id);
      const next = [...this.connections.values()].filter(r => r !== runtime).map(r => r.record);
      const defaultId = this.defaultId === id ? next[0]?.id ?? null : this.defaultId;
      await this.save(next, defaultId);
      this.connections.delete(id);
      this.defaultId = defaultId;
      runtime.tunnel?.stop();
      this.publish();
    });
  }
  async setDefaultConnection(id: string): Promise<void> {
    return this.mutate(async () => {
      this.requireConnection(id);
      await this.save([...this.connections.values()].map(r => r.record), id);
      this.defaultId = id;
      this.publish();
    });
  }
  private requireConnection(id: string): Runtime {
    const connection = this.connections.get(id);
    if (!connection) throw new Error("Connection not found.");
    return connection;
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(async () => {
      await this.initialize();
      if (this.abort.signal.aborted) throw new Error("Sharing is stopping. Try again after the plugin reloads.");
      return operation();
    });
    this.mutations = result.catch(() => {});
    return result;
  }
  private async deploy(): Promise<void> {
    if (this.connections.size >= 16) throw new Error("Remove an unused connection before adding another.");
    const secret = mintTunnelSecret();
    const result = await (this.deps.deployWorker ?? deployWorker)({
      ...WORKER_DEPLOY_DEFAULTS, scriptContent: await this.deps.bundleWorker(), tunnelSecret: secret,
    }, { fetchImpl: this.deps.fetchImpl, log: this.deps.log });
    await this.register(result.url, secret, result.claim);
  }
  private async identity(url: string): Promise<string> {
    const response = await this.fetch(new URL("/__bb_shared/relay", url));
    const identity = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || identity?.service !== "bb-shared-relay" || identity.version !== 1
      || identity.protocolVersion !== PROTOCOL_VERSION || typeof identity.relayId !== "string" || !identity.relayId || identity.relayId.length > 128) {
      throw new Error("This hostname does not serve a compatible BB Shared relay. Deploy the current relay before connecting.");
    }
    return identity.relayId;
  }
  private async register(input: string, tunnelSecret: string, claim: ConnectionRecord["claim"]): Promise<void> {
    const url = normalizeConnectionUrl(input);
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(tunnelSecret)) throw new Error("Enter the relay's pairing secret (32–256 base64url characters).");
    if (this.connections.size >= 16) throw new Error("Remove an unused connection before adding another.");
    if ([...this.connections.values()].some(r => r.record.url === url)) throw new Error("This hostname is already registered.");
    const relayId = await this.identity(url);
    if ([...this.connections.values()].some(r => r.record.relayId === relayId)) {
      throw new Error("This relay is already connected through another hostname. Remove that connection before changing its hostname.");
    }
    const record: ConnectionRecord = { id: randomUUID(), relayId, url, tunnelSecret, claim, createdAt: Date.now() };
    const runtime: Runtime = { record, state: "connecting", generation: 0 };
    this.candidates.add(runtime);
    try {
      this.connect(runtime);
      const deadline = Date.now() + (this.deps.readyTimeoutMs ?? 30_000);
      while (Date.now() < deadline && !this.abort.signal.aborted) {
        await this.probe(runtime);
        if (runtime.state === "ready") break;
        if (["stopped", "incompatible"].includes(runtime.tunnel?.getStatus().state ?? "")) throw new Error(runtime.fault ?? "Relay pairing failed. Check the pairing secret.");
        await this.sleep(this.deps.probeIntervalMs ?? 250);
      }
      if (runtime.state !== "ready" || this.abort.signal.aborted) throw new Error(runtime.fault ?? "The relay did not establish a working connection to BB. Check the hostname and pairing secret, then retry.");
      const defaultId = this.defaultId ?? record.id;
      await this.save([...this.connections.values()].map(r => r.record).concat(record), defaultId);
      if (this.abort.signal.aborted) throw new Error("Sharing stopped while registering the connection.");
      this.connections.set(record.id, runtime);
      this.defaultId = defaultId;
      this.publish();
    } catch (error) {
      runtime.tunnel?.stop();
      throw new Error(redactSecrets(error instanceof Error ? error.message : String(error)));
    } finally { this.candidates.delete(runtime); }
  }
  private connect(runtime: Runtime): void {
    if (this.abort.signal.aborted) return;
    runtime.tunnel = (this.deps.createTunnel ?? (options => new SharedTunnel(options)))({
      workerUrl: runtime.record.url, tunnelSecret: runtime.record.tunnelSecret,
      loopbackBaseUrl: this.deps.getGatewayBaseUrl(), log: this.deps.log,
      onStatusChange: state => {
        runtime.generation++;
        runtime.state = state === "incompatible" ? "incompatible" : state === "stopped" || state === "reconnecting" || state === "disconnected" ? "offline" : "connecting";
        runtime.fault = state === "connected" || state === "connecting" ? undefined : runtime.tunnel?.getStatus().lastError ?? "Connection to relay interrupted; reconnecting.";
        this.publish();
        if (state === "connected") void this.probe(runtime);
      },
    });
    runtime.tunnel.start();
  }
  private probe(runtime: Runtime): Promise<void> {
    if (runtime.probe) return runtime.probe;
    if (this.abort.signal.aborted || runtime.tunnel?.getStatus().state !== "connected") return Promise.resolve();
    const generation = runtime.generation;
    runtime.probe = (async () => {
      try {
        const challenge = randomBytes(24).toString("base64url");
        const url = new URL("/__bb_shared/ready", runtime.record.url);
        url.searchParams.set("challenge", challenge);
        const response = await this.fetch(url);
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok || !this.deps.verifyReadiness(challenge, body)) throw new Error(`Guest gateway readiness failed (HTTP ${response.status}).`);
        if (runtime.generation !== generation || this.abort.signal.aborted) return;
        runtime.state = "ready";
        runtime.fault = undefined;
      } catch (error) {
        if (runtime.generation !== generation || this.abort.signal.aborted) return;
        runtime.state = "offline";
        runtime.fault = redactSecrets(error instanceof Error ? error.message : "Guest gateway is unavailable.");
      }
      this.publish();
    })().finally(() => { runtime.probe = undefined; });
    return runtime.probe;
  }
  private async save(connections: ConnectionRecord[], defaultId: string | null): Promise<void> {
    await this.deps.recordStore.save({ version: 1, defaultId, connections: connections.map(record => ({
      ...record, claim: record.claim?.expiresAt !== null && (record.claim?.expiresAt ?? Infinity) <= Date.now() ? null : record.claim,
    })) });
  }
  private fetch(url: URL): Promise<Response> {
    return (this.deps.fetchImpl ?? fetch)(url.toString(), { redirect: "manual", cache: "no-store", signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(8_000)]) });
  }
  private publish(): void { if (!this.abort.signal.aborted) this.deps.publishStatus(); }
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      if (this.abort.signal.aborted) return resolve();
      const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, ms);
      this.abort.signal.addEventListener("abort", done, { once: true });
    });
  }
}
