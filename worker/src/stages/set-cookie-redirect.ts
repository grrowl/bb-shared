/**
 * Stage 2: if the token arrived via `?token=`, drop a session cookie and 302
 * to the clean `/{token}/…` path. Runs before any tunnel dispatch so the
 * browser never sees the fallback URL as the resolved location.
 *
 * Only fires when the current request is the query fallback — recognisable
 * because ctx.url still carries `?token=` (the extract-token stage does not
 * mutate the query params when source is `"query"`).
 *
 * Cookie flags per SPEC:
 *   - `HttpOnly` — SPA has no reason to read the token
 *   - `Secure`   — worker.dev is HTTPS
 *   - `SameSite=Lax` — first-party cross-site navigations still deliver it
 *
 * We set `Max-Age` to 30 days as a generous ceiling; the real revocation
 * story is that a stale token 401s at authz (issue 06). Cookie survival past
 * a token deletion is harmless.
 */

import { serializeSessionCookie } from "../cookie.js";
import { cont, respond, type Stage } from "../pipeline.js";
import {
  SESSION_COOKIE_NAME,
  TOKEN_QUERY_PARAM,
  buildCleanRedirectPath,
} from "../token.js";

const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export const setCookieRedirectStage: Stage = {
  name: "set-cookie-redirect",
  run(ctx) {
    if (ctx.token === null) return cont(ctx);
    if (!ctx.url.searchParams.has(TOKEN_QUERY_PARAM)) return cont(ctx);

    const location = buildCleanRedirectPath(ctx.url, ctx.token);
    const secure = ctx.url.protocol === "https:";
    const cookie = serializeSessionCookie(SESSION_COOKIE_NAME, ctx.token, {
      secure,
      path: "/",
      maxAgeSeconds: COOKIE_MAX_AGE_SECONDS,
    });

    return respond(
      new Response(null, {
        status: 302,
        headers: {
          location,
          "set-cookie": cookie,
          "cache-control": "no-store",
        },
      }),
    );
  },
};
