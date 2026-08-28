/**
 * Stage 10 (companion): SPA route lockouts.
 *
 * A handful of SPA routes have no guest UX and would expose owner-only surfaces
 * if mounted: `/settings/*`, `/extensions/*`, `/tools/*`, `/hosts/*`. bb renders
 * them unconditionally (SPEC §"SPA chrome shim" — no gate exists), so the worker
 * intercepts a hard navigation to any of them and bounces the guest back to
 * their token root `/{token}/` before react-router mounts the locked view.
 *
 * These are SPA (HTML) routes only — the matching REST endpoints (e.g.
 * `/api/v1/hosts`) are shaped by the authz gate + response filters (09), not
 * redirected, so `/api/*` is explicitly excluded here.
 *
 * Redirect mechanism: a tiny HTML document that navigates client-side via
 * `location.replace` (with a `<meta http-equiv=refresh>` fallback), per SPEC
 * §"Route lock-outs". A same-document `location.replace` to `/{token}/` gives
 * react-router a clean full load of the SPA at the token root — it never sees
 * the locked path — which a raw 302 on an SPA-issued fetch could otherwise
 * mishandle. Runs before the authz stage so a locked route redirects rather
 * than falling through to a scope 404.
 */

import { cont, respond, type Stage } from "../pipeline.js";

const LOCKED_ROUTE_RE = /^\/(settings|extensions|tools|hosts)(\/|$)/;

/**
 * True for an SPA route the guest may not mount. `/api/*` is never a lockout —
 * those are REST endpoints handled by authz + response filters.
 */
export function isLockedRoute(pathname: string): boolean {
  if (pathname.startsWith("/api/")) return false;
  return LOCKED_ROUTE_RE.test(pathname);
}

/** The client-side redirect document that lands the guest on their token root. */
export function lockoutRedirectHtml(token: string): string {
  const target = `/${token}/`;
  const targetAttr = target.replace(/"/g, "&quot;");
  const targetJs = JSON.stringify(target);
  return (
    "<!doctype html>\n" +
    '<html lang="en"><head><meta charset="utf-8">' +
    "<title>Redirecting…</title>" +
    `<meta http-equiv="refresh" content="0; url=${targetAttr}">` +
    `<script>location.replace(${targetJs})</script>` +
    "</head><body>" +
    `<p>Redirecting to <a href="${targetAttr}">your shared threads</a>…</p>` +
    "</body></html>\n"
  );
}

export function lockoutResponse(token: string): Response {
  return new Response(lockoutRedirectHtml(token), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export const routeLockoutsStage: Stage = {
  name: "route-lockouts",
  run(ctx) {
    if (ctx.token && isLockedRoute(ctx.url.pathname)) {
      return respond(lockoutResponse(ctx.token));
    }
    return cont(ctx);
  },
};
