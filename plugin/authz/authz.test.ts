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
  it("classifies thread paths and extracts id + rest, with or without /api/v1", () => {
    expect(classifyPath("/api/v1/threads/t1/output")).toEqual({
      kind: "thread",
      threadId: "t1",
      rest: "/output",
    });
    expect(classifyPath("/threads/t9")).toEqual({
      kind: "thread",
      threadId: "t9",
      rest: "",
    });
  });

  it("classifies a project-nested thread path as a thread (issue 24)", () => {
    expect(classifyPath("/api/v1/projects/p1/threads/t1/send")).toEqual({
      kind: "thread",
      threadId: "t1",
      rest: "/send",
    });
  });

  it("classifies a specific project as project, scoped later (issue 24)", () => {
    expect(classifyPath("/api/v1/projects/p1")).toEqual({
      kind: "project",
      projectId: "p1",
    });
    // `/projects/{p}/threads` (no thread id) lists threads in a project → still
    // project-scoped, not a thread path.
    expect(classifyPath("/projects/p2/threads").kind).toBe("project");
  });

  it("classifies the enumerated non-thread endpoints as pass-through", () => {
    for (const p of [
      "/api/v1/system/config",
      "/sidebar-bootstrap",
      "/api/v1/plugins",
      "/hosts",
      "/api/v1/plugin-settings/anything",
    ]) {
      expect(classifyPath(p).kind).toBe("non-thread");
    }
  });

  it("classifies unrecognized paths and the bare project list as invalid", () => {
    expect(classifyPath("/api/v1/settings/secrets").kind).toBe("invalid");
    expect(classifyPath("/api/v1/projects").kind).toBe("invalid");
    expect(classifyPath("").kind).toBe("invalid");
  });

  it("classifies the SPA shell and static assets as non-thread (guest-readable)", () => {
    // The guest SPA loads its shell at `/` and its bundle at absolute paths;
    // these carry no per-guest data and must be readable (issues 23/06).
    expect(classifyPath("/").kind).toBe("non-thread");
    expect(classifyPath("/assets/index-abc123.js").kind).toBe("non-thread");
    expect(classifyPath("/assets/inter-latin.woff2").kind).toBe("non-thread");
    expect(classifyPath("/favicon-32x32.png").kind).toBe("non-thread");
    expect(classifyPath("/manifest.webmanifest").kind).toBe("non-thread");
    // But a scoped path that merely ends in a static extension is NOT static —
    // it still classifies as a thread and goes through the scope gate.
    expect(classifyPath("/threads/t1/export.css").kind).toBe("thread");
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

describe("guest boot allowlist (issue 31)", () => {
  it("classifies the WS + system UI-config endpoints as non-thread", () => {
    for (const p of [
      "/ws",
      "/system/execution-options",
      "/system/version",
      "/system/providers",
      "/system/providers/codex/logo",
    ]) {
      expect(classifyPath(p).kind, p).toBe("non-thread");
    }
  });

  it("allows a guest to GET them but not mutate", async () => {
    const { store, rawToken } = await storeWithToken([
      { thread_id: "t1", perm: "read" },
    ]);
    const get = await authorize(store, {
      token: rawToken,
      path: "/ws",
      method: "GET",
    });
    expect(get.allowed).toBe(true);
    const post = await authorize(store, {
      token: rawToken,
      path: "/system/execution-options",
      method: "POST",
    });
    expect(post.allowed).toBe(false);
  });

  it("still denies the full thread list and terminal sockets", () => {
    // /api/v1/threads (no id) would leak every thread — must stay denied.
    expect(classifyPath("/api/v1/threads").kind).toBe("invalid");
    // /ws/terminals/* is not the exact /ws entry → invalid (belt-and-braces
    // with the ws-frame-filter's own 403).
    expect(classifyPath("/ws/terminals/abc").kind).toBe("invalid");
  });
});

describe("deny-by-default (issues 23, 24)", () => {
  it("read guest cannot POST to another plugin's RPC", async () => {
    const { store, rawToken } = await storeWithToken([
      { thread_id: "t1", perm: "read" },
    ]);
    const res = await authorize(store, {
      token: rawToken,
      path: "/api/v1/plugins/automations/rpc/create",
      method: "POST",
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/may not POST/);
  });

  it("write guest cannot DELETE a thread — only /send is allowed", async () => {
    const { store, rawToken } = await storeWithToken([
      { thread_id: "t1", perm: "write" },
    ]);
    const res = await authorize(store, {
      token: rawToken,
      path: "/api/v1/threads/t1",
      method: "DELETE",
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/only POST \/threads\/t1\/send/);
  });

  it("write guest cannot POST a non-send thread subpath (e.g. /abort)", async () => {
    const { store, rawToken } = await storeWithToken([
      { thread_id: "t1", perm: "write" },
    ]);
    const res = await authorize(store, {
      token: rawToken,
      path: "/api/v1/threads/t1/abort",
      method: "POST",
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/only POST/);
  });

  it("guest cannot DELETE a project", async () => {
    const { store, rawToken } = await storeWithToken([
      { thread_id: "t1", perm: "write", project_id: "p1" },
    ]);
    const res = await authorize(store, {
      token: rawToken,
      path: "/api/v1/projects/p1",
      method: "DELETE",
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/may not DELETE/);
  });

  it("in-scope project GET is allowed", async () => {
    const { store, rawToken } = await storeWithToken([
      { thread_id: "t1", perm: "read", project_id: "p1" },
    ]);
    const res = await authorize(store, {
      token: rawToken,
      path: "/api/v1/projects/p1",
      method: "GET",
    });
    expect(res.allowed).toBe(true);
  });

  it("out-of-scope project GET is denied (issue 24)", async () => {
    const { store, rawToken } = await storeWithToken([
      { thread_id: "t1", perm: "read", project_id: "p1" },
    ]);
    const res = await authorize(store, {
      token: rawToken,
      path: "/api/v1/projects/p2",
      method: "GET",
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/project p2 not in token scope/);
  });

  it("project-nested out-of-scope thread is gated as a thread, not allowed", async () => {
    const { store, rawToken } = await storeWithToken([
      { thread_id: "t1", perm: "read", project_id: "p1" },
    ]);
    const res = await authorize(store, {
      token: rawToken,
      path: "/api/v1/projects/p1/threads/t2",
      method: "GET",
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/thread t2 not in token scope/);
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
