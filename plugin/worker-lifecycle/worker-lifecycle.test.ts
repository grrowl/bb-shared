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
  /** Force the health probe to return a specific HTTP status (L2 tests). */
  healthStatus?: number;
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
      if (opts.healthStatus !== undefined)
        return new Response("", { status: opts.healthStatus });
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
    // H1 (ticket 20): the claim bearer is owner-only, via getClaimUrl — never
    // on the status snapshot / worker-changed broadcast.
    expect(h.lifecycle.getClaimUrl()?.url).toContain("https://claim/");
    // Record persisted with the minted secret.
    const rec = await createWorkerRecordStore(h.kv).load();
    expect(rec?.tunnelSecret).toBe("secret-0");
  });

  it("H1: getStatus + published broadcast payloads never carry claim (ticket 20)", async () => {
    const h = makeHarness();
    await h.lifecycle.ensureDeployed();

    // A worker is live and a claim URL exists behind the owner-only accessor…
    expect(h.lifecycle.getClaimUrl()?.url).toContain("https://claim/");

    // …but neither the status snapshot nor ANY worker-changed broadcast (every
    // publishStatus call is captured in `statuses`) may contain `claim`.
    const status = h.lifecycle.getStatus();
    expect("claim" in status).toBe(false);
    expect(JSON.stringify(status)).not.toContain("claim");

    expect(h.statuses.length).toBeGreaterThan(0);
    for (const s of h.statuses) {
      const json = JSON.stringify(s);
      expect(json).not.toContain("claim");
      expect(json).not.toContain("https://claim/");
    }
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

  // L2 (ticket 21): a 5xx from the worker URL is a broken/hostile proxy, not a
  // live worker. It must NOT count as healthy — the persisted record is wiped
  // (and would redeploy), never reused.
  for (const status of [500, 502, 503]) {
    it(`L2: a ${status} health response is treated as unhealthy (broken proxy, not "alive")`, async () => {
      const h = makeHarness({ healthStatus: status });
      await h.kv.set("worker-record", sampleRecord());
      await h.lifecycle.start(AbortSignal.abort()); // bootstrap → healthCheck

      expect(h.kv.store.has("worker-record")).toBe(false);
      expect(h.lifecycle.getStatus().state).toBe("idle");
      expect(h.tunnels).toHaveLength(0);
    });
  }

  it("L2: the worker's own 401 liveness signal still counts as healthy", async () => {
    // Requiring `response.ok` would wrongly wipe a live worker (it answers
    // GET / with 401 token_missing); sub-500 keeps that liveness signal healthy.
    const h = makeHarness({ healthStatus: 401 });
    await h.kv.set("worker-record", sampleRecord());
    await h.lifecycle.start(AbortSignal.abort());

    expect(h.kv.store.has("worker-record")).toBe(true);
    expect(h.lifecycle.getStatus().state).toBe("live");
    expect(h.tunnels).toHaveLength(1);
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

  it("M4: tick() health-fail redeploy dedupes with a concurrent mint (one deploy, not two)", async () => {
    const kv = fakeKv();
    let deployCalls = 0;
    let healthy = true;
    let holdDeploy = false;
    const releasers: Array<() => void> = [];
    let signalHeldDeploy: (() => void) | null = null;
    const heldDeployStarted = new Promise<void>((r) => (signalHeldDeploy = r));

    const deps: WorkerLifecycleDeps = {
      recordStore: createWorkerRecordStore(kv),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      publishStatus: () => {},
      getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
      getAuthzToken: async () => "authz-token",
      hasTokens: async () => true,
      bundleWorker: async () => "export default {}",
      mintTunnelSecret: () => `secret-${deployCalls}`,
      createTunnel: () => ({ start() {}, stop() {} }),
      now: () => 1000,
      fetchImpl: (async () => {
        if (healthy) return new Response("", { status: 401 });
        throw new Error("connect refused");
      }) as unknown as typeof fetch,
      deployWorker: async () => {
        deployCalls++;
        if (holdDeploy) {
          // Announce that the (blocked) redeploy is in flight, then park until
          // the test releases it — the window in which a concurrent mint races.
          signalHeldDeploy?.();
          signalHeldDeploy = null;
          await new Promise<void>((r) => releasers.push(r));
        }
        return {
          url: "https://bb-shared-worker.sub.workers.dev",
          deploymentId: `dep-${deployCalls}`,
          accountId: `acct-${deployCalls}`,
          apiToken: `api-${deployCalls}`,
          expiresAt: null,
          claim: { url: `https://claim/${deployCalls}`, expiresAt: null },
        };
      },
    };
    const lifecycle = new WorkerLifecycle(deps);

    // 1. Bring the worker up (deploy #1 — not held).
    await lifecycle.ensureDeployed();
    expect(deployCalls).toBe(1);

    // 2. Health now fails; the next deploy blocks so we can interleave a mint.
    healthy = false;
    holdDeploy = true;

    // 3. A health-fail tick clears the record and starts the blocked redeploy.
    // @ts-expect-error exercising the private tick loop body directly
    const tickP = lifecycle.tick();
    await heldDeployStarted; // redeploy #2 is now in flight, parked

    // 4. A concurrent mintToken → ensureDeployed must DEDUPE onto the in-flight
    //    redeploy rather than provisioning a second temp account. (Under the
    //    pre-fix code, tick() called deploy() directly and this raced to a
    //    third deploy.)
    const mintP = lifecycle.ensureDeployed();

    // 5. Release the parked deploy and let both callers settle.
    releasers.forEach((r) => r());
    await Promise.all([tickP, mintP]);

    // Exactly one redeploy happened (1 initial + 1), never two.
    expect(deployCalls).toBe(2);
  });
});
