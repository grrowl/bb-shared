import { describe, expect, it } from "vitest";
import {
  createOAuthRecordStore,
  OAUTH_RECORD_KEY,
  oauthWorkerRecordSchema,
  type OAuthRecordKv,
  type OAuthWorkerRecord,
} from "./oauth-record";
import { InMemoryKeyProvider, isSecretEnvelope } from "../lib/device-key";

function fakeKv(): OAuthRecordKv & { store: Map<string, unknown> } {
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

function sampleRecord(overrides: Partial<OAuthWorkerRecord> = {}): OAuthWorkerRecord {
  return {
    claimed: true,
    cfRefreshToken: "rt-secret",
    claimedAccountId: "acct-1",
    scriptName: "bb-shared",
    tunnelSecret: "tsecret",
    writeGranted: true,
    lastKnownUrl: "https://bb-shared.alice.workers.dev",
    deploymentId: "dep-1",
    generation: 0,
    deployedAt: 1000,
    claimedAt: 2000,
    ...overrides,
  };
}

describe("createOAuthRecordStore", () => {
  it("round-trips a record through the encrypted path", async () => {
    const s = createOAuthRecordStore(fakeKv(), {
      keyProvider: new InMemoryKeyProvider(),
    });
    const rec = sampleRecord();
    await s.save(rec);
    expect(await s.load()).toEqual(rec);
  });

  it("encrypts ONLY the two secret fields, metadata stays plaintext", async () => {
    const kv = fakeKv();
    const s = createOAuthRecordStore(kv, {
      keyProvider: new InMemoryKeyProvider(),
    });
    await s.save(sampleRecord());
    const atRest = kv.store.get(OAUTH_RECORD_KEY) as Record<string, unknown>;

    expect(isSecretEnvelope(atRest.cfRefreshToken)).toBe(true);
    expect(isSecretEnvelope(atRest.tunnelSecret)).toBe(true);
    // No plaintext secret survives anywhere in the blob.
    const blob = JSON.stringify(atRest);
    expect(blob).not.toContain("rt-secret");
    expect(blob).not.toContain("tsecret");
    // Non-secret metadata stays readable.
    expect(atRest.claimedAccountId).toBe("acct-1");
    expect(atRest.scriptName).toBe("bb-shared");
    expect(atRest.generation).toBe(0);
  });

  it("persists NOTHING beyond the §11.5 set (no access token, no claim.url)", async () => {
    const kv = fakeKv();
    const s = createOAuthRecordStore(kv, {
      keyProvider: new InMemoryKeyProvider(),
    });
    await s.save(sampleRecord());
    const atRest = kv.store.get(OAUTH_RECORD_KEY) as Record<string, unknown>;

    const allowed = new Set([
      "claimed",
      "cfRefreshToken",
      "claimedAccountId",
      "scriptName",
      "tunnelSecret",
      "writeGranted",
      "lastKnownUrl",
      "deploymentId",
      "generation",
      "deployedAt",
      "claimedAt",
    ]);
    for (const key of Object.keys(atRest)) {
      expect(allowed.has(key)).toBe(true);
    }
    // Explicitly none of the forbidden secrets. (`claimed`/`claimedAccountId`
    // are legitimate §11.5 keys, so we check for the forbidden claim.url shape
    // and the temp apiToken, not the substring "claim".)
    const blob = JSON.stringify(atRest);
    expect(blob).not.toContain("accessToken");
    expect(blob).not.toContain("access_token");
    expect(atRest).not.toHaveProperty("claim");
    expect(blob).not.toContain("apiToken");
  });

  it("wipes and returns null on a wrong key (other machine / tamper)", async () => {
    const kv = fakeKv();
    await createOAuthRecordStore(kv, {
      keyProvider: new InMemoryKeyProvider(),
    }).save(sampleRecord());
    const other = createOAuthRecordStore(kv, {
      keyProvider: new InMemoryKeyProvider(),
    });
    expect(await other.load()).toBeNull();
    expect(kv.store.has(OAUTH_RECORD_KEY)).toBe(false);
  });

  it("wipes a structurally malformed blob", async () => {
    const kv = fakeKv();
    kv.store.set(OAUTH_RECORD_KEY, { nonsense: true });
    const s = createOAuthRecordStore(kv, {
      keyProvider: new InMemoryKeyProvider(),
    });
    expect(await s.load()).toBeNull();
    expect(kv.store.has(OAUTH_RECORD_KEY)).toBe(false);
  });

  it("rejects a record whose claimed flag is not literally true", () => {
    const bad = { ...sampleRecord(), claimed: false };
    expect(oauthWorkerRecordSchema.safeParse(bad).success).toBe(false);
  });

  it("clear() removes the record", async () => {
    const kv = fakeKv();
    const s = createOAuthRecordStore(kv, {
      keyProvider: new InMemoryKeyProvider(),
    });
    await s.save(sampleRecord());
    await s.clear();
    expect(await s.load()).toBeNull();
  });
});
