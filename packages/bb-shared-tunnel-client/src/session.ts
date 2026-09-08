// Transport-generic tunnel client session: proxies relayed HTTP/WS streams
// from one live tunnel socket to per-stream loopback origins.
import {
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { WebSocket as NodeWebSocket } from "ws";
import {
  MAX_CHUNK_BYTES,
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  chunkBody,
  decodeFrame,
  encodeFrame,
  type Frame,
  type HeaderPair,
  type OpenHttpFrame,
  type OpenWsFrame,
} from "@bb-shared/tunnel-contract";
import { headersForLoopbackRequest } from "./headers.js";
import type { TunnelClientLogger } from "./logger.js";

const MAX_STREAMS = 128;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const MAX_WS_BUFFER_BYTES = 1024 * 1024;
const BODY_RECEIVE_TIMEOUT_MS = 30_000;

function validateOpenFrame(frame: OpenHttpFrame | OpenWsFrame): void {
  if (typeof frame.path !== "string" || !frame.path.startsWith("/") || frame.path.startsWith("//")
    || frame.path.length > 16_384 || /[\\\r\n\0]/u.test(frame.path)
    || !Array.isArray(frame.headers) || frame.headers.length > 128
    || frame.headers.some((pair) => !Array.isArray(pair) || pair.length !== 2 || pair.some((value) => typeof value !== "string" || /[\r\n\0]/u.test(value)))
    || frame.headers.reduce((bytes, pair) => bytes + pair[0].length + pair[1].length, 0) > 32_768
    || (frame.type === "open-http" && (typeof frame.method !== "string" || !/^[A-Z]{1,20}$/u.test(frame.method) || typeof frame.hasBody !== "boolean"))
    || (frame.type === "open-ws" && (!Array.isArray(frame.protocols) || frame.protocols.length > 16 || frame.protocols.some((value) => typeof value !== "string" || value.length > 256)))) {
    throw new Error("invalid stream metadata");
  }
}

const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_DEADLINE_MS = 60_000;

const UNREGISTERED_PORT_BODY = "this port is not shared";
const textEncoder = new TextEncoder();
const INITIAL_THREAD_LOAD_PATH =
  /^\/api\/v1\/threads\/[^/]+\/(?:timeline|conversation-outline)(?:\?|$)/u;

interface OriginHttpRequestArgs {
  body: Buffer | undefined;
  headers: Record<string, string>;
  method: string;
  signal: AbortSignal;
  url: URL;
}

/**
 * Restore the Content-Length that the relay strips.
 *
 * Node's HTTP client does not use chunked encoding by default for GET, HEAD,
 * and DELETE. Without a Content-Length, it writes such a body with no framing
 * at all. The origin then reads a body-less request and parses the leftover
 * bytes as the next request on that connection, which answers an empty 400.
 * An explicit Content-Length frames the body for every method.
 */
function frameBodyHeaders(
  headers: Record<string, string>,
  body: Buffer | undefined,
): Record<string, string> {
  if (body === undefined) return headers;
  return { ...headers, "Content-Length": String(body.byteLength) };
}

export function requestOriginHttp(
  args: OriginHttpRequestArgs,
): Promise<IncomingMessage> {
  const request = args.url.protocol === "https:" ? httpsRequest : httpRequest;
  const options: RequestOptions = {
    headers: frameBodyHeaders(args.headers, args.body),
    method: args.method,
    signal: args.signal,
  };
  return new Promise<IncomingMessage>((resolve, reject) => {
    const originRequest = request(args.url, options, resolve);
    originRequest.once("error", reject);
    originRequest.end(args.body);
  });
}

function responseHeaderPairs(response: IncomingMessage): HeaderPair[] {
  const headers: HeaderPair[] = [];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index];
    const value = response.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) {
      headers.push([name, value]);
    }
  }
  return headers;
}

function isInitialThreadLoad(path: string): boolean {
  if (!INITIAL_THREAD_LOAD_PATH.test(path)) {
    return false;
  }
  return !new URL(path, "http://bb.local").searchParams.has("afterSequence");
}

function roundDurationMs(durationMs: number): number {
  return Math.round(durationMs * 10) / 10;
}

/** True when this open-ws is the bb app's realtime socket via the bare handle. */
export function isBareBbRealtimeWs(
  path: string,
  target: string | undefined,
): boolean {
  if (target !== undefined) return false;
  // Spec: path starts with `/ws` and has no target.
  return path === "/ws" || path.startsWith("/ws?") || path.startsWith("/ws/");
}

interface HttpStream {
  meta: OpenHttpFrame;
  chunks: Buffer[];
  bytes: number;
  executing: boolean;
  bodyTimer?: ReturnType<typeof setTimeout>;
  abort: AbortController;
}
interface WsStream {
  socket: NodeWebSocket;
  buffered: Frame[];
  bufferedBytes: number;
  open: boolean;
  /** Counted toward remoteClients (bare-handle /ws). */
  countsAsRemoteClient: boolean;
}

interface ResolvedStreamOrigin {
  /** Fetch/WS base, e.g. `http://127.0.0.1:38886` or a share port. */
  origin: string;
  publicOrigin: string;
  preserveOrigin?: boolean;
  /** Injected Host for share streams; omitted for bare-handle. */
  host?: string;
}

export type StreamOriginResult =
  | { kind: "ok"; resolved: ResolvedStreamOrigin }
  | { kind: "unregistered" };

interface TunnelSessionOptions {
  tunnel: NodeWebSocket;
  log: TunnelClientLogger;
  /**
   * Resolve a frame's optional `target` (decimal port string) to a local
   * origin. Called for every open-http / open-ws.
   */
  resolveOrigin: (target: string | undefined) => StreamOriginResult;
  /** Fired when remoteClients transitions 0↔nonzero. */
  onRemoteClientsChange?: (remoteClients: number) => void;
  /** Fired on every relayed frame (any type). */
  onActivity?: (at: number) => void;
}

/** Proxies one live tunnel socket's frames to per-stream loopback origins. */
export class TunnelSession {
  private readonly httpStreams = new Map<number, HttpStream>();
  private readonly wsStreams = new Map<number, WsStream>();
  private bufferedBytes = 0;
  private disposed = false;
  private lastAck = Date.now();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private remoteClientCount = 0;
  lastRemoteActivityAt: number | null = null;

  constructor(private readonly options: TunnelSessionOptions) {}

  get remoteClients(): number {
    return this.remoteClientCount;
  }

  start(): void {
    const { tunnel } = this.options;
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastAck > HEARTBEAT_DEADLINE_MS) {
        this.options.log.warn("tunnel heartbeat missed; reconnecting");
        tunnel.terminate();
        return;
      }
      tunnel.send(HEARTBEAT_REQUEST);
    }, HEARTBEAT_INTERVAL_MS);

    tunnel.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        if (data.toString() === HEARTBEAT_RESPONSE) this.lastAck = Date.now();
        return;
      }
      try {
        if (data.byteLength > MAX_CHUNK_BYTES + 6) throw new Error("frame too large");
        this.onFrame(decodeFrame(data));
      } catch {
        this.options.log.warn("tunnel rejected malformed relay frame");
        this.dispose();
        tunnel.terminate();
      }
    });
    tunnel.on("close", () => this.dispose());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const s of this.httpStreams.values()) { clearTimeout(s.bodyTimer); s.abort.abort(); }
    for (const s of this.wsStreams.values())
      s.socket.terminate();
    this.bufferedBytes = 0;
    this.httpStreams.clear();
    this.wsStreams.clear();
    this.setRemoteClients(0);
  }

  private noteActivity(): void {
    const at = Date.now();
    this.lastRemoteActivityAt = at;
    this.options.onActivity?.(at);
  }

  private setRemoteClients(next: number): void {
    const prev = this.remoteClientCount;
    this.remoteClientCount = next;
    if ((prev === 0) !== (next === 0)) {
      this.options.onRemoteClientsChange?.(next);
    }
  }

  private adjustRemoteClients(delta: number): void {
    this.setRemoteClients(Math.max(0, this.remoteClientCount + delta));
  }

  private send(frame: Frame): void {
    if (!this.disposed && this.options.tunnel.readyState === NodeWebSocket.OPEN) {
      if (this.options.tunnel.bufferedAmount > MAX_BUFFERED_BYTES) {
        this.dispose(); this.options.tunnel.terminate(); return;
      }
      this.options.tunnel.send(encodeFrame(frame));
    }
  }

  private onFrame(frame: Frame): void {
    if (this.disposed) return;
    this.noteActivity();
    if (!Number.isInteger(frame.streamId) || frame.streamId < 0 || frame.streamId > 0xffffffff) throw new Error("invalid stream id");
    if (frame.type === "open-http" || frame.type === "open-ws") {
      validateOpenFrame(frame);
      if (this.httpStreams.has(frame.streamId) || this.wsStreams.has(frame.streamId)) throw new Error("duplicate stream");
      if (this.httpStreams.size + this.wsStreams.size >= MAX_STREAMS) {
        this.send({ type: "close-stream", streamId: frame.streamId, code: 1013, reason: "Tunnel capacity reached" });
        return;
      }
      if (this.options.resolveOrigin(frame.target).kind === "unregistered") {
        if (frame.type === "open-http") this.rejectUnregisteredHttp(frame.streamId);
        else this.send({ type: "close-stream", streamId: frame.streamId, code: 1008, reason: UNREGISTERED_PORT_BODY });
        return;
      }
    }
    switch (frame.type) {
      case "open-http": {
        const stream: HttpStream = {
          meta: frame,
          chunks: [],
          bytes: 0,
          executing: false,
          abort: new AbortController(),
        };
        this.httpStreams.set(frame.streamId, stream);
        if (!frame.hasBody) void this.executeHttp(frame.streamId, stream);
        else {
          stream.bodyTimer = setTimeout(() => this.rejectHttpStream(frame.streamId, stream, "Request body timed out"), BODY_RECEIVE_TIMEOUT_MS);
          stream.bodyTimer.unref?.();
        }
        return;
      }
      case "body-chunk": {
        const stream = this.httpStreams.get(frame.streamId);
        if (!stream) return;
        if (stream.executing) throw new Error("body after request complete");
        if (stream.chunks.length >= 8192 || frame.data.byteLength > MAX_CHUNK_BYTES || stream.bytes + frame.data.byteLength > MAX_REQUEST_BYTES || this.bufferedBytes + frame.data.byteLength > MAX_BUFFERED_BYTES) {
          this.rejectHttpStream(frame.streamId, stream, "Request body exceeds tunnel limit");
          return;
        }
        stream.chunks.push(Buffer.from(frame.data));
        stream.bytes += frame.data.byteLength;
        this.bufferedBytes += frame.data.byteLength;
        return;
      }
      case "body-end": {
        const s = this.httpStreams.get(frame.streamId);
        if (s) {
          if (s.executing) throw new Error("duplicate body end");
          void this.executeHttp(frame.streamId, s);
        }
        return;
      }
      case "open-ws":
        this.openOriginWs(frame);
        return;
      case "ws-data": {
        const s = this.wsStreams.get(frame.streamId);
        if (!s) return;
        if (s.buffered.length >= 4096 || s.bufferedBytes + s.socket.bufferedAmount + frame.data.byteLength > MAX_WS_BUFFER_BYTES || this.bufferedBytes + frame.data.byteLength > MAX_BUFFERED_BYTES) {
          s.socket.terminate(); this.forgetWsStream(frame.streamId, s);
          this.send({ type: "close-stream", streamId: frame.streamId, code: 1013, reason: "WebSocket buffer limit reached" });
          return;
        }
        if (!s.open) {
          s.bufferedBytes += frame.data.byteLength;
          this.bufferedBytes += frame.data.byteLength;
          s.buffered.push(frame);
          return;
        }
        s.socket.send(
          frame.isBinary ? frame.data : Buffer.from(frame.data).toString(),
        );
        return;
      }
      case "close-stream": {
        const h = this.httpStreams.get(frame.streamId);
        if (h) {
          h.abort.abort();
          this.forgetHttpStream(frame.streamId, h);
          return;
        }
        const w = this.wsStreams.get(frame.streamId);
        if (w) {
          const validCode = frame.code === 1000 || (Number.isInteger(frame.code) && frame.code >= 3000 && frame.code <= 4999);
          w.socket.close(validCode ? frame.code : 1000, typeof frame.reason === "string" ? Buffer.from(frame.reason).subarray(0, 120).toString() : "");
          this.forgetWsStream(frame.streamId, w);
        }
        return;
      }
      case "resp-head":
      case "ws-open-ack":
        return;
    }
  }

  private forgetHttpStream(streamId: number, stream: HttpStream): void {
    if (this.httpStreams.get(streamId) !== stream) return;
    clearTimeout(stream.bodyTimer);
    this.bufferedBytes -= stream.bytes;
    stream.chunks = []; stream.bytes = 0;
    this.httpStreams.delete(streamId);
  }

  private rejectHttpStream(streamId: number, stream: HttpStream, reason: string): void {
    stream.abort.abort(); this.forgetHttpStream(streamId, stream);
    this.send({ type: "close-stream", streamId, code: 1009, reason });
  }

  private forgetWsStream(streamId: number, stream: WsStream): void {
    if (this.wsStreams.get(streamId) !== stream) return;
    this.wsStreams.delete(streamId);
    this.bufferedBytes -= stream.bufferedBytes;
    stream.buffered = []; stream.bufferedBytes = 0;
    if (stream.countsAsRemoteClient) this.adjustRemoteClients(-1);
  }

  private rejectUnregisteredHttp(streamId: number): void {
    const body = textEncoder.encode(UNREGISTERED_PORT_BODY);
    this.send({
      type: "resp-head",
      streamId,
      status: 404,
      headers: [["content-type", "text/plain; charset=utf-8"]],
    });
    for (const c of chunkBody(streamId, body)) this.send(c);
    this.send({ type: "body-end", streamId });
  }

  private async executeHttp(
    streamId: number,
    stream: HttpStream,
  ): Promise<void> {
    if (stream.executing) throw new Error("request already executing");
    stream.executing = true;
    clearTimeout(stream.bodyTimer);
    const { meta } = stream;
    const originResult = this.options.resolveOrigin(meta.target);
    if (originResult.kind === "unregistered") {
      this.rejectUnregisteredHttp(streamId);
      this.forgetHttpStream(streamId, stream);
      return;
    }
    const { resolved } = originResult;
    try {
    const headers = headersForLoopbackRequest(meta.headers, {
      publicOrigin: resolved.publicOrigin,
      preserveOrigin: resolved.preserveOrigin,
      loopbackOrigin: new URL(resolved.origin).origin,
      ...(resolved.host !== undefined ? { host: resolved.host } : {}),
    });
      const startedAt = performance.now();
      const body = meta.hasBody ? Buffer.concat(stream.chunks) : undefined;
      stream.chunks = [];
      const res = await requestOriginHttp({
        url: new URL(`${resolved.origin.replace(/\/$/u, "")}${meta.path}`),
        method: meta.method,
        headers,
        body,
        signal: stream.abort.signal,
      });
      if (this.httpStreams.get(streamId) !== stream) { res.destroy(); return; }
      const originTtfbMs = performance.now() - startedAt;
      const respHeaders = responseHeaderPairs(res);
      const initialThreadLoad = isInitialThreadLoad(meta.path);
      if (initialThreadLoad) {
        respHeaders.push([
          "server-timing",
          `bb_connect_origin;dur=${roundDurationMs(originTtfbMs)}`,
        ]);
      }
      this.send({
        type: "resp-head",
        streamId,
        status: res.statusCode ?? 502,
        headers: respHeaders,
      });
      let responseBytes = 0;
      for await (const chunk of res) {
        if (this.httpStreams.get(streamId) !== stream) { res.destroy(); return; }
        const value =
          chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk));
        responseBytes += value.byteLength;
        for (const frame of chunkBody(streamId, value)) this.send(frame);
      }
      this.send({ type: "body-end", streamId });
      if (initialThreadLoad) {
        const totalMs = performance.now() - startedAt;
        this.options.log.info?.(
          [
            "bb connect thread load",
            `path=${new URL(meta.path, "http://bb.local").pathname}`,
            `status=${res.statusCode ?? 502}`,
            `originTtfbMs=${roundDurationMs(originTtfbMs)}`,
            `originBodyMs=${roundDurationMs(totalMs - originTtfbMs)}`,
            `totalMs=${roundDurationMs(totalMs)}`,
            `responseBytes=${responseBytes}`,
            `contentEncoding=${res.headers["content-encoding"] ?? "identity"}`,
          ].join(" "),
        );
      }
    } catch (e) {
      // Unreachable share ports and other fetch failures: clean close-stream,
      // not a crash. Aborted streams are silent.
      if (!stream.abort.signal.aborted) {
        this.send({
          type: "close-stream",
          streamId,
          code: 1011,
          reason: "Guest gateway request failed",
        });
      }
    } finally {
      this.forgetHttpStream(streamId, stream);
    }
  }

  private openOriginWs(frame: OpenWsFrame): void {
    const originResult = this.options.resolveOrigin(frame.target);
    if (originResult.kind === "unregistered") {
      this.send({
        type: "close-stream",
        streamId: frame.streamId,
        code: 1008,
        reason: UNREGISTERED_PORT_BODY,
      });
      return;
    }
    const { resolved } = originResult;
    const wsOrigin = resolved.origin.replace(/^http/, "ws");
    const headers = headersForLoopbackRequest(frame.headers, {
      publicOrigin: resolved.publicOrigin,
      preserveOrigin: resolved.preserveOrigin,
      loopbackOrigin: new URL(resolved.origin).origin,
      ...(resolved.host !== undefined ? { host: resolved.host } : {}),
    });
    const countsAsRemoteClient = isBareBbRealtimeWs(frame.path, frame.target);
    let socket: NodeWebSocket;
    try {
      socket = new NodeWebSocket(`${wsOrigin}${frame.path}`, frame.protocols, {
        headers,
        handshakeTimeout: 15_000,
        maxPayload: MAX_WS_BUFFER_BYTES,
      });
    } catch (e) {
      this.send({
        type: "close-stream",
        streamId: frame.streamId,
        code: 1011,
        reason: "Guest gateway request failed",
      });
      return;
    }
    const stream: WsStream = {
      socket,
      buffered: [],
      bufferedBytes: 0,
      open: false,
      countsAsRemoteClient,
    };
    this.wsStreams.set(frame.streamId, stream);
    if (countsAsRemoteClient) this.adjustRemoteClients(1);

    socket.on("open", () => {
      if (this.wsStreams.get(frame.streamId) !== stream) { socket.terminate(); return; }
      stream.open = true;
      this.send({
        type: "ws-open-ack",
        streamId: frame.streamId,
        protocol: socket.protocol || null,
      });
      const buffered = stream.buffered;
      this.bufferedBytes -= stream.bufferedBytes;
      stream.buffered = []; stream.bufferedBytes = 0;
      for (const b of buffered) this.onFrame(b);
    });
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      this.send({
        type: "ws-data",
        streamId: frame.streamId,
        isBinary,
        data: isBinary
          ? new Uint8Array(data)
          : new Uint8Array(Buffer.from(data.toString())),
      });
    });
    socket.on("close", (code: number, reason: Buffer) => {
      if (this.wsStreams.get(frame.streamId) === stream) {
        this.forgetWsStream(frame.streamId, stream);
        this.send({
          type: "close-stream",
          streamId: frame.streamId,
          code: code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000,
          reason: reason.toString(),
        });
      }
    });
    socket.on("error", (e: Error) => {
      // Dead share ports surface as socket errors; the subsequent 'close'
      // sends close-stream. Log only — do not throw.
      this.options.log.warn("guest gateway websocket failed");
    });
  }
}
