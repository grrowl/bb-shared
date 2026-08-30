/**
 * Token extraction.
 *
 * Per SPEC, a guest URL takes one of two shapes:
 *
 *   1. Primary:   /{token}/projects/{p}/threads/{t}
 *   2. Fallback:  /projects/{p}/threads/{t}?token=…
 *
 * After the fallback lands, the worker sets `bb_shared_session=<token>` as a
 * cookie and 302s to the primary shape. From then on, every subsequent request
 * carries the token via the path — cookie is the tiebreaker if a nested
 * SPA-issued fetch drops back to a token-less path.
 *
 * Precedence when multiple sources are present on one request:
 *
 *     path token > query token > cookie
 *
 * A path token is authoritative because it is what the guest is actually
 * browsing (and, unlike cookie, is per-URL rather than per-browser). A query
 * token is second because it means the owner just shared a fresh URL — that
 * takes priority over any older session cookie. Cookie is the baseline.
 *
 * Format: from SPEC `Token = "bbsh_" + 32B base64url`. We accept 32 to 64
 * base64url characters after the prefix so the id length can grow without a
 * worker deploy.
 */

export const SESSION_COOKIE_NAME = "bb_shared_session";
export const TOKEN_QUERY_PARAM = "token";
export const TOKEN_PREFIX = "bbsh_";

const TOKEN_RE = /^bbsh_[A-Za-z0-9_-]{32,64}$/;

export function isValidToken(v: string | null | undefined): v is string {
  return typeof v === "string" && TOKEN_RE.test(v);
}

export type TokenSource = "path" | "query" | "cookie";

export interface ExtractedToken {
  token: string;
  source: TokenSource;
  /**
   * Path with the leading `/{token}` prefix stripped when `source === "path"`.
   * For `query`/`cookie` sources, equals `url.pathname` unchanged.
   *
   * Always begins with "/". The empty path after `/{token}` becomes "/".
   */
  pathAfterToken: string;
}

/**
 * Extract the token from a request. Returns null if none of the three sources
 * yield a well-formed token.
 *
 * @param url — the parsed request URL. Only `pathname` and `searchParams` read.
 * @param cookies — map from `parseCookieHeader(request.headers.get("cookie"))`.
 */
export function extractToken(
  url: URL,
  cookies: ReadonlyMap<string, string>,
): ExtractedToken | null {
  // Path segment 1
  //
  // "/bbsh_…/foo/bar" → ["", "bbsh_…", "foo", "bar"] — segment index 1 is
  // the candidate token. A trailing slash on "/{token}" produces ["", "{tok}", ""]
  // which we normalise to "/".
  const segments = url.pathname.split("/");
  if (segments.length >= 2 && isValidToken(segments[1])) {
    const rest = segments.slice(2).join("/");
    const pathAfterToken = rest.length > 0 ? `/${rest}` : "/";
    return {
      token: segments[1],
      source: "path",
      pathAfterToken,
    };
  }

  // Query fallback
  const query = url.searchParams.get(TOKEN_QUERY_PARAM);
  if (isValidToken(query)) {
    return {
      token: query,
      source: "query",
      pathAfterToken: url.pathname,
    };
  }

  // Cookie baseline
  const cookie = cookies.get(SESSION_COOKIE_NAME);
  if (isValidToken(cookie)) {
    return {
      token: cookie,
      source: "cookie",
      pathAfterToken: url.pathname,
    };
  }

  return null;
}

/**
 * Build the clean redirect target for a query-token hit: strip the `?token=`
 * param, preserve every other query param and the fragment, and drop the token
 * from the URL entirely — the session cookie set in the same 302 carries it on
 * every following request. The result is a CLEAN bb path (no `/{token}` prefix)
 * so bb's own client-side router recognises the route and opens the shared
 * thread directly; a token-prefixed path would be an unknown route and the SPA
 * would fall back to `/`. The `token` arg is unused now but kept for callers.
 *
 * Example:
 *   in:  https://guests.example.com/projects/p1?token=bbsh_XXX&foo=bar#h
 *   out: /projects/p1?foo=bar#h
 */
export function buildCleanRedirectPath(url: URL, _token: string): string {
  const params = new URLSearchParams(url.searchParams);
  params.delete(TOKEN_QUERY_PARAM);
  const query = params.toString();
  const path = url.pathname === "/" ? "/" : url.pathname;
  return path + (query.length > 0 ? `?${query}` : "") + (url.hash || "");
}
