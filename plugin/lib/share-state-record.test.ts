import { describe, expect, it } from "vitest";
import { InMemoryKeyProvider } from "./device-key";
import { InMemoryStore } from "./token-store";
import { SHARE_STATE_KEY, ShareStateRecordStore } from "./share-state-record";

const rawToken = "bbsh_" + "a".repeat(43);
const snapshot = [{
  id: "bbsh_" + "b".repeat(12),
  label: "brave-otter",
  created_at: 1,
  rawToken,
  shares: [{ thread_id: "thr_1", project_id: "proj_1", perm: "read" as const, added_at: 2 }],
}];

function kv() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: async <T>(key: string) => values.get(key) as T | undefined,
    set: async (key: string, value: unknown) => { values.set(key, value); },
  };
}

describe("ShareStateRecordStore", () => {
  it("encrypts and restores shared links across a fresh in-memory store", async () => {
    const memory = kv();
    const keys = new InMemoryKeyProvider(Buffer.alloc(32, 7));
    const first = new ShareStateRecordStore(memory, keys);
    await first.save(snapshot);

    const atRest = JSON.stringify(memory.values.get(SHARE_STATE_KEY));
    expect(atRest).not.toContain(rawToken);
    expect(atRest).not.toContain("brave-otter");
    expect(atRest).not.toContain("thr_1");

    const restored = await new ShareStateRecordStore(memory, keys).load();
    expect(restored).toEqual(snapshot);
    // A new store gets a new HMAC key, yet rebuilding its hash from the durable
    // raw bearer preserves authorization for the original URL.
    const store = new InMemoryStore({ initialTokens: restored });
    expect((await store.findByRawToken(rawToken))?.shares).toEqual(snapshot[0]!.shares);
  });

  it("does not overwrite an unreadable saved state", async () => {
    const memory = kv();
    const keyA = new InMemoryKeyProvider(Buffer.alloc(32, 1));
    await new ShareStateRecordStore(memory, keyA).save(snapshot);
    const original = memory.values.get(SHARE_STATE_KEY);

    const keyB = new InMemoryKeyProvider(Buffer.alloc(32, 2));
    const reopened = new ShareStateRecordStore(memory, keyB);
    await expect(reopened.load()).resolves.toEqual([]);
    await expect(reopened.save(snapshot)).rejects.toThrow("manual recovery");
    expect(memory.values.get(SHARE_STATE_KEY)).toBe(original);
  });
});
