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
 *          dispatchStage(router),       // → tunnel DO → local bb over the tunnel
 *        ])
 *
 * Layers coming later slot in as additional stages:
 *   - 09 response filters → post-dispatch stage
 *   - 10 mutation gate + route lockouts → pre-dispatch stage
 *   - 11 WS filter → wraps dispatch when `upgrade: websocket`
 *   - 12 SPA chrome shim → post-dispatch stage, html-only
 */

import type { Env } from "./env.js";
import { runPipeline, type RequestContext } from "./pipeline.js";
import { extractTokenStage } from "./stages/extract-token.js";
import { setCookieRedirectStage } from "./stages/set-cookie-redirect.js";
import { prepareTunnelRequestStage } from "./stages/prepare-tunnel-request.js";
import { dispatchStage } from "./stages/dispatch.js";
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
    };

    return runPipeline(
      [
        extractTokenStage,
        setCookieRedirectStage,
        prepareTunnelRequestStage,
        dispatchStage(router),
      ],
      initial,
    );
  },
} satisfies ExportedHandler<Env>;
