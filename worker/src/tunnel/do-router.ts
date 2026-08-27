/**
 * TunnelRouter backed by a Durable Object.
 *
 * The DO namespace is singleton — one instance per worker deployment — because
 * a worker owns exactly one bb server per SPEC. All requests are routed to
 * `idFromName("singleton")`.
 */

import type { Env } from "../env.js";
import type { TunnelRouter } from "./interface.js";

export const TUNNEL_DO_SINGLETON_NAME = "singleton";

export function tunnelRouterFor(env: Env): TunnelRouter {
  const id = env.TUNNEL_DO.idFromName(TUNNEL_DO_SINGLETON_NAME);
  const stub = env.TUNNEL_DO.get(id);
  return {
    acceptTunnelDial: (request) => stub.fetch(request),
    dispatch: (request) => stub.fetch(request),
  };
}
