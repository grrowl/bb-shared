/** Stable relay transport facade: guest authorization belongs to local BB. */
export interface TunnelRouter {
  /** Validate the pairing credential and wire protocol, then accept the socket. */
  acceptTunnelDial(request: Request): Promise<Response>;
  /** Forward HTTP or WebSocket traffic; disconnected tunnels answer 503. */
  dispatch(request: Request): Promise<Response>;
}
