/** Stable transport only. Guest permissions and sessions live in the BB plugin. */
import type { Env } from "./env.js";
import { RELAY_IDENTITY, RELAY_IDENTITY_PATH, PUBLIC_ORIGIN_HEADER } from "@bb-shared/tunnel-contract";
import { tunnelRouterFor } from "./tunnel/do-router.js";
export { TunnelDO } from "./tunnel/tunnel-do.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === RELAY_IDENTITY_PATH) {
      return Response.json({ ...RELAY_IDENTITY, relayId: env.TUNNEL_DO.idFromName("singleton").toString() }, { headers: { "cache-control": "no-store" } });
    }
    const router = tunnelRouterFor(env);
    if (url.pathname === "/__tunnel") return router.acceptTunnelDial(request);
    const headers = new Headers(request.headers);
    // Overwrite caller input: the gateway needs the actual incoming origin,
    // including custom domains, independently of the configured tunnel address.
    headers.set(PUBLIC_ORIGIN_HEADER, url.origin);
    return router.dispatch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;
