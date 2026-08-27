/**
 * Tunnel router — the abstraction the pipeline dispatches through.
 *
 * The concrete implementation lives in `./do-router.ts` and is backed by a
 * Durable Object (`TunnelDO`) that terminates the `/__tunnel` WebSocket from
 * the owner's local `SharedTunnel` (issue 14) and speaks the tunnel wire
 * protocol.
 *
 * `dispatch()` handles BOTH plain HTTP and WebSocket upgrades — the DO
 * introspects the incoming request's `upgrade` header. Keeping one entry
 * point on the interface means each pipeline stage stays uniform.
 *
 * `acceptTunnelDial()` is called for the special `/__tunnel` path (not part
 * of the guest pipeline) and returns either a 101 upgrade or a 401/403 error.
 */

export interface TunnelRouter {
  /**
   * Handle a `/__tunnel` upgrade from the owner's local half. Validates the
   * bearer against `env.TUNNEL_SECRET` and either accepts the WebSocket or
   * answers a 4xx with a plain-text body.
   */
  acceptTunnelDial(request: Request): Promise<Response>;

  /**
   * Forward a prepared guest request through the tunnel and return the
   * response. The request must already have its Origin header set (see
   * `prepareOriginForTunnel`).
   *
   * Answers 503 with `{ error: "tunnel_offline" }`-ish body when no tunnel
   * client is currently connected; the guest browser retries via the
   * SPA's own reconnection logic (or the owner surfaces the state in the
   * management panel).
   */
  dispatch(request: Request): Promise<Response>;
}
