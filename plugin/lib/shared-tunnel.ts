// SharedTunnel — the local half of the bb-shared tunnel.
//
// Opens a WebSocket to our deployed CF worker's `/__tunnel` route, authed with
// a bearer secret (the worker's `TUNNEL_SECRET`), and hands the live socket to
// the vendored `TunnelSession`, which proxies relayed guest HTTP/WS streams to
// the local bb server's loopback origin. Reconnects with capped exponential
// backoff.
//
// Wrapper only: the wire protocol + the header rewrite that makes the local
// Origin guard pass both live in the vendored packages.
//
// Owned by the lifecycle manager: on (re)deploy it constructs a SharedTunnel
// with the fresh `{ workerUrl, tunnelSecret }`, calls `start()`, and calls
// `stop()` on the previous one. Each instance targets one worker deployment.
import { WebSocket as NodeWebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  TUNNEL_PROTOCOL_QUERY_PARAM,
} from "@bb-shared/tunnel-contract";
import {
  ReconnectBackoff,
  TunnelSession,
  humanizeTransportError,
} from "@bb-shared/tunnel-client";

/** Structural subset of bb's PluginLogger; `bb.log` satisfies it directly. */
export interface TunnelLogger {
  debug?(message: string): void;
  info?(message: string): void;
  warn(message: string): void;
  error?(message: string): void;
}

export type TunnelState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "stopped";

export interface SharedTunnelOptions {
  /** Full URL of our deployed worker, e.g. `https://guests-abc.workers.dev`. */
  workerUrl: string;
  /**
   * Bearer the worker expects as `env.TUNNEL_SECRET`. Sent as
   * `Authorization: Bearer <tunnelSecret>` on the `/__tunnel` upgrade — this is
   * the entire handshake (the WS upgrade IS the auth; no back-channel).
   */
  tunnelSecret: string;
  /**
   * Local bb server loopback base, e.g. `http://127.0.0.1:38886`
   * (`bb.server.loopbackBaseUrl`). Guest `Origin` is rewritten to this origin
   * before the request reaches bb, so it lands in bb's allowlist.
   */
  loopbackBaseUrl: string;
  log: TunnelLogger;
  /** Fired on every state transition (owner-panel status plumbing). */
  onStatusChange?: (state: TunnelState) => void;
}

export interface TunnelStatus {
  state: TunnelState;
  workerUrl: string;
  /** Guest connections currently live through this tunnel (bare-handle /ws). */
  remoteClients: number;
  lastConnectedAt: number | null;
  lastError: string | null;
}

export class SharedTunnel {
  private readonly publicOrigin: string;
  private readonly loopbackOrigin: string;
  private readonly host: string;

  private socket: NodeWebSocket | undefined;
  private session: TunnelSession | undefined;
  private readonly backoff = new ReconnectBackoff();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  private stopped = true;
  private state: TunnelState = "disconnected";
  private connectedAt: number | null = null;
  private lastConnectedAt: number | null = null;
  private lastError: string | null = null;
  private remoteClients = 0;

  constructor(private readonly opts: SharedTunnelOptions) {
    // Validate + derive the two origins headersForLoopbackRequest keys off.
    const workerUrlParsed = new URL(opts.workerUrl);
    this.publicOrigin = workerUrlParsed.origin;
    this.host = workerUrlParsed.host;
    this.loopbackOrigin = opts.loopbackBaseUrl.replace(/\/$/u, "");
    // Fail fast on a malformed loopback base rather than at first request.
    new URL(this.loopbackOrigin);
    if (opts.tunnelSecret.length === 0) {
      throw new Error("SharedTunnel: tunnelSecret must be non-empty");
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.backoff.reset();
    this.open();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.teardownSocket();
    this.setState("stopped");
  }

  getStatus(): TunnelStatus {
    return {
      state: this.state,
      workerUrl: this.opts.workerUrl,
      remoteClients: this.remoteClients,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
    };
  }

  private setState(next: TunnelState): void {
    if (this.state === next) return;
    this.state = next;
    this.opts.onStatusChange?.(next);
  }

  private teardownSocket(): void {
    this.session?.dispose();
    this.session = undefined;
    this.remoteClients = 0;
    if (this.socket) {
      // Drop our listeners before terminating so the 'close' handler does not
      // schedule a reconnect for a socket we are intentionally discarding.
      this.socket.removeAllListeners();
      this.socket.terminate();
      this.socket = undefined;
    }
  }

  private open(): void {
    if (this.stopped) return;
    const wsUrl = new URL(
      this.opts.workerUrl.replace(/^http/u, "ws").replace(/\/$/u, "") +
        "/__tunnel",
    );
    wsUrl.searchParams.set(
      TUNNEL_PROTOCOL_QUERY_PARAM,
      String(PROTOCOL_VERSION),
    );
    this.setState("connecting");

    const sock = new NodeWebSocket(wsUrl.toString(), {
      headers: { authorization: `Bearer ${this.opts.tunnelSecret}` },
      handshakeTimeout: 15_000,
    });
    this.socket = sock;

    sock.on("open", () => {
      this.connectedAt = Date.now();
      this.lastConnectedAt = this.connectedAt;
      this.lastError = null;
      this.backoff.reset();
      this.opts.log.info?.("shared tunnel connected");
      this.setState("connected");
      this.session = new TunnelSession({
        tunnel: sock,
        log: this.opts.log,
        // Single origin: our worker's public origin → local bb loopback. No
        // shares, no ports — every stream is bare-handle bb traffic.
        resolveOrigin: () => ({
          kind: "ok",
          resolved: {
            origin: this.loopbackOrigin,
            publicOrigin: this.publicOrigin,
          },
        }),
        onRemoteClientsChange: (n) => {
          this.remoteClients = n;
        },
      });
      this.session.start();
    });

    sock.on("unexpected-response", (_req, res) => {
      res.resume();
      const status = res.statusCode ?? 0;
      this.lastError = `worker rejected tunnel: HTTP ${status}`;
      this.opts.log.warn(this.lastError);
      if (status === 401 || status === 403) {
        // Bearer is wrong — reconnecting with the same secret cannot help.
        // Stay down until 07's lifecycle hands us a fresh SharedTunnel.
        this.stop();
        return;
      }
      this.scheduleReconnect();
    });

    sock.on("error", (e: Error) => {
      this.lastError = humanizeTransportError(e, this.host);
      this.opts.log.warn(this.lastError);
      // 'error' is followed by 'close'; reconnect is scheduled there.
    });

    sock.on("close", () => {
      this.session?.dispose();
      this.session = undefined;
      this.remoteClients = 0;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.retryTimer !== undefined) return; // already scheduled
    const stableMs =
      this.connectedAt === null ? 0 : Date.now() - this.connectedAt;
    this.connectedAt = null;
    const delay = this.backoff.nextDelayAfterClose(stableMs);
    this.setState("reconnecting");
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.open();
    }, delay);
    this.retryTimer.unref?.();
  }
}
