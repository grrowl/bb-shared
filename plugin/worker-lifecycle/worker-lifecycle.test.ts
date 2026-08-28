import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  POW_MAX_ITERATIONS,
  solveChallenge,
  solvePow,
} from "./pow";
import { mintTunnelSecret } from "./tunnel-secret";
import {
  createWorkerRecordStore,
  type RecordKv,
  type WorkerRecord,
} from "./worker-record";
import {
  WorkerLifecycle,
  type TunnelLike,
  type WorkerLifecycleDeps,
} from "./worker-lifecycle";
import type { DeployResult } from "./cf-deploy";

// ---------------------------------------------------------------------------
// PoW solver.
// ---------------------------------------------------------------------------

describe("solvePow", () => {
  it("chains g SHA-256 rounds per segment (known-answer, k=1 g=1)", () => {
    const seed = Buffer.alloc(32, 0);
    const out = Buffer.from(solvePow(seed, 1, 1), "base64");
    // checkpoint[0] = seed, checkpoint[1] = sha256(seed).
    expect(out.length).toBe(64);
    expect(out.subarray(0, 32).equals(seed)).toBe(true);
    const expected = createHash("sha256").update(seed).digest();
    expect(out.subarray(32, 64).equals(expected)).toBe(true);
  });

  it("produces k+1 checkpoints", () => {
    const seed = Buffer.alloc(32, 7);
    const out = Buffer.from(solvePow(seed, 5, 3), "base64");
    expect(out.length).toBe(32 * 6);
  });

  it("is deterministic", () => {
    const seed = Buffer.alloc(32, 9);
    expect(solvePow(seed, 4, 4)).toBe(solvePow(seed, 4, 4));
  });

  it("rejects difficulty above the 64M cap", () => {
    expect(() => solvePow(Buffer.alloc(32), 1, POW_MAX_ITERATIONS + 1)).toThrow(
      /cap/,
    );
  });

  it("decodes a base64 seed via solveChallenge", () => {
    const seed = Buffer.alloc(32, 1);
    const solved = solveChallenge({
      challengeToken: "tok",
      seed: seed.toString("base64"),
      k: 2,
      g: 2,
    });
    expect(solved.challengeToken).toBe("tok");
    expect(Buffer.from(solved.solution.checkpoints, "base64").length).toBe(
      32 * 3,
    );
  });
});

// ---------------------------------------------------------------------------
// Tunnel secret.
// ---------------------------------------------------------------------------

describe("mintTunnelSecret", () => {
  it("returns a URL-safe 256-bit base64url secret, unique per call", () => {
    const a = mintTunnelSecret();
    const b = mintTunnelSecret();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes → 43 base64url chars (no padding).
    expect(a.length).toBe(43);
  });
});

// ---------------------------------------------------------------------------
// Record store.
// ---------------------------------------------------------------------------

function fakeKv(): RecordKv & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async get<T>(key: string) {
      return store.get(key) as T | undefined;
    },
    async set(key: string, value: unknown) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

function sampleRecord(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    deploymentId: "dep-1",
    url: "https://bb-shared-worker.sub.workers.dev",
    accountId: "acct-1",
    apiToken: "cf-api-token",
    expiresAt: null,
    tunnelSecret: "tsecret",
    claim: { url: "https://claim.example/abc", expiresAt: 123 },
    deployedAt: 1000,
    generation: 0,
    ...overrides,
  };
}

describe("createWorkerRecordStore", () => {
  it("round-trips a record", async () => {
    const s = createWorkerRecordStore(fakeKv());
    expect(await s.load()).toBeNull();
    const rec = sampleRecord();
    await s.save(rec);
    expect(await s.load()).toEqual(rec);
    await s.clear();
    expect(await s.load()).toBeNull();
  });

  it("wipes a malformed record and returns null", async () => {
    const kv = fakeKv();
    kv.store.set("worker-record", { nonsense: true });
    const s = createWorkerRecordStore(kv);
    expect(await s.load()).toBeNull();
    expect(kv.store.has("worker-record")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle state machine (fakes for deploy/tunnel/health).
// ---------------------------------------------------------------------------

interface Harness {
  lifecycle: WorkerLifecycle;
  kv: RecordKv & { store: Map<string, unknown> };
  tunnels: Array<{ opts: unknown; started: boolean; stopped: boolean }>;
  deployCalls: number;
  secrets: string[];
  statuses: unknown[];
}

function makeHarness(opts: {
  hasTokens?: boolean;
  healthy?: boolean;
  deployResult?: () => DeployResult;
  deployThrows?: boolean;
} = {}): Harness {
  const kv = fakeKv();
  const tunnels: Harness["tunnels"] = [];
  const secrets: string[] = [];
  const statuses: unknown[] = [];
  let deployCalls = 0;

  const createTunnel = (tunnelOpts: unknown): TunnelLike => {
    const entry = { opts: tunnelOpts, started: false, stopped: false };
    tunnels.push(entry);
    return {
      start() {
        entry.started = true;
      },
      stop() {
        entry.stopped = true;
      },
    };
  };

  let gen = 0;
  const deps: WorkerLifecycleDeps = {
    recordStore: createWorkerRecordStore(kv),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    publishStatus: (s) => statuses.push(s),
    getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
    getAuthzToken: async () => "authz-token",
    hasTokens: async () => opts.hasTokens ?? true,
    bundleWorker: async () => "export default {}",
    mintTunnelSecret: () => {
      const s = `secret-${secrets.length}`;
      secrets.push(s);
      return s;
    },
    createTunnel,
    now: () => 1000,
    fetchImpl: (async () => {
      if (opts.healthy ?? true) return new Response("", { status: 401 });
      throw new Error("connect refused");
    }) as unknown as typeof fetch,
    deployWorker: async () => {
      deployCalls++;
      if (opts.deployThrows) throw new Error("deploy boom");
      return (
        opts.deployResult?.() ?? {
          url: `https://bb-shared-worker.sub.workers.dev`,
          deploymentId: `dep-${gen}`,
          accountId: `acct-${gen}`,
          apiToken: `api-${gen}`,
          expiresAt: null,
          claim: { url: `https://claim/${gen++}`, expiresAt: null },
        }
      );
    },
  };

  const harness: Harness = {
    lifecycle: new WorkerLifecycle(deps),
    kv,
    tunnels,
    get deployCalls() {
      return deployCalls;
    },
    secrets,
    statuses,
  } as Harness;
  return harness;
}

describe("WorkerLifecycle", () => {
  it("ensureDeployed deploys, persists, starts a tunnel, goes live", async () => {
    const h = makeHarness();
    await h.lifecycle.ensureDeployed();

    expect(h.deployCalls).toBe(1);
    expect(h.tunnels).toHaveLength(1);
    expect(h.tunnels[0].started).toBe(true);
    const status = h.lifecycle.getStatus();
    expect(status.state).toBe("live");
    expect(status.healthy).toBe(true);
    expect(status.url).toBe("https://bb-shared-worker.sub.workers.dev");
    expect(status.claim?.url).toContain("https://claim/");
    // Record persisted with the minted secret.
    const rec = await createWorkerRecordStore(h.kv).load();
    expect(rec?.tunnelSecret).toBe("secret-0");
  });

  it("getStatus never leaks apiToken or tunnelSecret", async () => {
    const h = makeHarness();
    await h.lifecycle.ensureDeployed();
    const json = JSON.stringify(h.lifecycle.getStatus());
    expect(json).not.toContain("api-");
    expect(json).not.toContain("secret-");
  });

  it("ensureDeployed is a no-op once live and dedupes concurrent calls", async () => {
    const h = makeHarness();
    await Promise.all([
      h.lifecycle.ensureDeployed(),
      h.lifecycle.ensureDeployed(),
    ]);
    expect(h.deployCalls).toBe(1);
    await h.lifecycle.ensureDeployed();
    expect(h.deployCalls).toBe(1);
  });

  it("deploy failure lands in the error state without throwing out of ensureDeployed", async () => {
    const h = makeHarness({ deployThrows: true });
    await h.lifecycle.ensureDeployed();
    expect(h.lifecycle.getStatus().state).toBe("error");
    expect(h.lifecycle.getStatus().healthy).toBe(false);
  });

  it("bootstrap reuses a healthy persisted worker without redeploying", async () => {
    const h = makeHarness({ healthy: true });
    await h.kv.set("worker-record", sampleRecord());
    const signal = AbortSignal.abort();
    await h.lifecycle.start(signal); // bootstrap then exit (already aborted)

    expect(h.deployCalls).toBe(0);
    expect(h.tunnels).toHaveLength(1);
    expect(h.tunnels[0].started).toBe(true);
    // reused secret from the persisted record
    expect((h.tunnels[0].opts as { tunnelSecret: string }).tunnelSecret).toBe(
      "tsecret",
    );
    expect(h.lifecycle.getStatus().state).toBe("live");
  });

  it("bootstrap wipes a dead persisted worker", async () => {
    const h = makeHarness({ healthy: false });
    await h.kv.set("worker-record", sampleRecord());
    await h.lifecycle.start(AbortSignal.abort());

    expect(h.kv.store.has("worker-record")).toBe(false);
    expect(h.lifecycle.getStatus().state).toBe("idle");
    expect(h.tunnels).toHaveLength(0);
  });

  it("rotates the tunnel + secret on redeploy", async () => {
    const h = makeHarness();
    await h.lifecycle.ensureDeployed(); // gen 0 → secret-0
    // Force a redeploy via a direct second deploy (simulating health-fail path).
    // @ts-expect-error exercising the private deploy path for the rotation check
    await h.lifecycle.deploy();

    expect(h.deployCalls).toBe(2);
    expect(h.tunnels).toHaveLength(2);
    expect(h.tunnels[0].stopped).toBe(true); // old tunnel stopped
    expect(h.tunnels[1].started).toBe(true); // new tunnel started
    expect(h.secrets).toEqual(["secret-0", "secret-1"]); // fresh secret
    const rec = await createWorkerRecordStore(h.kv).load();
    expect(rec?.tunnelSecret).toBe("secret-1");
    expect(rec?.generation).toBe(1);
  });
});
