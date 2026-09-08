// Local guest policy: known transcript reads and POST send with write access.
// The gateway shapes bootstrap responses and constrains message bodies.
import type { Perm, Store, Token } from "../lib/token-store";

export interface AuthzPerm {
  thread_id: string;
  mode: Perm;
}

export interface AuthzResult {
  allowed: boolean;
  thread_scope: string[];
  project_scope: string[];
  perms: AuthzPerm[];
  reason?: string;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

type PathClass =
  | { kind: "non-thread" }
  | { kind: "thread"; threadId: string; rest: string }
  | { kind: "project"; projectId: string }
  | { kind: "invalid" };

const NON_THREAD_EXACT = new Set([
  "/system/config",
  "/sidebar-bootstrap",
  "/plugins",
  "/plugins/contributions",
  "/hosts",
  "/system/execution-options",
  "/system/version",
  "/ws",
]);
const STATIC_ASSET_PREFIX = "/assets/";
const ROOT_STATIC_FILE_RE = /^\/[^/]+\.(?:js|mjs|css|map|woff2?|ttf|otf|png|jpe?g|gif|svg|ico|webp|avif|webmanifest)$/i;
export function isStaticAssetPath(path: string): boolean {
  return path.startsWith(STATIC_ASSET_PREFIX) || ROOT_STATIC_FILE_RE.test(path);
}

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
  if (!path || /[%\\\x00-\x20]/.test(path) || path.split("/").some((part) => part === "." || part === "..")) return { kind: "invalid" };

  if (path === "/" || isStaticAssetPath(path)) return { kind: "non-thread" };

  const threadMatch = path.match(
    /^(?:\/projects\/[^/]+)?\/threads\/([^/]+)(\/.*)?$/,
  );
  if (threadMatch) {
    return { kind: "thread", threadId: threadMatch[1], rest: threadMatch[2] ?? "" };
  }

  const projectMatch = path.match(/^\/projects\/([^/]+)$/);
  if (projectMatch) return { kind: "project", projectId: projectMatch[1] };

  if (NON_THREAD_EXACT.has(path)) return { kind: "non-thread" };
  if (path === "/system/providers" || /^\/system\/providers\/[^/]+\/logo$/.test(path)) return { kind: "non-thread" };
  return { kind: "invalid" };
}

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
  const project_scope = [...new Set(token.shares.map((s) => s.project_id))];
  const perms: AuthzPerm[] = token.shares.map((s) => ({
    thread_id: s.thread_id,
    mode: s.perm,
  }));

  const classified = classifyPath(path);
  const mutating = isMutatingMethod(method);
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) return { allowed: false, thread_scope, project_scope, perms, reason: "unsupported method" };
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
      if (mutating) return deny(`guest may not ${method} ${path}`);
      return allow();

    case "project":
      if (mutating) return deny(`guest may not ${method} ${path}`);
      if (!project_scope.includes(classified.projectId)) {
        return deny(`project ${classified.projectId} not in token scope`);
      }
      return allow();

    case "thread": {
      const { threadId, rest } = classified;
      const share = token.shares.find((s) => s.thread_id === threadId);
      if (!share) return deny(`thread ${threadId} not in token scope`);
      if (!mutating && !new Set(["", "/timeline", "/timeline/turn-summary-details", "/conversation-outline", "/events", "/events/wait", "/output", "/default-execution-options", "/interactions", "/queued-messages", "/prompt-history", "/tabs"]).has(rest)) return deny("thread endpoint not available to guests");
      if (mutating) {
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

export interface AuthzParams {
  token: string | undefined;
  path: string | undefined;
  method: string | undefined;
}

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
