/**
 * Stage 1: extract the token from path / query / cookie and rewrite `request`
 * so downstream stages see the tokenless path.
 *
 * - No token anywhere → 401 with `{ error: "token_missing" }`. The SPA never
 *   navigates here; only a bare visit to the worker's origin does.
 * - Query source → hand off to the next stage (set-cookie-redirect); we do
 *   NOT rewrite the path here so that stage can construct the clean redirect.
 * - Path source → strip `/{token}` from the path in the mutated request; the
 *   guest URL from tunnel-side downstream looks like the vanilla bb SPA path.
 * - Cookie source → path is already clean, nothing to rewrite.
 */

import { jsonError } from "../errors.js";
import { acceptsHtml, sharedLinkRequiredPage } from "../guest-error-page.js";
import { cont, respond, type Stage } from "../pipeline.js";
import { parseCookieHeader } from "../cookie.js";
import { extractToken } from "../token.js";

export const extractTokenStage: Stage = {
  name: "extract-token",
  run(ctx) {
    const cookies = parseCookieHeader(ctx.request.headers.get("cookie"));
    const extracted = extractToken(ctx.url, cookies);
    if (extracted === null) {
      // Keep the 401 JSON response for non-browser callers: the plugin uses
      // this exact response to check worker health. A person opening the bare
      // worker hostname, however, should get a useful page instead of JSON.
      if (ctx.url.pathname === "/" && acceptsHtml(ctx.request)) {
        return respond(sharedLinkRequiredPage());
      }
      return respond(
        jsonError(401, {
          error: "token_missing",
          detail:
            "no bb-shared token in path, query, or session cookie — this URL was not shared with you",
        }),
      );
    }

    if (extracted.source === "path") {
      // Rewrite the request URL to strip the `/{token}` prefix. The tunnel
      // dispatch stage forwards this rewritten URL to the local bb server,
      // which knows nothing about tokens.
      const rewritten = new URL(ctx.url);
      rewritten.pathname = extracted.pathAfterToken;
      const request = new Request(rewritten, ctx.request);
      return cont({ ...ctx, request, url: rewritten, token: extracted.token });
    }

    // For query and cookie sources, url.pathname is already the tokenless path.
    return cont({ ...ctx, token: extracted.token });
  },
};
