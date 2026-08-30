// Store-integration tests for at-rest secret encryption (issue 29). Exercises
// createWorkerRecordStore with an injected in-memory KeyProvider — no Keychain,
// no disk.
import { describe, it, expect } from "vitest";
import {
  createWorkerRecordStore,
  workerRecordSchema,
  WORKER_RECORD_KEY,
  type RecordKv,
  type WorkerRecord,
} from "./worker-record";
import {
  InMemoryKeyProvider,
  isSecretEnvelope,
} from "../lib/device-key";

function fakeKv(): RecordKv & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async get<T>(key: string) {
      // Deep-clone on read so callers can't mutate what's "on disk".
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

function sampleRecord(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    deploymentId: "dep-1",
    url: "https://bb-shared.sub.workers.dev",
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

describe("worker record store — at-rest encryption", () => {
  it("round-trips a record through the encrypted path", async () => {
    const kv = fakeKv();
    const s = createWorkerRecordStore(kv, {
      keyProvider: new InMemoryKeyProvider(),
    });
    const rec = sampleRecord();
    await s.save(rec);
    expect(await s.load()).toEqual(rec);
  });

  it("stores secret fields as envelopes, metadata as plaintext", async () => {
    const kv = fakeKv();
    const s = createWorkerRecordStore(kv, {
      keyProvider: new InMemoryKeyProvider(),
    });
    await s.save(sampleRecord());
    const atRest = kv.store.get(WORKER_RECORD_KEY) as Record<string, unknown>;

    // Secrets are encrypted...
    expect(isSecretEnvelope(atRest.apiToken)).toBe(true);
    expect(isSecretEnvelope(atRest.tunnelSecret)).toBe(true);
    expect(isSecretEnvelope((atRest.claim as Record<string, unknown>).url)).toBe(
      true,
    );
    // ...and no plaintext secret value survives anywhere in the blob.
    const blob = JSON.stringify(atRest);
    expect(blob).not.toContain("cf-api-token");
    expect(blob).not.toContain("tsecret");
    expect(blob).not.toContain("claim.example");
    // Metadata stays readable.
    expect(atRest.url).toBe("https://bb-shared.sub.workers.dev");
    expect(atRest.accountId).toBe("acct-1");
    expect(atRest.generation).toBe(0);
  });

  it("handles a null claim (nullable nested secret)", async () => {
    const kv = fakeKv();
    const s = createWorkerRecordStore(kv, {
      keyProvider: new InMemoryKeyProvider(),
    });
    const rec = sampleRecord({ claim: null });
    await s.save(rec);
    expect(await s.load()).toEqual(rec);
  });

  it("wipes and returns null when the key is wrong (other machine / tamper)", async () => {
    const kv = fakeKv();
    // Saved on "machine A".
    await createWorkerRecordStore(kv, {
      keyProvider: new InMemoryKeyProvider(),
    }).save(sampleRecord());
    // Loaded on "machine B" with a different device key.
    const bStore = createWorkerRecordStore(kv, {
      keyProvider: new InMemoryKeyProvider(),
    });
    expect(await bStore.load()).toBeNull();
    expect(kv.store.has(WORKER_RECORD_KEY)).toBe(false);
  });

  it("migrates a legacy plaintext record to encrypted on first load", async () => {
    const kv = fakeKv();
    // Simulate a pre-issue-29 plaintext record written straight to kv.
    const legacy = sampleRecord();
    await kv.set(WORKER_RECORD_KEY, legacy);
    expect(isSecretEnvelope(
      (kv.store.get(WORKER_RECORD_KEY) as WorkerRecord).apiToken,
    )).toBe(false);

    const s = createWorkerRecordStore(kv, {
      keyProvider: new InMemoryKeyProvider(),
    });
    // Reads cleanly...
    expect(await s.load()).toEqual(legacy);
    // ...and the plaintext is gone — the blob is now encrypted at rest.
    const atRest = kv.store.get(WORKER_RECORD_KEY) as Record<string, unknown>;
    expect(isSecretEnvelope(atRest.apiToken)).toBe(true);
    expect(JSON.stringify(atRest)).not.toContain("cf-api-token");
  });

  it("does not persist plaintext secrets when a provider is set", async () => {
    const kv = fakeKv();
    const s = createWorkerRecordStore(kv, {
      keyProvider: new InMemoryKeyProvider(),
    });
    await s.save(sampleRecord());
    // The at-rest blob still validates against the schema shape for metadata
    // but secret fields are objects, not strings — so a naive schema parse of
    // the raw blob fails, which is exactly why decrypt-on-load is required.
    const atRest = kv.store.get(WORKER_RECORD_KEY);
    expect(workerRecordSchema.safeParse(atRest).success).toBe(false);
  });

  it("clear() removes the record", async () => {
    const kv = fakeKv();
    const s = createWorkerRecordStore(kv, {
      keyProvider: new InMemoryKeyProvider(),
    });
    await s.save(sampleRecord());
    await s.clear();
    expect(await s.load()).toBeNull();
    expect(kv.store.has(WORKER_RECORD_KEY)).toBe(false);
  });

  it("still wipes a structurally malformed blob (unchanged legacy behaviour)", async () => {
    const kv = fakeKv();
    kv.store.set(WORKER_RECORD_KEY, { nonsense: true });
    const s = createWorkerRecordStore(kv, {
      keyProvider: new InMemoryKeyProvider(),
    });
    expect(await s.load()).toBeNull();
    expect(kv.store.has(WORKER_RECORD_KEY)).toBe(false);
  });
});
