/**
 * Origin header handling — the load-bearing constraint from spike 02.
 *
 * The vendored `headersForLoopbackRequest` on the local half (issue 14)
 * rewrites the guest's `Origin` from the worker's `publicOrigin` to the
 * local bb's loopback origin, so bb's own Origin guard
 * (`apps/server/src/browser-request-guard.ts`) accepts the request. If the
 * worker strips or garbles the header, the rewrite fails to match and local
 * bb answers 403.
 *
 * Two acceptable strategies (per ticket 08):
 *   a) preserve the guest's incoming `Origin` unchanged
 *   b) unconditionally set `Origin` to `new URL(request.url).origin`
 *
 * We take (b). Reasons:
 *   - Deterministic. Non-browser clients that omit Origin still get one, so
 *     the tunnel client can rely on Origin being present.
 *   - Defends against a guest browser being tricked into sending a stale
 *     Origin from an earlier host (worker URLs are per-deploy).
 *   - The guest's own Origin, when set, equals the worker's public origin
 *     anyway — same-origin navigation on the worker host.
 *
 * Whichever we pick, we must never DELETE the Origin header (per spike 02).
 */

export function prepareOriginForTunnel(
  request: Request,
  workerPublicOrigin: string,
): Request {
  const headers = new Headers(request.headers);
  headers.set("origin", workerPublicOrigin);
  return new Request(request, { headers });
}

/** Read the worker's own public origin from the incoming request. */
export function workerPublicOriginOf(request: Request): string {
  return new URL(request.url).origin;
}
