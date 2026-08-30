import { describe, expect, it } from "vitest";
import {
  authzStage,
  denyForPath,
  isApiPath,
  isGuestDeniedRpcPath,
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
  project_scope: ["P1"],
  perms: [{ thread_id: "T1", mode: "write" }],
  ...over,
});
const deny = (reason: string): AuthzResponse => ({
  allowed: false,
  thread_scope: [],
  project_scope: [],
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

  it("maps project_scope → projectIds (issue 19)", () => {
    const scope = scopeFromAuthz(
      allow({ thread_scope: ["T1", "T2"], project_scope: ["P1", "P2"] }),
    );
    expect([...scope.projectIds].sort()).toEqual(["P1", "P2"]);
  });

  it("multiple threads in one project → single project id", () => {
    // 06 dedupes project_scope, so two same-project threads yield one entry.
    const scope = scopeFromAuthz(
      allow({ thread_scope: ["T1", "T2"], project_scope: ["P1"] }),
    );
    expect([...scope.projectIds]).toEqual(["P1"]);
  });

  it("yields empty projectIds when project_scope is empty", () => {
    const scope = scopeFromAuthz(allow({ project_scope: [] }));
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
    // project_scope (issue 19) flows straight into GuestScope.projectIds.
    expect(cont.ctx.scope?.projectIds.has("P1")).toBe(true);

    // Sanity: it consulted the plugin's /authz endpoint with the right query
    // and bearer, and forwarded the guest's own path/method.
    const req = seen()!;
    const u = new URL(req.url);
    expect(u.pathname).toBe("/api/v1/plugins/shared/http/authz");
    expect(u.searchParams.get("token")).toBe(GUEST_TOKEN);
    expect(u.searchParams.get("path")).toBe("/api/v1/threads/T1/detail");
    expect(u.searchParams.get("method")).toBe("GET");
    // bb's plugin-token auth (0.40) reads `x-bb-plugin-token`, NOT
    // `Authorization: Bearer` (which bb 401s). Sending it wrong 404s every
    // guest request against a real bb.
    expect(req.headers.get("x-bb-plugin-token")).toBe(AUTHZ_TOKEN);
    expect(req.headers.get("authorization")).toBeNull();
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

  // M2 (ticket 20): plugin RPC is owner-only. A guest hitting the RPC transport
  // must be denied at the worker — before /authz is consulted — so the CF
  // claim.url account-takeover bearer behind getClaimUrl/getWorkerStatus is
  // never reachable through the guest proxy.
  it("denies a guest getWorkerStatus RPC with 403 without consulting authz (M2)", async () => {
    const { router, seen } = fakeRouter({ throws: true });
    const res = expectRespond(
      await authzStage(router).run(
        makeCtx({
          pathname: "/api/v1/plugins/shared/rpc/getWorkerStatus",
          method: "POST",
        }),
      ),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "scope",
      reason: "plugin rpc is not guest-reachable",
    });
    // Deny-closed locally — the request was never dispatched over the tunnel.
    expect(seen()).toBeNull();
  });

  it("denies a guest getClaimUrl RPC with 403 (M2)", async () => {
    const { router, seen } = fakeRouter({ throws: true });
    const res = expectRespond(
      await authzStage(router).run(
        makeCtx({
          pathname: "/api/v1/plugins/shared/rpc/getClaimUrl",
          method: "POST",
        }),
      ),
    );
    expect(res.status).toBe(403);
    expect(seen()).toBeNull();
  });
});

describe("isGuestDeniedRpcPath", () => {
  it("matches the shared plugin RPC transport paths (M2, ticket 22 id)", () => {
    expect(isGuestDeniedRpcPath("/api/v1/plugins/shared/rpc/getWorkerStatus")).toBe(
      true,
    );
    expect(isGuestDeniedRpcPath("/api/v1/plugins/shared/rpc/getClaimUrl")).toBe(
      true,
    );
    expect(isGuestDeniedRpcPath("/api/v1/plugins/shared/rpc")).toBe(true);
  });

  it("does not match the authz http route or unrelated paths", () => {
    // The worker's own bearer-authed authz pull must not be denied.
    expect(isGuestDeniedRpcPath("/api/v1/plugins/shared/http/authz")).toBe(false);
    expect(isGuestDeniedRpcPath("/api/v1/threads/T1/send")).toBe(false);
    expect(isGuestDeniedRpcPath("/api/v1/plugins")).toBe(false);
    // Guard against a substring/prefix false-positive.
    expect(isGuestDeniedRpcPath("/api/v1/plugins/shared/rpcish/x")).toBe(false);
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
