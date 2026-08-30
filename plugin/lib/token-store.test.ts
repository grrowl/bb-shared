// Unit tests for the in-memory token store (issue 05).
import { describe, expect, it } from "vitest";
import {
  buildShareUrl,
  DuplicateShareError,
  generateRawToken,
  generateTokenId,
  hashToken,
  InMemoryStore,
  pickUniqueLabel,
  randomLabel,
  ShareNotFoundError,
  TokenNotFoundError,
} from "./token-store";
import { randomBytes } from "node:crypto";

const fixedKey = () => Buffer.alloc(32, 0x42);
const clock = (start = 1_000_000) => {
  let t = start;
  return () => t++;
};

describe("token id + raw token generation", () => {
  it("raw token has the bbsh_ prefix and 32B of entropy", () => {
    const raw = generateRawToken();
    expect(raw).toMatch(/^bbsh_[A-Za-z0-9_-]+$/);
    // 32 bytes → 43 base64url chars → 5 (prefix) + 43 = 48
    expect(raw.length).toBe(48);
  });

  it("raw tokens are unique across many calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateRawToken());
    expect(seen.size).toBe(1000);
  });

  it("token ids are short public handles with the bbsh_ prefix", () => {
    const id = generateTokenId();
    expect(id).toMatch(/^bbsh_[A-Za-z0-9_-]+$/);
    // 9 bytes → 12 base64url chars → 5 + 12 = 17
    expect(id.length).toBe(17);
  });

  it("hashToken is deterministic given the same key", () => {
    const key = fixedKey();
    const raw = "bbsh_abc";
    expect(hashToken(key, raw)).toBe(hashToken(key, raw));
  });

  it("hashToken diverges when the key changes", () => {
    const raw = "bbsh_abc";
    expect(hashToken(fixedKey(), raw)).not.toBe(
      hashToken(Buffer.alloc(32, 0x00), raw),
    );
  });
});

describe("label generator", () => {
  it("randomLabel yields adjective-animal", () => {
    for (let i = 0; i < 20; i++) {
      const label = randomLabel();
      expect(label).toMatch(/^[a-z]+-[a-z]+$/);
    }
  });

  it("pickUniqueLabel avoids labels already taken", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const label = pickUniqueLabel(taken);
      expect(taken.has(label)).toBe(false);
      taken.add(label);
    }
    expect(taken.size).toBe(50);
  });

  it("pickUniqueLabel falls back to numeric suffixes when the vocab is exhausted", () => {
    // Force the RNG to return a single combination — every random attempt
    // yields the same label, so dedupe must fall through to `-2`, `-3`, ...
    const stuckRng = () => 0;
    const taken = new Set<string>();
    const first = pickUniqueLabel(taken, stuckRng, 4);
    taken.add(first);
    const second = pickUniqueLabel(taken, stuckRng, 4);
    expect(second).toMatch(/-\d+$/);
    expect(second).not.toBe(first);
  });
});

describe("InMemoryStore CRUD", () => {
  it("mintToken returns a token record and a raw token that isn't stored", async () => {
    const store = new InMemoryStore({ hmacKey: fixedKey(), now: clock() });
    const { token, rawToken } = await store.mintToken();

    expect(rawToken).toMatch(/^bbsh_/);
    expect(token.id).toMatch(/^bbsh_/);
    expect(token.hash).toBe(hashToken(fixedKey(), rawToken));
    expect(token.label).toMatch(/^[a-z]+-[a-z]+$/);
    expect(token.shares).toEqual([]);
    expect(token.created_at).toBe(1_000_000);

    // Raw token must not appear on the stored record anywhere.
    const stored = await store.getToken(token.id);
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain(rawToken);
  });

  it("listTokens returns all minted tokens", async () => {
    const store = new InMemoryStore({ hmacKey: fixedKey() });
    await store.mintToken();
    await store.mintToken();
    await store.mintToken();
    const tokens = await store.listTokens();
    expect(tokens).toHaveLength(3);
  });

  it("getToken returns null for unknown ids", async () => {
    const store = new InMemoryStore({ hmacKey: fixedKey() });
    expect(await store.getToken("bbsh_missing")).toBeNull();
  });

  it("findByRawToken matches the minted token", async () => {
    const store = new InMemoryStore({ hmacKey: fixedKey() });
    const { rawToken, token } = await store.mintToken();
    const found = await store.findByRawToken(rawToken);
    expect(found?.id).toBe(token.id);
  });

  it("findByRawToken returns null for a wrong token", async () => {
    const store = new InMemoryStore({ hmacKey: fixedKey() });
    await store.mintToken();
    const found = await store.findByRawToken("bbsh_not_a_real_token");
    expect(found).toBeNull();
  });

  it("returned token records are cloned — external mutation doesn't leak in", async () => {
    const store = new InMemoryStore({ hmacKey: fixedKey() });
    const { token } = await store.mintToken();
    token.label = "hacked";
    token.shares.push({
      thread_id: "t1",
      project_id: "p1",
      perm: "write",
      added_at: 0,
    });
    const fresh = await store.getToken(token.id);
    expect(fresh?.label).not.toBe("hacked");
    expect(fresh?.shares).toEqual([]);
  });

  it("renameToken updates the label", async () => {
    const store = new InMemoryStore({ hmacKey: fixedKey() });
    const { token } = await store.mintToken();
    await store.renameToken(token.id, "renamed");
    const fresh = await store.getToken(token.id);
    expect(fresh?.label).toBe("renamed");
  });

  it("renameToken throws for unknown tokens", async () => {
    const store = new InMemoryStore({ hmacKey: fixedKey() });
    await expect(store.renameToken("bbsh_missing", "x")).rejects.toBeInstanceOf(
      TokenNotFoundError,
    );
  });

  it("deleteToken removes the record", async () => {
    const store = new InMemoryStore({ hmacKey: fixedKey() });
    const { token, rawToken } = await store.mintToken();
    await store.deleteToken(token.id);
    expect(await store.getToken(token.id)).toBeNull();
    expect(await store.findByRawToken(rawToken)).toBeNull();
    expect(await store.listTokens()).toEqual([]);
  });

  it("deleteToken throws for unknown tokens", async () => {
    const store = new InMemoryStore({ hmacKey: fixedKey() });
    await expect(store.deleteToken("bbsh_missing")).rejects.toBeInstanceOf(
      TokenNotFoundError,
    );
  });
});

describe("InMemoryStore share management", () => {
  const share = (thread_id: string) => ({
    thread_id,
    project_id: "p1",
    perm: "read" as const,
  });

  it("addShare appends a share with a timestamp", async () => {
    const store = new InMemoryStore({ hmacKey: fixedKey(), now: clock(500) });
    const { token } = await store.mintToken();
    await store.addShare(token.id, share("t1"));
    const fresh = await store.getToken(token.id);
    expect(fresh?.shares).toHaveLength(1);
    expect(fresh?.shares[0]).toMatchObject({
      thread_id: "t1",
      project_id: "p1",
      perm: "read",
    });
    expect(typeof fresh?.shares[0]?.added_at).toBe("number");
  });

  it("addShare enforces thread_id uniqueness per token", async () => {
    const store = new InMemoryStore({ hmacKey: fixedKey() });
    const { token } = await store.mintToken();
    await store.addShare(token.id, share("t1"));
    await expect(store.addShare(token.id, share("t1"))).rejects.toBeInstanceOf(
      DuplicateShareError,
    );
    const fresh = await store.getToken(token.id);
    expect(fresh?.shares).toHaveLength(1);
  });

  it("the same thread_id may live on two different tokens", async () => {
    const store = new InMemoryStore({ hmacKey: fixedKey() });
    const a = (await store.mintToken()).token;
    const b = (await store.mintToken()).token;
    await store.addShare(a.id, share("t1"));
    await store.addShare(b.id, share("t1"));
    expect((await store.getToken(a.id))?.shares).toHaveLength(1);
    expect((await store.getToken(b.id))?.shares).toHaveLength(1);
  });

  it("addShare throws when the token is unknown", async () => {
    const store = new InMemoryStore({ hmacKey: fixedKey() });
    await expect(
      store.addShare("bbsh_missing", share("t1")),
    ).rejects.toBeInstanceOf(TokenNotFoundError);
  });

  it("removeShare drops the share", async () => {
    const store = new InMemoryStore({ hmacKey: fixedKey() });
    const { token } = await store.mintToken();
    await store.addShare(token.id, share("t1"));
    await store.addShare(token.id, share("t2"));
    await store.removeShare(token.id, "t1");
    const fresh = await store.getToken(token.id);
    expect(fresh?.shares.map((s) => s.thread_id)).toEqual(["t2"]);
  });

  it("removeShare throws when the thread isn't shared", async () => {
    const store = new InMemoryStore({ hmacKey: fixedKey() });
    const { token } = await store.mintToken();
    await expect(store.removeShare(token.id, "t1")).rejects.toBeInstanceOf(
      ShareNotFoundError,
    );
  });

  it("updateShare changes the perm in place", async () => {
    const store = new InMemoryStore({ hmacKey: fixedKey() });
    const { token } = await store.mintToken();
    await store.addShare(token.id, share("t1"));
    await store.updateShare(token.id, "t1", "write");
    const fresh = await store.getToken(token.id);
    expect(fresh?.shares[0]?.perm).toBe("write");
  });

  it("updateShare throws for unknown shares", async () => {
    const store = new InMemoryStore({ hmacKey: fixedKey() });
    const { token } = await store.mintToken();
    await expect(
      store.updateShare(token.id, "unknown", "write"),
    ).rejects.toBeInstanceOf(ShareNotFoundError);
  });

  it("deleting a token leaves no dangling references to its shares", async () => {
    const store = new InMemoryStore({ hmacKey: fixedKey() });
    const { token } = await store.mintToken();
    await store.addShare(token.id, share("t1"));
    await store.addShare(token.id, share("t2"));
    await store.deleteToken(token.id);
    expect(await store.listTokens()).toEqual([]);
    // A fresh token can now reuse the same label — no residue from the deleted one.
    const { token: replacement } = await store.mintToken({ label: token.label });
    expect(replacement.label).toBe(token.label);
    expect(replacement.shares).toEqual([]);
  });
});

describe("mintToken label dedupe", () => {
  it("does not mint two tokens with the same auto-generated label", async () => {
    // Sequence the RNG so it always yields index 0 for both adjective and
    // animal — the first mint takes it, the second must dedupe.
    const stuckRng = () => 0;
    const store = new InMemoryStore({ hmacKey: fixedKey(), rng: stuckRng });
    const a = await store.mintToken();
    const b = await store.mintToken();
    expect(b.token.label).not.toBe(a.token.label);
  });

  it("permits caller-supplied labels to duplicate (policy handled by the caller)", async () => {
    const store = new InMemoryStore({ hmacKey: fixedKey() });
    const a = await store.mintToken({ label: "brave-otter" });
    const b = await store.mintToken({ label: "brave-otter" });
    expect(a.token.label).toBe("brave-otter");
    expect(b.token.label).toBe("brave-otter");
    expect(a.token.id).not.toBe(b.token.id);
  });
});

describe("buildShareUrl", () => {
  it("uses the pending placeholder origin when no worker is wired", () => {
    const url = buildShareUrl("bbsh_raw");
    // Query `?token=` form: the worker only sets the session cookie (needed for
    // absolute asset requests) when the token arrives as a query param.
    expect(url).toBe("https://<worker-pending>/?token=bbsh_raw");
  });

  it("includes the deep-link thread path with the token as a query param", () => {
    const url = buildShareUrl("bbsh_raw", {
      firstThread: { project_id: "p1", thread_id: "t1" },
      workerOrigin: "https://guest.example",
    });
    expect(url).toBe(
      "https://guest.example/projects/p1/threads/t1?token=bbsh_raw",
    );
  });
});

describe("HMAC key isolation", () => {
  it("a token minted under one HMAC key cannot be found under another", async () => {
    // Simulates a plugin restart — the raw token was handed out under key A,
    // but the process has since restarted with key B, so lookups miss and
    // guest URLs die. This is the design (SPEC: guest URLs invalid on restart).
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    const first = new InMemoryStore({ hmacKey: keyA });
    const { rawToken } = await first.mintToken();
    const second = new InMemoryStore({ hmacKey: keyB });
    expect(await second.findByRawToken(rawToken)).toBeNull();
  });
});
