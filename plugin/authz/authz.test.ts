// Unit tests for the authz endpoint decision logic (issue 06).
import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../lib/token-store";
import type { Perm } from "../lib/token-store";
import {
  authorize,
  classifyPath,
  computeAuthz,
  isMutatingMethod,
} from "./authz";

const fixedKey = () => Buffer.alloc(32, 0x42);

interface ShareSpec {
  thread_id: string;
  perm: Perm;
  project_id?: string;
}

/** A store with one freshly minted token carrying the given shares. */
async function storeWithToken(shares: ShareSpec[]) {
  const store = new InMemoryStore({ hmacKey: fixedKey() });
  const { token, rawToken } = await store.mintToken({ label: "brave-otter" });
  for (const s of shares) {
    await store.addShare(token.id, {
      thread_id: s.thread_id,
      project_id: s.project_id ?? "p1",
      perm: s.perm,
    });
  }
  return { store, token, rawToken };
}

describe("isMutatingMethod", () => {
  it("treats POST/PUT/PATCH/DELETE as mutating, case-insensitively", () => {
    for (const m of ["POST", "put", "Patch", "DELETE"]) {
      expect(isMutatingMethod(m)).toBe(true);
    }
    for (const m of ["GET", "head", "OPTIONS"]) {
      expect(isMutatingMethod(m)).toBe(false);
    }
  });
});

describe("classifyPath", () => {
  it("classifies thread paths and extracts the id, with or without /api/v1", () => {
    expect(classifyPath("/api/v1/threads/t1/output")).toEqual({
      kind: "thread",
      threadId: "t1",
    });
    expect(classifyPath("/threads/t9")).toEqual({
      kind: "thread",
      threadId: "t9",
    });
  });

  it("classifies the enumerated non-thread endpoints as pass-through", () => {
    for (const p of [
      "/api/v1/system/config",
      "/sidebar-bootstrap",
      "/api/v1/plugins",
      "/hosts",
      "/api/v1/plugin-settings/anything",
      "/api/v1/projects/p1",
    ]) {
      expect(classifyPath(p).kind).toBe("non-thread");
    }
  });

  it("classifies unrecognized paths as invalid", () => {
    expect(classifyPath("/api/v1/settings/secrets").kind).toBe("invalid");
    expect(classifyPath("").kind).toBe("invalid");
    expect(classifyPath("/").kind).toBe("invalid");
  });
});

describe("authorize", () => {
  it("valid read: in-scope thread, GET → allowed with scope + perms", async () => {
    const { store, rawToken } = await storeWithToken([
      { thread_id: "t1", perm: "read" },
    ]);
    const res = await authorize(store, {
      token: rawToken,
      path: "/api/v1/threads/t1/output",
      method: "GET",
    });
    expect(res.allowed).toBe(true);
    expect(res.thread_scope).toEqual(["t1"]);
    expect(res.perms).toEqual([{ thread_id: "t1", mode: "read" }]);
  });

  it("valid write: in-scope thread with write perm, POST → allowed", async () => {
    const { store, rawToken } = await storeWithToken([
      { thread_id: "t1", perm: "write" },
    ]);
    const res = await authorize(store, {
      token: rawToken,
      path: "/api/v1/threads/t1/send",
      method: "POST",
    });
    expect(res.allowed).toBe(true);
  });

  it("out-of-scope thread → denied with a reason, scope still reported", async () => {
    const { store, rawToken } = await storeWithToken([
      { thread_id: "t1", perm: "write" },
    ]);
    const res = await authorize(store, {
      token: rawToken,
      path: "/api/v1/threads/t2/output",
      method: "GET",
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/not in token scope/);
    expect(res.thread_scope).toEqual(["t1"]);
  });

  it("missing token → denied", async () => {
    const { store } = await storeWithToken([{ thread_id: "t1", perm: "read" }]);
    const res = await authorize(store, {
      token: undefined,
      path: "/api/v1/threads/t1/output",
      method: "GET",
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("missing token");
    expect(res.thread_scope).toEqual([]);
  });

  it("unknown token → denied", async () => {
    const { store } = await storeWithToken([{ thread_id: "t1", perm: "read" }]);
    const res = await authorize(store, {
      token: "bbsh_not-a-real-token",
      path: "/api/v1/threads/t1/output",
      method: "GET",
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("unknown token");
  });

  it("non-thread path → pass-through allowed, with the token's scope", async () => {
    const { store, rawToken } = await storeWithToken([
      { thread_id: "t1", perm: "read" },
      { thread_id: "t2", perm: "write" },
    ]);
    const res = await authorize(store, {
      token: rawToken,
      path: "/api/v1/system/config",
      method: "GET",
    });
    expect(res.allowed).toBe(true);
    expect(res.thread_scope).toEqual(["t1", "t2"]);
    expect(res.perms).toEqual([
      { thread_id: "t1", mode: "read" },
      { thread_id: "t2", mode: "write" },
    ]);
  });

  it("mutating request without write perm → denied", async () => {
    const { store, rawToken } = await storeWithToken([
      { thread_id: "t1", perm: "read" },
    ]);
    const res = await authorize(store, {
      token: rawToken,
      path: "/api/v1/threads/t1/send",
      method: "POST",
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/write permission required/);
  });
});

describe("project_scope", () => {
  it("single share → the share's project id", async () => {
    const { store, rawToken } = await storeWithToken([
      { thread_id: "t1", perm: "read", project_id: "p1" },
    ]);
    const res = await authorize(store, {
      token: rawToken,
      path: "/api/v1/system/config",
      method: "GET",
    });
    expect(res.project_scope).toEqual(["p1"]);
  });

  it("multiple threads in the same project → deduped to one entry", async () => {
    const { store, rawToken } = await storeWithToken([
      { thread_id: "t1", perm: "read", project_id: "p1" },
      { thread_id: "t2", perm: "write", project_id: "p1" },
    ]);
    const res = await authorize(store, {
      token: rawToken,
      path: "/api/v1/system/config",
      method: "GET",
    });
    expect(res.project_scope).toEqual(["p1"]);
    // thread_scope keeps both; only project_scope dedupes.
    expect(res.thread_scope).toEqual(["t1", "t2"]);
  });

  it("threads across projects → one entry per distinct project", async () => {
    const { store, rawToken } = await storeWithToken([
      { thread_id: "t1", perm: "read", project_id: "p1" },
      { thread_id: "t2", perm: "write", project_id: "p2" },
      { thread_id: "t3", perm: "read", project_id: "p1" },
    ]);
    const res = await authorize(store, {
      token: rawToken,
      path: "/api/v1/system/config",
      method: "GET",
    });
    expect([...res.project_scope].sort()).toEqual(["p1", "p2"]);
  });
});

describe("computeAuthz", () => {
  it("null token → denied as unknown", () => {
    const res = computeAuthz(null, "/api/v1/threads/t1", "GET");
    expect(res).toEqual({
      allowed: false,
      thread_scope: [],
      project_scope: [],
      perms: [],
      reason: "unknown token",
    });
  });
});
