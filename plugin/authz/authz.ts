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
  // `rest` is the subpath after the thread id ("" or e.g. "/send"), so the
  // decision can allow only `POST …/send` as a guest mutation (issue 23).
  | { kind: "thread"; threadId: string; rest: string }
  // A specific project's metadata; allowed only if the token shares it (24).
  | { kind: "project"; projectId: string }
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
// `/projects` is intentionally NOT here — project paths get their own scoped
// classification (see `classifyPath`), so an out-of-scope project read is
// denied instead of passed through (issue 24).
const NON_THREAD_PREFIXES = ["/plugin-settings", "/plugins", "/hosts"];

// Static frontend assets. Two safe shapes only: the hashed bundle under
// `/assets/…`, and a single-segment root file with a static extension
// (favicons, manifest, fonts). Both structurally exclude `/threads/…` and
// `/projects/…` (which have deeper segments), so a scoped path can never be
// mistaken for a static asset even though this is checked first.
const STATIC_ASSET_PREFIX = "/assets/";
const ROOT_STATIC_FILE_RE =
  /^\/[^/]+\.(?:js|mjs|css|map|woff2?|ttf|otf|png|jpe?g|gif|svg|ico|webp|avif|webmanifest)$/i;

/** True for a guest-safe static frontend asset (read-only bundle / root file). */
export function isStaticAssetPath(path: string): boolean {
  return path.startsWith(STATIC_ASSET_PREFIX) || ROOT_STATIC_FILE_RE.test(path);
}

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
  if (!path) return { kind: "invalid" };

  // The SPA shell (`/`) and its static bundle. bb serves its frontend as a
  // hashed asset graph under `/assets/…` plus a few root files (favicons,
  // manifest, fonts), all fetched at ABSOLUTE paths with no token — the guest's
  // session cookie authenticates them (issue 06 worker cookie flow). They carry
  // no per-guest data (the same bytes for everyone; all scoping is via the API),
  // so a read is safe. Matched before the API branches; thread/project paths are
  // matched first below, so a scoped path can never fall through to here. GET is
  // allowed and mutation denied by `computeAuthz`'s non-thread rule (issue 23).
  if (path === "/" || isStaticAssetPath(path)) return { kind: "non-thread" };

  // Thread paths, top-level or nested under a project. A project-nested thread
  // path (`/projects/{p}/threads/{t}`) MUST classify as a thread so it goes
  // through the thread scope + perm gate, not the project or non-thread branch
  // (issue 24 escalation). `rest` captures the subpath after the thread id.
  const threadMatch = path.match(
    /^(?:\/projects\/[^/]+)?\/threads\/([^/]+)(\/.*)?$/,
  );
  if (threadMatch) {
    return { kind: "thread", threadId: threadMatch[1], rest: threadMatch[2] ?? "" };
  }

  // A specific project's metadata (`/projects/{p}` and subpaths). Scoped in
  // `computeAuthz` (issue 24). A bare `/projects` list has no id to scope, so
  // it does not match here and falls through to invalid → denied: a guest gets
  // its scoped project/thread tree from `/sidebar-bootstrap`, not the raw list.
  const projectMatch = path.match(/^\/projects\/([^/]+)(?:\/.*)?$/);
  if (projectMatch) return { kind: "project", projectId: projectMatch[1] };

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
  const mutating = isMutatingMethod(method);
  const allow = (): AuthzResult => ({
    allowed: true,
    thread_scope,
    project_scope,
    perms,
  });
  const deny = (reason: string): AuthzResult => ({
    allowed: false,
    thread_scope,
    project_scope,
    perms,
    reason,
  });

  switch (classified.kind) {
    case "invalid":
      return deny(`unrecognized path: ${path || "(empty)"}`);

    case "non-thread":
      // Guests may READ the worker-shaped bootstrap endpoints, never mutate
      // them. Deny by default for any mutating method so a guest cannot POST to
      // another plugin's RPC or write to plugin-settings/hosts (issue 23).
      if (mutating) return deny(`guest may not ${method} ${path}`);
      return allow();

    case "project":
      // Project metadata is read-only for guests, and only for a project the
      // token actually shares (issue 24).
      if (mutating) return deny(`guest may not ${method} ${path}`);
      if (!project_scope.includes(classified.projectId)) {
        return deny(`project ${classified.projectId} not in token scope`);
      }
      return allow();

    case "thread": {
      const { threadId, rest } = classified;
      const share = token.shares.find((s) => s.thread_id === threadId);
      if (!share) return deny(`thread ${threadId} not in token scope`);
      if (mutating) {
        // The ONLY mutation a guest may perform is `POST /threads/{t}/send`
        // with write (SPEC §"Mutation gate"). Every other mutating thread
        // subpath — delete, abort, config — is denied even for a write guest
        // (issue 23).
        const isSend = method.toUpperCase() === "POST" && rest === "/send";
        if (!isSend) {
          return deny(`guest may only POST /threads/${threadId}/send`);
        }
        if (share.perm !== "write") {
          return deny(`write permission required on thread ${threadId}`);
        }
      }
      return allow();
    }
  }
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
