/**
 * Stage 10: authz gate + scope population.
 *
 * This stage is the worker's single consultation of the plugin's `/authz`
 * endpoint (issue 06). It does NO independent authz logic — no path allowlist,
 * no mutation check, no perm comparison. Every allow/deny decision, the thread
 * scope, and the per-thread perms come from 06's response, which the worker
 * enforces verbatim (SPEC §"Worker knowledge of scope").
 *
 * Per guest request:
 *
 *   1. Call `GET /api/v1/plugins/bb-shared/http/authz?token=…&path=…&method=…`
 *      over the tunnel, bearer-authed with `env.AUTHZ_TOKEN` (issue 07).
 *   2. Parse `{ allowed, thread_scope, project_scope, perms, reason? }`.
 *   3. Populate `ctx.scope` (issue 11's `GuestScope`) from `thread_scope` and
 *      `project_scope`, so the WS frame filter (11) and response filters (09) —
 *      which run AFTER this stage — see a resolved scope.
 *   4. `allowed === false` → deny: `403 { error: "scope", reason }` for API
 *      paths, `404` for SPA/HTML paths. `allowed === true` → continue.
 *
 * Fails closed: an unreachable / non-2xx / malformed authz response denies the
 * request (except a `503 tunnel_offline`, which is passed through so the SPA
 * retries rather than seeing a hard scope error).
 */

import { jsonError } from "../errors.js";
import { cont, respond, type RequestContext, type Stage } from "../pipeline.js";
import type { GuestScope } from "../scope.js";
import type { TunnelRouter } from "../tunnel/interface.js";

/** Where 06's authz route lives on the local bb, behind the tunnel. */
const AUTHZ_ENDPOINT_PATH = "/api/v1/plugins/bb-shared/http/authz";

/**
 * The `/authz` response shape (issue 06's `AuthzResult`). `project_scope` (issue
 * 19) is the deduped set of project ids across the token's shares — 06 derives
 * it authoritatively, so `projectIds` comes straight from it with no worker-side
 * derivation. `perms` carries only the per-thread mode; it no longer needs a
 * `project_id` (that fallback was empty pre-19 and is now unnecessary).
 */
export interface AuthzPerm {
  thread_id: string;
  mode: "read" | "write";
}

export interface AuthzResponse {
  allowed: boolean;
  thread_scope: string[];
  project_scope: string[];
  perms: AuthzPerm[];
  reason?: string;
}

/** Translate 06's response into the `GuestScope` shape stages 09/11 consume. */
export function scopeFromAuthz(resp: AuthzResponse): GuestScope {
  const threadIds = new Set(resp.thread_scope ?? []);
  const projectIds = new Set(resp.project_scope ?? []);
  return { threadIds, projectIds };
}

/** bb's REST surface lives under `/api/`; everything else is an SPA route. */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * The scope-denial body the SPEC pins for API paths: `{ error: "scope" }` plus
 * the authoritative reason from 06 (omitted when absent). Built directly rather
 * than via `jsonError` so the key is `reason`, matching the ticket contract.
 */
function scopeDenied(reason?: string): Response {
  const body: { error: string; reason?: string } =
    reason === undefined ? { error: "scope" } : { error: "scope", reason };
  return new Response(JSON.stringify(body) + "\n", {
    status: 403,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** A denied SPA/HTML route answers 404 — the guest sees not-found, not JSON. */
function htmlNotFound(): Response {
  return new Response("Not found\n", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** Deny with the right status for the path kind: 403 for API, 404 for HTML. */
export function denyForPath(pathname: string, reason?: string): Response {
  return isApiPath(pathname) ? scopeDenied(reason) : htmlNotFound();
}

/** Build the bearer-authed authz query for this guest request. */
function buildAuthzRequest(ctx: RequestContext, token: string): Request {
  const url = new URL(AUTHZ_ENDPOINT_PATH, ctx.workerPublicOrigin);
  url.searchParams.set("token", token);
  url.searchParams.set("path", ctx.url.pathname);
  url.searchParams.set("method", ctx.request.method);
  return new Request(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${ctx.env.AUTHZ_TOKEN}`,
      // Set Origin like every tunnel-bound request so the local half's
      // loopback rewrite (issue 14) matches and bb's Origin guard accepts it.
      origin: ctx.workerPublicOrigin,
    },
  });
}

export function authzStage(router: TunnelRouter): Stage {
  return {
    name: "authz",
    async run(ctx) {
      const token = ctx.token;
      if (!token) {
        // Defensive: extract-token 401s first, but a request that reaches the
        // scope gate without a token must never resolve to a scope.
        return respond(
          jsonError(401, {
            error: "token_missing",
            detail: "no bb-shared token on request reaching the authz gate",
          }),
        );
      }

      let authzResp: Response;
      try {
        authzResp = await router.dispatch(buildAuthzRequest(ctx, token));
      } catch {
        return respond(denyForPath(ctx.url.pathname, "authz endpoint unreachable"));
      }

      // Tunnel offline (no local half connected): let the SPA's own retry loop
      // handle it rather than converting a transient outage into a scope error.
      if (authzResp.status === 503) return respond(authzResp);

      if (!authzResp.ok) {
        // Bearer rejected (401/403) or endpoint error → fail closed.
        return respond(
          denyForPath(ctx.url.pathname, `authz endpoint returned ${authzResp.status}`),
        );
      }

      let parsed: AuthzResponse;
      try {
        parsed = (await authzResp.json()) as AuthzResponse;
      } catch {
        return respond(
          denyForPath(ctx.url.pathname, "authz endpoint returned a malformed body"),
        );
      }

      // Populate scope regardless of allow/deny — it costs nothing and keeps a
      // single code path. On deny we short-circuit before any stage reads it.
      const scope = scopeFromAuthz(parsed);

      if (!parsed.allowed) {
        return respond(denyForPath(ctx.url.pathname, parsed.reason));
      }

      return cont({ ...ctx, scope });
    },
  };
}
