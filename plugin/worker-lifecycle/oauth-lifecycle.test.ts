// OAuth lifecycle integration (issue 28): restart adoption paths (§12), the
// connect → discover → persist → adopt flow (§11.2-11.5), refresh-token
// rotation, disconnect, and redeploy. All CF/browser I/O is behind injected
// seams so these run offline (no registered client, no live account).
import { describe, expect, it } from "vitest";
import { WorkerLifecycle, type WorkerLifecycleDeps } from "./worker-lifecycle";
import { createWorkerRecordStore, type RecordKv } from "./worker-record";
import {
  createOAuthRecordStore,
  OAuthClient,
  OAUTH_RECORD_KEY,
  type OAuthWorkerRecord,
  type PendingConnect,
  type ResolvedWorker,
} from "../cf-oauth";

function fakeKv(): RecordKv & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async get<T>(key: string) {
      const v = store.get(key);
      return (v === undefined ? undefined : JSON.parse(JSON.stringify(v))) as
        | T
        | undefined;
    },
    async set(key: string, value: unknown) {
      store.set(key, JSON.parse(JSON.stringify(value)));
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

function claimedRecord(over: Partial<OAuthWorkerRecord> = {}): OAuthWorkerRecord {
  return {
    claimed: true,
    cfRefreshToken: "rt-1",
    claimedAccountId: "acct-1",
    scriptName: "bb-shared",
    tunnelSecret: "tsecret",
    writeGranted: true,
    lastKnownUrl: "https://bb-shared.OLD.workers.dev",
    deploymentId: "dep-1",
    generation: 3,
    deployedAt: 1000,
    claimedAt: 2000,
    ...over,
  };
}

interface HarnessOpts {
  refreshResponse?: unknown;
  refreshStatus?: number;
  resolve?: () => Promise<ResolvedWorker | null>;
  pendingConnect?: () => PendingConnect;
}

interface Harness {
  lifecycle: WorkerLifecycle;
  kv: RecordKv & { store: Map<string, unknown> };
  tunnels: Array<{ opts: { workerUrl: string; tunnelSecret: string } }>;
  connectionStatuses: unknown[];
  deployCalls: number;
  revokes: string[];
  redeployCalls: number;
  deleteCalls: number;
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const kv = fakeKv();
  const tunnels: Harness["tunnels"] = [];
  const connectionStatuses: unknown[] = [];
  const revokes: string[] = [];
  let deployCalls = 0;
  let redeployCalls = 0;
  let deleteCalls = 0;

  // Mock the OAuth token endpoint for OAuthClient.refresh/revoke.
  const oauthFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input.toString();
    if (u.endsWith("/oauth2/revoke")) {
      const body = Object.fromEntries(
        new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
      );
      revokes.push(body.token ?? "");
      return new Response("", { status: 200 });
    }
    // token endpoint (refresh)
    return new Response(
      JSON.stringify(
        opts.refreshResponse ?? {
          access_token: "at-1",
          expires_in: 3600,
          scope: "account:read workers:read workers_scripts:write",
        },
      ),
      {
        status: opts.refreshStatus ?? 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;

  const deps: WorkerLifecycleDeps = {
    recordStore: createWorkerRecordStore(kv),
    oauthRecordStore: createOAuthRecordStore(kv),
    oauthClient: new OAuthClient({ fetchImpl: oauthFetch }),
    getOAuthClientId: () => "client-1",
    getOAuthCallbackPort: () => 8977,
    tunnelProbe: async () => true,
    resolveClaimedWorker:
      opts.resolve ??
      (async () => ({
        accountId: "acct-1",
        subdomain: "newsub",
        hostname: "bb-shared.newsub.workers.dev",
        url: "https://bb-shared.newsub.workers.dev",
      })),
    redeployClaimedWorker: async () => {
      redeployCalls++;
      return {
        url: "https://bb-shared.newsub.workers.dev",
        deploymentId: "dep-redeploy",
      };
    },
    deleteClaimedWorker: async () => {
      deleteCalls++;
    },
    beginConnect: opts.pendingConnect,
    publishConnection: (s) => connectionStatuses.push(s),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    publishStatus: () => {},
    getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
    getAuthzToken: async () => "authz-token",
    hasTokens: async () => true,
    bundleWorker: async () => "export default {}",
    mintTunnelSecret: () => "secret-fresh",
    createTunnel: (o) => {
      tunnels.push({ opts: o as { workerUrl: string; tunnelSecret: string } });
      return { start() {}, stop() {} };
    },
    now: () => 5000,
    fetchImpl: (async () =>
      new Response("", { status: 401 })) as unknown as typeof fetch,
    deployWorker: async () => {
      deployCalls++;
      return {
        url: "https://bb-shared.temp.workers.dev",
        deploymentId: "dep-temp",
        accountId: "acct-temp",
        apiToken: "api-temp",
        expiresAt: null,
        claim: { url: "https://claim/x", expiresAt: null },
      };
    },
  };

  return {
    lifecycle: new WorkerLifecycle(deps),
    kv,
    tunnels,
    connectionStatuses,
    revokes,
    get deployCalls() {
      return deployCalls;
    },
    get redeployCalls() {
      return redeployCalls;
    },
    get deleteCalls() {
      return deleteCalls;
    },
  } as Harness;
}

describe("restart adoption (§12A)", () => {
  it("adopts a claimed worker at the LIVE hostname, no temp deploy", async () => {
    const h = makeHarness();
    await h.kv.set(OAUTH_RECORD_KEY, claimedRecord());
    await h.lifecycle.start(AbortSignal.abort());

    // No temp worker deployed; the tunnel dials the RE-RESOLVED host, not the
    // stale persisted lastKnownUrl.
    expect(h.deployCalls).toBe(0);
    expect(h.tunnels).toHaveLength(1);
    expect(h.tunnels[0].opts.workerUrl).toBe(
      "https://bb-shared.newsub.workers.dev",
    );
    expect(h.tunnels[0].opts.tunnelSecret).toBe("tsecret");

    const conn = h.lifecycle.getConnectionStatus();
    expect(conn.connection).toBe("connected");
    expect(conn.claimed).toBe(true);
    expect(conn.accountId).toBe("acct-1");
    expect(conn.hostname).toBe("bb-shared.newsub.workers.dev");
    expect(h.lifecycle.getStatus().url).toBe(
      "https://bb-shared.newsub.workers.dev",
    );
    // The live URL was persisted back as the cache.
    const saved = h.kv.store.get(OAUTH_RECORD_KEY) as OAuthWorkerRecord;
    expect(saved.lastKnownUrl).toBe("https://bb-shared.newsub.workers.dev");
  });

  it("wipes the record and falls back when the worker was deleted in the dashboard", async () => {
    const h = makeHarness({ resolve: async () => null });
    await h.kv.set(OAUTH_RECORD_KEY, claimedRecord());
    await h.lifecycle.start(AbortSignal.abort());

    expect(h.kv.store.has(OAUTH_RECORD_KEY)).toBe(false);
    expect(h.lifecycle.getConnectionStatus().connection).toBe("not-connected");
    // No temp record either → idle, ready to bootstrap fresh on next mint.
    expect(h.lifecycle.getStatus().state).toBe("idle");
  });

  it("drops to not-connected and wipes on a revoked refresh token", async () => {
    const h = makeHarness({
      refreshStatus: 400,
      refreshResponse: { error: "invalid_grant" },
    });
    await h.kv.set(OAUTH_RECORD_KEY, claimedRecord());
    await h.lifecycle.start(AbortSignal.abort());

    expect(h.kv.store.has(OAUTH_RECORD_KEY)).toBe(false);
    expect(h.lifecycle.getConnectionStatus().connection).toBe("not-connected");
  });

  it("persists a rotated refresh token during adoption", async () => {
    const h = makeHarness({
      refreshResponse: {
        access_token: "at-1",
        refresh_token: "rt-2-rotated",
        expires_in: 3600,
        scope: "account:read workers:read workers_scripts:write",
      },
    });
    await h.kv.set(OAUTH_RECORD_KEY, claimedRecord());
    await h.lifecycle.start(AbortSignal.abort());

    const saved = h.kv.store.get(OAUTH_RECORD_KEY) as OAuthWorkerRecord;
    expect(saved.cfRefreshToken).toBe("rt-2-rotated");
  });
});

describe("not-connected restart (§12B) is unchanged", () => {
  it("stays idle with no OAuth record and no temp record", async () => {
    const h = makeHarness();
    await h.lifecycle.start(AbortSignal.abort());
    expect(h.lifecycle.getConnectionStatus().connection).toBe("not-connected");
    expect(h.lifecycle.getConnectionStatus().claimed).toBe(false);
    expect(h.lifecycle.getStatus().state).toBe("idle");
    expect(h.deployCalls).toBe(0);
  });
});

describe("connect → discover → persist → adopt (§11.2-11.5)", () => {
  function fakePending(tokens: {
    access_token: string;
    refresh_token: string;
    scope?: string;
  }): () => PendingConnect {
    return () => ({
      authorizeUrl: "https://dash.cloudflare.com/oauth2/auth?state=x",
      cancel() {},
      async complete() {
        return {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresInSeconds: 3600,
          scope: tokens.scope,
        };
      },
    });
  }

  it("connects, confirms the claim by discovery, and persists ONLY §11.5", async () => {
    const h = makeHarness({
      pendingConnect: fakePending({
        access_token: "at-1",
        refresh_token: "rt-connect",
        scope: "account:read workers:read workers_scripts:write",
      }),
    });
    // The owner connects right after claiming, so a temp worker is live in
    // memory — its tunnel secret is what the claimed worker was deployed with.
    await h.lifecycle.ensureDeployed();

    const { authorizeUrl } = await h.lifecycle.beginCloudflareConnect();
    expect(authorizeUrl).toContain("oauth2/auth");

    // Let the background complete() → onConnected → discoverAndAdopt settle.
    await new Promise((r) => setTimeout(r, 10));

    const conn = h.lifecycle.getConnectionStatus();
    expect(conn.connection).toBe("connected");
    expect(conn.claimed).toBe(true);
    expect(conn.writeGranted).toBe(true);

    const saved = h.kv.store.get(OAUTH_RECORD_KEY) as OAuthWorkerRecord;
    expect(saved.claimed).toBe(true);
    expect(saved.cfRefreshToken).toBe("rt-connect");
    expect(saved.claimedAccountId).toBe("acct-1");
    // The claimed record carries the temp worker's tunnel secret so the tunnel
    // re-dials without a redeploy.
    expect(saved.tunnelSecret).toBe("secret-fresh");
    // No access token or claim.url ever reaches disk.
    const blob = JSON.stringify(saved);
    expect(blob).not.toContain("at-1");
    expect(blob).not.toContain("accessToken");
    expect(saved).not.toHaveProperty("claim");
  });

  it("errors clearly when the client id is not configured", async () => {
    const h = makeHarness();
    (h.lifecycle as unknown as { deps: WorkerLifecycleDeps }).deps.getOAuthClientId =
      () => "";
    await expect(h.lifecycle.beginCloudflareConnect()).rejects.toThrow(
      /client id/i,
    );
  });
});

describe("disconnect (§11.4)", () => {
  it("revokes the refresh token, forgets the record, drops to not-connected", async () => {
    const h = makeHarness();
    await h.kv.set(OAUTH_RECORD_KEY, claimedRecord());
    await h.lifecycle.start(AbortSignal.abort());
    expect(h.lifecycle.getConnectionStatus().claimed).toBe(true);

    await h.lifecycle.disconnectCloudflare();
    // rt was rotated to nothing here (no refresh_token in response) so the
    // original rt-1 is revoked.
    expect(h.revokes).toContain("rt-1");
    expect(h.kv.store.has(OAUTH_RECORD_KEY)).toBe(false);
    expect(h.lifecycle.getConnectionStatus().connection).toBe("not-connected");
  });
});

describe("redeploy / undeploy a claimed worker (§11.4)", () => {
  it("redeploys onto the claimed account and rotates the tunnel secret", async () => {
    const h = makeHarness();
    await h.kv.set(OAUTH_RECORD_KEY, claimedRecord());
    await h.lifecycle.start(AbortSignal.abort());

    await h.lifecycle.redeployClaimedWorker();
    expect(h.redeployCalls).toBe(1);
    const saved = h.kv.store.get(OAUTH_RECORD_KEY) as OAuthWorkerRecord;
    expect(saved.tunnelSecret).toBe("secret-fresh");
    expect(saved.generation).toBe(4); // bumped from 3
    // Latest tunnel dials with the fresh secret.
    expect(h.tunnels[h.tunnels.length - 1].opts.tunnelSecret).toBe("secret-fresh");
  });

  it("undeploys, forgets the record, stays connected-but-unclaimed", async () => {
    const h = makeHarness();
    await h.kv.set(OAUTH_RECORD_KEY, claimedRecord());
    await h.lifecycle.start(AbortSignal.abort());

    await h.lifecycle.undeployClaimedWorker();
    expect(h.deleteCalls).toBe(1);
    expect(h.kv.store.has(OAUTH_RECORD_KEY)).toBe(false);
    const conn = h.lifecycle.getConnectionStatus();
    expect(conn.connection).toBe("connected");
    expect(conn.claimed).toBe(false);
  });

  it("refuses redeploy without the write scope", async () => {
    const h = makeHarness();
    await h.kv.set(OAUTH_RECORD_KEY, claimedRecord({ writeGranted: false }));
    await h.lifecycle.start(AbortSignal.abort());
    await expect(h.lifecycle.redeployClaimedWorker()).rejects.toThrow(/write/i);
  });
});
