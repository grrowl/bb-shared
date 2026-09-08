// SDK fake-host integration: real RPC validation, token store, encrypted KV
// records, lifecycle and loopback gateway. Only OS keychain access is replaced;
// Cloudflare deployment/network and host authentication are outside this test.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHARE_STATE_KEY } from "./lib/share-state-record";

const observed = vi.hoisted(() => ({ gatewayUrls: [] as string[] }));
vi.mock("./lib/device-key", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lib/device-key")>();
  return { ...original, createDeviceKeyProvider: () => new original.InMemoryKeyProvider(Buffer.alloc(32, 7)) };
});
vi.mock("./guest-gateway", async (importOriginal) => {
  const original = await importOriginal<typeof import("./guest-gateway")>();
  return { ...original, createGuestGateway: (...args: Parameters<typeof original.createGuestGateway>) => {
    const gateway = original.createGuestGateway(...args);
    const start = gateway.start;
    gateway.start = async () => { const url = await start(); observed.gatewayUrls.push(url); return url; };
    return gateway;
  } };
});
import plugin, { rpcContract, type Token } from "./server";

const hosts: FakePluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
  observed.gatewayUrls.length = 0;
  vi.restoreAllMocks();
});
function newHost() {
  const host = createFakePluginHost({ pluginId: "shared", sdk: { threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId, title: "Shared thread" }) } } });
  hosts.push(host);
  return host;
}
const firstThread = { thread_id: "th_1", project_id: "pr_1", perm: "read" as const };
async function mint(host: FakePluginHost) {
  return rpcContract.mintToken.output.parse(await host.harness.behavior.callRpc("mintToken", { label: "Reviewers", firstThread }));
}
async function tokens(host: FakePluginHost): Promise<Token[]> {
  return rpcContract.listTokens.output.parse(await host.harness.behavior.callRpc("listTokens", null)).tokens;
}

describe("server factory and owner RPC integration", () => {
  it.each(["rpc", "service"] as const)("defers loopback access until %s execution", async (trigger) => {
    const host = newHost();
    let bound = false;
    let reads = 0;
    const server = new Proxy(host.bb.server, { get(target, key, receiver) {
      if (key === "loopbackBaseUrl") { reads++; if (!bound) throw new Error("BB server is not bound yet"); }
      return Reflect.get(target, key, receiver);
    } });
    const bb = new Proxy(host.bb, { get(target, key, receiver) { return key === "server" ? server : Reflect.get(target, key, receiver); } }) as BbPluginApi;
    await plugin(bb);
    expect(reads).toBe(0);
    expect(observed.gatewayUrls).toEqual([]);
    bound = true;
    let service: ReturnType<typeof host.harness.behavior.runService> | undefined;
    if (trigger === "rpc") {
      expect(await host.harness.behavior.callRpc("listConnections", null)).toEqual({ connections: [] });
    } else {
      service = host.harness.behavior.runService("worker-lifecycle");
      await vi.waitFor(() => expect(observed.gatewayUrls).toHaveLength(1));
    }
    expect(reads).toBe(1);
    expect(host.harness.inspection.registrations.httpRoutes).toEqual([]);
    expect(host.harness.inspection.registrations.rpcMethods).not.toContain("getWorkerStatus");
    expect(host.harness.inspection.registrations.rpcMethods).not.toContain("recreateWorker");
    const gatewayUrl = observed.gatewayUrls[0]!;
    expect((await fetch(new URL("/authz", gatewayUrl))).status).toBe(401);
    await host.harness.lifecycle.dispose();
    await service?.done;
    expect(service?.controller.signal.aborted ?? true).toBe(true);
    await expect(fetch(new URL("/", gatewayUrl))).rejects.toThrow();
  });

  it("persists an invitation and its grant without a deployment or placeholder URL", async () => {
    const host = newHost(); await plugin(host.bb);
    const minted = await mint(host);
    expect(minted.url).toBeUndefined();
    expect(minted.token.url).toBeUndefined();
    expect(minted.token.shares[0]).toMatchObject({ ...firstThread, title: "Shared thread" });
    expect(observed.gatewayUrls).toEqual([]);
    expect(await host.bb.storage.kv.get(SHARE_STATE_KEY)).toBeDefined();
    expect(await tokens(host)).toEqual([minted.token]);
    const persisted = JSON.stringify(await host.bb.storage.kv.get(SHARE_STATE_KEY));
    expect(persisted).not.toContain("Reviewers");
    expect(persisted).not.toContain("th_1");
  });

  it("restores the same saved invitation and grants after plugin reload", async () => {
    const host = newHost(); await plugin(host.bb);
    const minted = await mint(host);
    const replacement = await host.harness.lifecycle.reload(plugin);
    hosts.push(replacement);
    const restored = await tokens(replacement);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: minted.token.id, label: minted.token.label, shares: minted.token.shares });
    expect(restored[0]!.url).toBeUndefined();
  });

  it("validates input and exposes owner invitation CRUD through the registered contract", async () => {
    const host = newHost(); await plugin(host.bb);
    await expect(host.harness.behavior.callRpc("mintToken", { firstThread: { ...firstThread, perm: "admin" } })).rejects.toThrow();
    const { token } = await mint(host);
    await host.harness.behavior.callRpc("renameToken", { id: token.id, label: "Editors" });
    await host.harness.behavior.callRpc("updateShare", { token_id: token.id, thread_id: "th_1", perm: "write" });
    expect((await tokens(host))[0]).toMatchObject({ label: "Editors", shares: [{ perm: "write" }] });
    await host.harness.behavior.callRpc("removeShare", { token_id: token.id, thread_id: "th_1" });
    expect((await tokens(host))[0]!.shares).toEqual([]);
    await host.harness.behavior.callRpc("deleteToken", { id: token.id });
    expect(await tokens(host)).toEqual([]);
  });

  it.each(["addShare", "removeShare", "updateShare", "deleteToken", "renameToken", "mintToken"] as const)("rolls back %s when the durable write fails", async (method) => {
    const host = newHost(); await plugin(host.bb);
    const { token } = await mint(host);
    const before = await tokens(host);
    const durableBefore = await host.bb.storage.kv.get(SHARE_STATE_KEY);
    const signalsBefore = host.harness.inspection.realtimeSignals.length;
    const set = host.bb.storage.kv.set.bind(host.bb.storage.kv);
    vi.spyOn(host.bb.storage.kv, "set").mockImplementation(async (key, value) => {
      if (key === SHARE_STATE_KEY) throw new Error("disk full");
      return set(key, value);
    });
    const inputs = {
      addShare: { token_id: token.id, thread_id: "th_2", project_id: "pr_1", perm: "write" },
      removeShare: { token_id: token.id, thread_id: "th_1" },
      updateShare: { token_id: token.id, thread_id: "th_1", perm: "write" },
      deleteToken: { id: token.id }, renameToken: { id: token.id, label: "Changed" },
      mintToken: { label: "Unsaved", firstThread },
    };
    await expect(host.harness.behavior.callRpc(method, inputs[method])).rejects.toThrow("disk full");
    expect(await tokens(host)).toEqual(before);
    expect(await host.bb.storage.kv.get(SHARE_STATE_KEY)).toEqual(durableBefore);
    expect(host.harness.inspection.realtimeSignals.length).toBe(signalsBefore);
    vi.restoreAllMocks();
    await host.harness.behavior.callRpc("renameToken", { id: token.id, label: "Recovered" });
    expect((await tokens(host))[0]!.label).toBe("Recovered");
  });
});
