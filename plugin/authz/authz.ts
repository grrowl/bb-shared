// bb-shared authz endpoint (issue 06).
//
// A plugin-hosted, token-authenticated HTTP endpoint the CF worker pulls on
// every guest request to make the AUTHORITATIVE allow/deny decision, plus the
// token's thread scope (which the worker uses to shape its response filters,
// issue 09) and per-thread perms (which the worker's mutation gate, issue 10,
// enforces). No authz logic is duplicated in the worker — it only does path
// matching and enforces whatever we return here.
//
//   GET /api/v1/plugins/shared/http/authz?token=…&path=…&method=…
//
// Response body:
//   { allowed, thread_scope: string[], project_scope: string[],
//     perms: {thread_id, mode}[], reason? }
//
// See SPEC.md §"Worker knowledge of scope" and §"Scope enforcement".
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Perm, Store, Token } from "../lib/token-store";

// ---------------------------------------------------------------------------
// Response shape (issue 06).
// ---------------------------------------------------------------------------

export interface AuthzPerm {
  thread_id: string;
  mode: Perm;
}

export interface AuthzResult {
  allowed: boolean;
  thread_scope: string[];
  /**
   * Unique project ids across the token's shares (issue 19). Populates the
   * worker's `GuestScope.projectIds` (stages 09/11) directly — the worker no
   * longer derives it from per-thread perms. Deduped: two threads in the same
   * project yield one entry.
   */
  project_scope: string[];
  perms: AuthzPerm[];
  reason?: string;
}

// ---------------------------------------------------------------------------
// Method + path classification.
// ---------------------------------------------------------------------------

// HTTP methods that can mutate thread state. A guest needs `write` on the
// referenced thread for any of these; everything else reads.
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

type PathClass =
  | { kind: "non-thread" }
  | { kind: "thread"; threadId: string }
  | { kind: "invalid" };

// Non-thread endpoints the worker shapes via its own response filters (issue
// 09). Always allowed here; per-scope shaping is the worker's job. Matched
// after stripping the SPA's `/api/v1` prefix, so `/api/v1/system/config` and a
// pre-stripped `/system/config` classify the same.
const NON_THREAD_EXACT = new Set([
  "/system/config",
  "/sidebar-bootstrap",
  "/plugins",
  "/hosts",
]);

// Prefix families: the path itself or any subpath is a non-thread endpoint.
// `/projects` is included because SPEC's response-filter table lists
// `GET /api/v1/projects/{p}` as a guest-visible (worker-filtered) endpoint.
const NON_THREAD_PREFIXES = ["/plugin-settings", "/plugins", "/hosts", "/projects"];

/** Strip query/hash, force a leading slash, drop the `/api/v1` API prefix and
 * any trailing slash. Returns "" for empty input. */
function normalizePath(rawPath: string): string {
  if (!rawPath) return "";
  let p = rawPath.split(/[?#]/, 1)[0].trim();
  if (!p) return "";
  if (!p.startsWith("/")) p = "/" + p;
  if (p === "/api/v1") p = "/";
  else if (p.startsWith("/api/v1/")) p = p.slice("/api/v1".length);
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p;
}

export function classifyPath(rawPath: string): PathClass {
  const path = normalizePath(rawPath);
  if (!path || path === "/") return { kind: "invalid" };

  const threadMatch = path.match(/^\/threads\/([^/]+)(?:\/.*)?$/);
  if (threadMatch) return { kind: "thread", threadId: threadMatch[1] };

  if (NON_THREAD_EXACT.has(path)) return { kind: "non-thread" };
  for (const prefix of NON_THREAD_PREFIXES) {
    if (path === prefix || path.startsWith(prefix + "/")) {
      return { kind: "non-thread" };
    }
  }
  return { kind: "invalid" };
}

// ---------------------------------------------------------------------------
// Decision.
// ---------------------------------------------------------------------------

/**
 * Pure authz decision for a resolved token. `token === null` means the raw
 * bearer did not match any live token (unknown or revoked). This is the
 * authoritative decision the worker enforces verbatim.
 */
export function computeAuthz(
  token: Token | null,
  path: string,
  method: string,
): AuthzResult {
  if (!token) {
    return {
      allowed: false,
      thread_scope: [],
      project_scope: [],
      perms: [],
      reason: "unknown token",
    };
  }

  const thread_scope = token.shares.map((s) => s.thread_id);
  // Unique project ids across the token's shares (issue 19). Two threads in the
  // same project collapse to one entry; the worker's `GuestScope.projectIds`
  // consumes this directly.
  const project_scope = [...new Set(token.shares.map((s) => s.project_id))];
  const perms: AuthzPerm[] = token.shares.map((s) => ({
    thread_id: s.thread_id,
    mode: s.perm,
  }));

  const classified = classifyPath(path);

  if (classified.kind === "invalid") {
    return {
      allowed: false,
      thread_scope,
      project_scope,
      perms,
      reason: `unrecognized path: ${path || "(empty)"}`,
    };
  }

  if (classified.kind === "non-thread") {
    // Always allowed; the worker's response filters do the per-scope shaping.
    return { allowed: true, thread_scope, project_scope, perms };
  }

  // Thread path: allow iff the thread is in scope; mutating methods need write.
  const { threadId } = classified;
  const share = token.shares.find((s) => s.thread_id === threadId);
  if (!share) {
    return {
      allowed: false,
      thread_scope,
      project_scope,
      perms,
      reason: `thread ${threadId} not in token scope`,
    };
  }
  if (isMutatingMethod(method) && share.perm !== "write") {
    return {
      allowed: false,
      thread_scope,
      project_scope,
      perms,
      reason: `write permission required on thread ${threadId}`,
    };
  }
  return { allowed: true, thread_scope, project_scope, perms };
}

// ---------------------------------------------------------------------------
// Store-backed entry point + route registration.
// ---------------------------------------------------------------------------

export interface AuthzParams {
  /** Raw bearer token (43 chars of entropy behind the `bbsh_` prefix). */
  token: string | undefined;
  path: string | undefined;
  method: string | undefined;
}

/**
 * Resolve the raw bearer against the store (hashing it with the store's
 * per-process HMAC key via `findByRawToken`) and compute the decision.
 */
export async function authorize(
  store: Store,
  params: AuthzParams,
): Promise<AuthzResult> {
  const rawToken = params.token?.trim();
  if (!rawToken) {
    return {
      allowed: false,
      thread_scope: [],
      project_scope: [],
      perms: [],
      reason: "missing token",
    };
  }
  const token = await store.findByRawToken(rawToken);
  return computeAuthz(token, params.path ?? "", params.method ?? "GET");
}

/** Route path; the host mounts it under `/api/v1/plugins/<id>/http`. */
export const AUTHZ_ROUTE_PATH = "/authz";

/**
 * Register the token-authed authz route. `auth: "token"` gates it behind the
 * per-plugin token (`bb plugin token shared`, provisioned by issue 07) —
 * the worker is the only legitimate caller.
 */
export function registerAuthzRoute(bb: BbPluginApi, store: Store): void {
  bb.http.route(
    "GET",
    AUTHZ_ROUTE_PATH,
    async (context) => {
      const result = await authorize(store, {
        token: context.req.query("token"),
        path: context.req.query("path"),
        method: context.req.query("method"),
      });
      return context.json(result);
    },
    { auth: "token" },
  );
}
