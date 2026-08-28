import { describe, expect, it } from "vitest";
import {
  authzStage,
  denyForPath,
  isApiPath,
  scopeFromAuthz,
  type AuthzResponse,
} from "../src/stages/authz.js";
import {
  isLockedRoute,
  lockoutRedirectHtml,
  routeLockoutsStage,
} from "../src/stages/route-lockouts.js";
import type { RequestContext, StageResult } from "../src/pipeline.js";
import type { Env } from "../src/env.js";
import type { TunnelRouter } from "../src/tunnel/interface.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const AUTHZ_TOKEN = "test-authz-bearer";
const GUEST_TOKEN = "bbsh_" + "a".repeat(40);

const ORIGIN = "https://guests-abc.workers.dev";

/**
 * A router whose `dispatch` returns a canned authz answer. authzStage only ever
 * dispatches the `/authz` query, so we can assert on the request it built and
 * hand back the fixture. `spy` captures the last dispatched request.
 */
function fakeRouter(
  answer:
    | { json: AuthzResponse; status?: number }
    | { raw: Response }
    | { throws: true },
): { router: TunnelRouter; seen: () => Request | null } {
  let last: Request | null = null;
  const router: TunnelRouter = {
    acceptTunnelDial: async () => new Response(null, { status: 101 }),
    dispatch: async (request: Request) => {
      last = request;
      if ("throws" in answer) throw new Error("tunnel exploded");
      if ("raw" in answer) return answer.raw;
      return new Response(JSON.stringify(answer.json), {
        status: answer.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return { router, seen: () => last };
}

function makeCtx(
  overrides: {
    pathname?: string;
    method?: string;
    token?: string | null;
  } = {},
): RequestContext {
  const pathname = overrides.pathname ?? "/api/v1/threads/T1/detail";
  const method = overrides.method ?? "GET";
  const url = new URL(ORIGIN + pathname);
  const env = { AUTHZ_TOKEN, TUNNEL_SECRET: "x", TUNNEL_DO: {} } as unknown as Env;
  return {
    request: new Request(url, { method }),
    url,
    env,
    ctx: {} as ExecutionContext,
    workerPublicOrigin: ORIGIN,
    token: overrides.token === undefined ? GUEST_TOKEN : overrides.token,
    scope: null,
  };
}

function expectContinue(r: StageResult): Extract<StageResult, { kind: "continue" }> {
  expect(r.kind).toBe("continue");
  if (r.kind !== "continue") throw new Error("unreachable");
  return r;
}
function expectRespond(r: StageResult): Response {
  expect(r.kind).toBe("respond");
  if (r.kind !== "respond") throw new Error("unreachable");
  return r.response;
}

const allow = (over: Partial<AuthzResponse> = {}): AuthzResponse => ({
  allowed: true,
  thread_scope: ["T1"],
  perms: [{ thread_id: "T1", mode: "write" }],
  ...over,
});
const deny = (reason: string): AuthzResponse => ({
  allowed: false,
  thread_scope: [],
  perms: [],
  reason,
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("scopeFromAuthz", () => {
  it("maps thread_scope → threadIds", () => {
    const scope = scopeFromAuthz(allow({ thread_scope: ["T1", "T2"] }));
    expect([...scope.threadIds].sort()).toEqual(["T1", "T2"]);
  });

  it("derives projectIds from any perm project_id (forward-compatible)", () => {
    const scope = scopeFromAuthz({
      allowed: true,
      thread_scope: ["T1", "T2"],
      perms: [
        { thread_id: "T1", mode: "read", project_id: "P1" },
        { thread_id: "T2", mode: "write", project_id: "P1" },
      ],
    });
    expect([...scope.projectIds]).toEqual(["P1"]);
  });

  it("yields empty projectIds when perms carry no project_id (06 today)", () => {
    const scope = scopeFromAuthz(allow());
    expect(scope.projectIds.size).toBe(0);
  });
});

describe("isApiPath", () => {
  it("classifies /api/* as API and SPA routes as HTML", () => {
    expect(isApiPath("/api/v1/threads/T1")).toBe(true);
    expect(isApiPath("/api")).toBe(true);
    expect(isApiPath("/projects/P1/threads/T1")).toBe(false);
    expect(isApiPath("/")).toBe(false);
  });
});

describe("denyForPath", () => {
  it("403 { error: scope, reason } for API paths", async () => {
    const res = denyForPath("/api/v1/threads/T2/detail", "nope");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "scope", reason: "nope" });
  });

  it("404 for HTML paths", () => {
    const res = denyForPath("/projects/P2/threads/T2", "nope");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// authzStage — the six required cases
// ---------------------------------------------------------------------------

describe("authzStage", () => {
  it("allow → forwards (continues with populated scope)", async () => {
    const { router, seen } = fakeRouter({ json: allow() });
    const r = await authzStage(router).run(makeCtx());
    const cont = expectContinue(r);
    expect(cont.ctx.scope?.threadIds.has("T1")).toBe(true);

    // Sanity: it consulted the plugin's /authz endpoint with the right query
    // and bearer, and forwarded the guest's own path/method.
    const req = seen()!;
    const u = new URL(req.url);
    expect(u.pathname).toBe("/api/v1/plugins/bb-shared/http/authz");
    expect(u.searchParams.get("token")).toBe(GUEST_TOKEN);
    expect(u.searchParams.get("path")).toBe("/api/v1/threads/T1/detail");
    expect(u.searchParams.get("method")).toBe("GET");
    expect(req.headers.get("authorization")).toBe(`Bearer ${AUTHZ_TOKEN}`);
  });

  it("deny → 403 { error: scope } for an API path", async () => {
    const { router } = fakeRouter({ json: deny("denied") });
    const res = expectRespond(await authzStage(router).run(makeCtx()));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "scope", reason: "denied" });
  });

  it("missing token → 401 without consulting authz", async () => {
    const { router, seen } = fakeRouter({ throws: true });
    const res = expectRespond(
      await authzStage(router).run(makeCtx({ token: null })),
    );
    expect(res.status).toBe(401);
    expect(seen()).toBeNull();
  });

  it("thread out of scope → 403", async () => {
    // 06 answers allowed:false for a thread the token doesn't cover.
    const { router } = fakeRouter({
      json: deny("thread T9 not in token scope"),
    });
    const res = expectRespond(
      await authzStage(router).run(
        makeCtx({ pathname: "/api/v1/threads/T9/detail" }),
      ),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { reason?: string };
    expect(body.reason).toMatch(/not in token scope/);
  });

  it("mutating write without perm → 403", async () => {
    // POST /threads/T1/send with only read perm — 06 denies.
    const { router } = fakeRouter({
      json: deny("write permission required on thread T1"),
    });
    const res = expectRespond(
      await authzStage(router).run(
        makeCtx({ pathname: "/api/v1/threads/T1/send", method: "POST" }),
      ),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { reason?: string };
    expect(body.reason).toMatch(/write permission required/);
  });

  it("deny on an HTML path → 404 (not a JSON scope body)", async () => {
    const { router } = fakeRouter({ json: deny("nope") });
    const res = expectRespond(
      await authzStage(router).run(
        makeCtx({ pathname: "/projects/P2/threads/T2" }),
      ),
    );
    expect(res.status).toBe(404);
  });

  it("fails closed on a non-2xx authz response (bearer rejected)", async () => {
    const { router } = fakeRouter({
      raw: new Response("unauthorized", { status: 401 }),
    });
    const res = expectRespond(await authzStage(router).run(makeCtx()));
    expect(res.status).toBe(403);
  });

  it("passes a 503 tunnel-offline through so the SPA retries", async () => {
    const { router } = fakeRouter({
      raw: new Response('{"error":"tunnel_offline"}', { status: 503 }),
    });
    const res = expectRespond(await authzStage(router).run(makeCtx()));
    expect(res.status).toBe(503);
  });

  it("fails closed when the tunnel throws", async () => {
    const { router } = fakeRouter({ throws: true });
    const res = expectRespond(await authzStage(router).run(makeCtx()));
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Route lockouts
// ---------------------------------------------------------------------------

describe("isLockedRoute", () => {
  it("locks the four owner-only SPA route families", () => {
    for (const p of [
      "/settings",
      "/settings/general",
      "/extensions/foo",
      "/tools",
      "/hosts/bar",
    ]) {
      expect(isLockedRoute(p)).toBe(true);
    }
  });

  it("does not lock API endpoints or guest routes", () => {
    expect(isLockedRoute("/api/v1/hosts")).toBe(false);
    expect(isLockedRoute("/projects/P1/threads/T1")).toBe(false);
    expect(isLockedRoute("/settingsish")).toBe(false);
  });
});

describe("routeLockoutsStage", () => {
  it("redirects a locked route to /{token}/ via a client-side HTML page", async () => {
    const res = expectRespond(
      routeLockoutsStage.run(makeCtx({ pathname: "/settings/general" })) as StageResult,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain(`/${GUEST_TOKEN}/`);
    expect(body).toContain("location.replace");
  });

  it("passes non-locked routes through", () => {
    const r = routeLockoutsStage.run(
      makeCtx({ pathname: "/projects/P1/threads/T1" }),
    ) as StageResult;
    expect(r.kind).toBe("continue");
  });

  it("lockoutRedirectHtml targets the token root", () => {
    expect(lockoutRedirectHtml(GUEST_TOKEN)).toContain(`/${GUEST_TOKEN}/`);
  });
});
