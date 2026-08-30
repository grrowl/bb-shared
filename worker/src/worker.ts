/**
 * bb-shared worker entry point.
 *
 * Wiring diagram, top to bottom:
 *
 *   fetch(request, env, ctx)
 *     ├─ /__tunnel  → tunnel router.acceptTunnelDial (bearer-auth in DO)
 *     └─ everything else → runPipeline([
 *          extractTokenStage,           // token → path/query/cookie → 401 if none
 *          setCookieRedirectStage,      // ?token= → cookie + 302 to /{token}/…
 *          prepareTunnelRequestStage,   // Origin := worker public origin
 *          routeLockoutsStage,          // /settings|/extensions|/tools|/hosts → /{token}/
 *          authzStage(router),          // consult 06's /authz → ctx.scope, 403/404 on deny
 *          wsFrameFilterStage(router),  // WS upgrades: 403 terminals, filter /ws
 *          responseFiltersStage(router),// scope-shape bootstrap JSON endpoints
 *          chromeShimStage(             // 12: decorate dispatch — inject the
 *            dispatchStage(router)),    //   guest chrome shim into text/html
 *        ])                             // dispatch → tunnel DO → local bb
 *
 * The authz stage (issue 10) populates `ctx.scope`, so it runs BEFORE every
 * scope-enforcing stage: the WS frame filter (11) and the response filters (09),
 * both of which treat a null scope as deny-everything.
 *
 * The chrome shim (issue 12) decorates the terminal dispatch rather than
 * trailing it: dispatch short-circuits with `respond`, so a plain post-dispatch
 * stage would never run. It only touches `text/html` guest responses.
 */

import type { Env } from "./env.js";
import { runPipeline, type RequestContext } from "./pipeline.js";
import { extractTokenStage } from "./stages/extract-token.js";
import { setCookieRedirectStage } from "./stages/set-cookie-redirect.js";
import { prepareTunnelRequestStage } from "./stages/prepare-tunnel-request.js";
import { routeLockoutsStage } from "./stages/route-lockouts.js";
import { authzStage } from "./stages/authz.js";
import { wsFrameFilterStage } from "./stages/ws-frame-filter.js";
import { responseFiltersStage } from "./stages/response-filters.js";
import { dispatchStage } from "./stages/dispatch.js";
import { chromeShimStage } from "./stages/chrome-shim.js";
import { tunnelRouterFor } from "./tunnel/do-router.js";
import { TunnelDO } from "./tunnel/tunnel-do.js";

export { TunnelDO };

const TUNNEL_PATH = "/__tunnel";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const router = tunnelRouterFor(env);

    // Tunnel dial is a separate namespace — never runs through the guest
    // pipeline. Bearer auth is enforced inside the DO where the WS is
    // actually accepted.
    if (url.pathname === TUNNEL_PATH) {
      return router.acceptTunnelDial(request);
    }

    const initial: RequestContext = {
      request,
      url,
      env,
      ctx,
      workerPublicOrigin: url.origin,
      token: null,
      scope: null,
      perms: null,
    };

    return runPipeline(
      [
        extractTokenStage,
        setCookieRedirectStage,
        prepareTunnelRequestStage,
        // Route lockouts: bounce guest hard-navigations to owner-only SPA
        // routes (/settings, /extensions, /tools, /hosts) back to /{token}/
        // before authz would otherwise 404 them as unrecognized paths.
        routeLockoutsStage,
        // Authz gate (issue 10): the single consultation of 06's /authz
        // endpoint. Populates `ctx.scope` for the scope-enforcing stages
        // below, and 403s (API) / 404s (HTML) a denied request. Must run
        // BEFORE both wsFrameFilterStage and responseFiltersStage.
        authzStage(router),
        // WS filter runs before dispatch: it owns every WebSocket upgrade
        // (rejects terminals, interposes the frame filter on /ws) and passes
        // plain HTTP straight through to the dispatch stage.
        wsFrameFilterStage(router),
        // 09 response filters: reshape scoped bootstrap endpoints (system
        // config, sidebar, plugins, hosts, plugin-settings) before dispatch.
        // Reads `ctx.scope`, populated by the authz stage above.
        responseFiltersStage(router),
        // 12 SPA chrome shim: decorates the terminal dispatch so guest
        // `text/html` responses get a `<head>` shim that hides owner-only
        // chrome. Wraps dispatch (rather than trailing it) because dispatch
        // short-circuits with `respond` — a plain trailing stage never runs.
        // Non-HTML responses pass through untouched.
        chromeShimStage(dispatchStage(router)),
      ],
      initial,
    );
  },
} satisfies ExportedHandler<Env>;
