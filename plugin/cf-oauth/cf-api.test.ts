import { describe, expect, it } from "vitest";
import {
  CfApiError,
  deleteClaimedWorker,
  resolveClaimedWorker,
} from "./cf-api";

/**
 * A fake Cloudflare REST for discovery. `accounts` maps account id → the script
 * ids it holds; `subdomains` maps account id → its workers.dev subdomain.
 */
function fakeCf(config: {
  accounts: Record<string, string[]>;
  subdomains: Record<string, string>;
  onDelete?: (url: string, method: string) => void;
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ success: true, errors: [], result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (method === "GET" && u.endsWith("/accounts")) {
      return ok(Object.keys(config.accounts).map((id) => ({ id, name: id })));
    }
    let m = u.match(/\/accounts\/([^/]+)\/workers\/scripts$/);
    if (method === "GET" && m) {
      const scripts = config.accounts[m[1]] ?? [];
      return ok(scripts.map((id) => ({ id })));
    }
    m = u.match(/\/accounts\/([^/]+)\/workers\/subdomain$/);
    if (method === "GET" && m) {
      return ok({ subdomain: config.subdomains[m[1]] });
    }
    if (method === "DELETE") {
      config.onDelete?.(u, method);
      return ok({ id: "deleted" });
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  }) as unknown as typeof fetch;
}

describe("resolveClaimedWorker", () => {
  it("resolves the live hostname for a single matching account", async () => {
    const fetchImpl = fakeCf({
      accounts: { "acct-1": ["bb-shared-worker"], "acct-2": ["other"] },
      subdomains: { "acct-1": "alice", "acct-2": "bob" },
    });
    const resolved = await resolveClaimedWorker({
      fetchImpl,
      accessToken: "at",
    });
    expect(resolved).toEqual({
      accountId: "acct-1",
      subdomain: "alice",
      hostname: "bb-shared-worker.alice.workers.dev",
      url: "https://bb-shared-worker.alice.workers.dev",
    });
  });

  it("returns null when no account holds the script (deleted / not claimed)", async () => {
    const fetchImpl = fakeCf({
      accounts: { "acct-1": ["something-else"] },
      subdomains: { "acct-1": "alice" },
    });
    expect(
      await resolveClaimedWorker({ fetchImpl, accessToken: "at" }),
    ).toBeNull();
  });

  it("disambiguates two matches via the tunnel-secret probe", async () => {
    const fetchImpl = fakeCf({
      accounts: {
        "acct-1": ["bb-shared-worker"],
        "acct-2": ["bb-shared-worker"],
      },
      subdomains: { "acct-1": "alice", "acct-2": "bob" },
    });
    // Only acct-2's worker accepts our secret.
    const probe = async (hostname: string) =>
      hostname === "bb-shared-worker.bob.workers.dev";
    const resolved = await resolveClaimedWorker({
      fetchImpl,
      accessToken: "at",
      tunnelSecret: "tsecret",
      probe,
    });
    expect(resolved?.accountId).toBe("acct-2");
  });

  it("returns null when two match but neither accepts our secret", async () => {
    const fetchImpl = fakeCf({
      accounts: {
        "acct-1": ["bb-shared-worker"],
        "acct-2": ["bb-shared-worker"],
      },
      subdomains: { "acct-1": "alice", "acct-2": "bob" },
    });
    const resolved = await resolveClaimedWorker({
      fetchImpl,
      accessToken: "at",
      tunnelSecret: "tsecret",
      probe: async () => false,
    });
    expect(resolved).toBeNull();
  });

  it("fails closed when ambiguous and no probe is available", async () => {
    const fetchImpl = fakeCf({
      accounts: {
        "acct-1": ["bb-shared-worker"],
        "acct-2": ["bb-shared-worker"],
      },
      subdomains: { "acct-1": "alice", "acct-2": "bob" },
    });
    await expect(
      resolveClaimedWorker({ fetchImpl, accessToken: "at" }),
    ).rejects.toBeInstanceOf(CfApiError);
  });

  it("marks a 401 as unauthorized so the caller can refresh", async () => {
    const fetchImpl = (async () =>
      new Response("", { status: 401 })) as unknown as typeof fetch;
    await expect(
      resolveClaimedWorker({ fetchImpl, accessToken: "stale" }),
    ).rejects.toMatchObject({ unauthorized: true });
  });
});

describe("deleteClaimedWorker", () => {
  it("DELETEs the script under the claimed account with force", async () => {
    let seen = "";
    const fetchImpl = fakeCf({
      accounts: {},
      subdomains: {},
      onDelete: (u) => (seen = u),
    });
    await deleteClaimedWorker({
      fetchImpl,
      accessToken: "at",
      accountId: "acct-1",
      scriptName: "bb-shared-worker",
    });
    expect(seen).toContain("/accounts/acct-1/workers/scripts/bb-shared-worker");
    expect(seen).toContain("force=true");
  });
});
