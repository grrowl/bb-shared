import { describe, expect, it } from "vitest";
import { InMemoryKeyProvider } from "../lib/device-key";
import { encryptRecord } from "../lib/device-key/record-crypto";
import { createWorkerRecordStore, type RecordKv, type WorkerRecord } from "./worker-record";
import { WorkerLifecycle, type TunnelLike, type WorkerLifecycleDeps } from "./worker-lifecycle";
import type { DeployResult } from "./cf-deploy";

const URL = "https://bb-shared.example.workers.dev";
const SECRET = "a".repeat(43);
const CLAIM = "https://dash.cloudflare.com/claim-preview?claimToken=abc";
function record(overrides: Partial<WorkerRecord> = {}): WorkerRecord { return { deploymentId: "d", url: URL, tunnelSecret: SECRET, claim: { url: CLAIM, expiresAt: 2_000 }, deployedAt: 1, generation: 0, ...overrides }; }
function kv(): RecordKv & { store: Map<string, unknown> } { const store = new Map<string, unknown>(); return { store, get: async <T>(key: string) => store.get(key) as T, set: async (key, value) => { store.set(key, value); }, delete: async key => { store.delete(key); } }; }
function harness(opts: { healthy?: boolean; body?: unknown; status?: number; deployFail?: boolean } = {}) {
  const store = kv(); let healthy = opts.healthy ?? true; let deploys = 0; const tunnelOptions: Array<{ onStatusChange?: (s: "stopped") => void }> = [];
  const deps: WorkerLifecycleDeps = {
    recordStore: createWorkerRecordStore(store), log: { debug() {}, info() {}, warn() {}, error() {} }, publishStatus() {}, getLoopbackBaseUrl: () => "http://127.0.0.1:1", getAuthzToken: async () => "auth", hasTokens: async () => false, bundleWorker: async () => "script", now: () => 1_000,
    fetchImpl: (async () => healthy ? new Response(JSON.stringify(opts.body ?? { error: "token_missing" }), { status: opts.status ?? 401 }) : new Response(opts.body as string ?? "<html>gone</html>", { status: opts.status ?? 404 })) as typeof fetch,
    createTunnel: (options) => { tunnelOptions.push(options as unknown as { onStatusChange?: (s: "stopped") => void }); return { start() {}, stop() {} } satisfies TunnelLike; },
    mintTunnelSecret: () => SECRET,
    deployWorker: async () => { deploys++; if (opts.deployFail) throw new Error("nope"); return { url: URL, deploymentId: `d${deploys}`, accountId: "temporary", apiToken: "provisioning-only", expiresAt: 1, claim: { url: CLAIM, expiresAt: 2_000 } } satisfies DeployResult; },
  };
  return { store, lifecycle: new WorkerLifecycle(deps), get deploys() { return deploys; }, setHealthy: (v: boolean) => { healthy = v; }, tunnelOptions };
}

describe("preserving worker lifecycle", () => {
  it("reuses an expired temporary record when its exact worker identity is healthy", async () => { const h = harness(); await h.store.set("worker-record", record({ claim: { url: CLAIM, expiresAt: 1 } })); await h.lifecycle.start(AbortSignal.abort()); expect(h.deploys).toBe(0); expect(h.lifecycle.getStatus().state).toBe("live"); expect(h.lifecycle.getClaimUrl()).toBeNull(); });
  it("keeps a failed boot record Offline and never deploys it over", async () => { const h = harness({ healthy: false }); await h.store.set("worker-record", record()); await h.lifecycle.start(AbortSignal.abort()); await h.lifecycle.ensureDeployed(); expect(h.store.store.has("worker-record")).toBe(true); expect(h.deploys).toBe(0); expect(h.lifecycle.getStatus().state).toBe("offline"); });
  it("periodically recovers Offline to Online even when there are no shares", async () => { const h = harness({ healthy: false }); await h.store.set("worker-record", record()); await h.lifecycle.start(AbortSignal.abort()); h.setHealthy(true); await (h.lifecycle as unknown as { tick(): Promise<void> }).tick(); expect(h.lifecycle.getStatus().state).toBe("live"); expect(h.deploys).toBe(0); });
  it.each([[404, "<html>not CF worker</html>"], [500, "{}"]])("rejects status %i as worker identity", async (status, body) => { const h = harness({ healthy: false, status, body }); await h.store.set("worker-record", record()); await h.lifecycle.start(AbortSignal.abort()); expect(h.lifecycle.getStatus().state).toBe("offline"); });
  it("requires the exact 401 token_missing response", async () => { const h = harness({ body: { error: "wrong" } }); await h.store.set("worker-record", record()); await h.lifecycle.start(AbortSignal.abort()); expect(h.lifecycle.getStatus().state).toBe("offline"); });
  it("recreate is transactional and concurrent-safe", async () => { const h = harness(); await h.store.set("worker-record", record()); await h.lifecycle.start(AbortSignal.abort()); await Promise.all([h.lifecycle.recreateWorker(), h.lifecycle.recreateWorker()]); expect(h.deploys).toBe(1); expect((await createWorkerRecordStore(h.store).load())?.deploymentId).toBe("d1"); });
  it("failed recreate retains the old durable record", async () => { const h = harness({ deployFail: true }); await h.store.set("worker-record", record()); await h.lifecycle.start(AbortSignal.abort()); await expect(h.lifecycle.recreateWorker()).rejects.toThrow("nope"); expect((await createWorkerRecordStore(h.store).load())?.deploymentId).toBe("d"); expect(h.lifecycle.getStatus().state).toBe("offline"); });
  it("makes a stopped tunnel an actionable offline fault", async () => { const h = harness(); await h.store.set("worker-record", record()); await h.lifecycle.start(AbortSignal.abort()); h.tunnelOptions[0].onStatusChange?.("stopped"); expect(h.lifecycle.getStatus()).toMatchObject({ state: "offline", tunnel: "stopped" }); });
});

describe("durable record security and migration", () => {
  it("encrypts url and removes legacy apiToken bytes when re-saving", async () => { const store = kv(); const s = createWorkerRecordStore(store, { keyProvider: new InMemoryKeyProvider() }); await store.set("worker-record", { ...record(), accountId: "x", apiToken: "never-retained", expiresAt: 1 }); expect((await s.load())?.url).toBe(URL); const atRest = JSON.stringify(store.store.get("worker-record")); expect(atRest).not.toContain("never-retained"); expect(atRest).not.toContain(URL); });
  it("migrates a usable OAuth endpoint before purging OAuth bytes", async () => { const store = kv(); const s = createWorkerRecordStore(store); await store.set("oauth-worker-record", { lastKnownUrl: URL, tunnelSecret: SECRET, deploymentId: "old", generation: 2, deployedAt: 3, cfRefreshToken: "refresh" }); expect((await s.load())?.url).toBe(URL); expect(store.store.has("oauth-worker-record")).toBe(false); expect(JSON.stringify(store.store.get("worker-record"))).not.toContain("refresh"); });
  it("migrates an encrypted legacy OAuth endpoint without retaining its refresh grant", async () => { const store = kv(); const key = new InMemoryKeyProvider(); await store.set("oauth-worker-record", encryptRecord({ lastKnownUrl: URL, tunnelSecret: SECRET, cfRefreshToken: "refresh" }, await key.getKey(), ["tunnelSecret", "cfRefreshToken"])); const s = createWorkerRecordStore(store, { keyProvider: key }); expect((await s.load())?.url).toBe(URL); expect(JSON.stringify(store.store.get("worker-record"))).not.toContain("refresh"); });
  it("quarantines unreadable legacy OAuth state rather than deleting or provisioning", async () => { const store = kv(); const s = createWorkerRecordStore(store); await store.set("oauth-worker-record", { lastKnownUrl: "https://evil.test", tunnelSecret: "bad" }); expect(await s.load()).toBeNull(); expect(await s.requiresRecovery()).toBe(true); expect(store.store.has("oauth-worker-record")).toBe(true); });
});
