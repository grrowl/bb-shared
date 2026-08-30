// Tunnel-secret disambiguation probe (issue 28 §11.3).
//
// When two granted accounts both hold a `bb-shared`, the genuine one is
// the account whose worker accepts OUR tunnel secret on the `/__tunnel`
// handshake. The worker checks the bearer against `env.TUNNEL_SECRET` and
// replies 101 (accepted) or 401 (rejected) — see worker/src/tunnel/tunnel-do.ts.
// We open the same WebSocket dial the SharedTunnel uses and read that outcome.
//
// Kept separate from the resolution logic (cf-api.ts) so that logic tests with a
// fake probe; this default impl is the only piece that touches a real socket.
import { WebSocket as NodeWebSocket } from "ws";

/**
 * Dial `wss://<hostname>/__tunnel` with the secret and resolve true iff the
 * worker accepts the handshake (HTTP 101). A 401/other rejection, or any error,
 * resolves false — a wrong candidate must never be adopted. Bounded by
 * `timeoutMs`.
 */
export async function probeTunnelSecret(
  hostname: string,
  tunnelSecret: string,
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const wsUrl = `wss://${hostname}/__tunnel`;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (accepted: boolean, sock?: NodeWebSocket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock?.close();
      } catch {
        // closing a socket mid-handshake can throw; the result already stands
      }
      resolve(accepted);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();

    let sock: NodeWebSocket;
    try {
      sock = new NodeWebSocket(wsUrl, {
        headers: { authorization: `Bearer ${tunnelSecret}` },
      });
    } catch {
      done(false);
      return;
    }
    // 'open' means the 101 upgrade succeeded → our secret was accepted.
    sock.on("open", () => done(true, sock));
    // 'unexpected-response' carries the HTTP status when the upgrade is refused
    // (401 = wrong secret). Anything here is a rejection.
    sock.on("unexpected-response", () => done(false, sock));
    sock.on("error", () => done(false, sock));
  });
}
