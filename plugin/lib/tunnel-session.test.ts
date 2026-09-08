import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFrame, encodeFrame, type Frame, type OpenHttpFrame } from "@bb-shared/tunnel-contract";
import { TunnelSession } from "../../packages/bb-shared-tunnel-client/src/session.js";

class Relay extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: Frame[] = [];
  terminate = vi.fn(() => this.emit("close"));
  send(data: Uint8Array) { this.sent.push(decodeFrame(data)); }
  receive(frame: Frame) { this.emit("message", Buffer.from(encodeFrame(frame)), true); }
}
const sessions: TunnelSession[] = [];
afterEach(() => { sessions.splice(0).forEach((session) => session.dispose()); });
function setup(origin = "http://127.0.0.1:1") {
  const relay = new Relay();
  const log = { warn: vi.fn(), info: vi.fn() };
  const session = new TunnelSession({ tunnel: relay as unknown as WebSocket, log, resolveOrigin: () => ({ kind: "ok", resolved: { origin, publicOrigin: "https://share.example" } }) });
  session.start(); sessions.push(session);
  return { relay, log };
}
const open = (streamId = 1): OpenHttpFrame => ({ type: "open-http", streamId, path: "/", method: "POST", headers: [], hasBody: true });

describe("relay input bounds", () => {
  it("terminates malformed metadata without including it in logs", () => {
    const { relay, log } = setup();
    relay.receive({ ...open(), path: "//other-host/?token=secret" });
    expect(relay.terminate).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith("tunnel rejected malformed relay frame");
  });
  it("rejects duplicate streams", () => {
    const { relay } = setup(); relay.receive(open()); relay.receive(open());
    expect(relay.terminate).toHaveBeenCalledOnce();
  });
  it("bounds pending streams", () => {
    const { relay } = setup();
    for (let id = 1; id <= 129; id++) relay.receive(open(id));
    expect(relay.sent.at(-1)).toMatchObject({ type: "close-stream", streamId: 129, code: 1013 });
  });
  it("bounds request body buffering and accepts a new request afterward", () => {
    const { relay } = setup(); relay.receive(open());
    for (let i = 0; i < 9; i++) relay.receive({ type: "body-chunk", streamId: 1, data: new Uint8Array(1024 * 1024) });
    expect(relay.sent.at(-1)).toMatchObject({ type: "close-stream", streamId: 1, code: 1009 });
    relay.receive(open(2)); expect(relay.terminate).not.toHaveBeenCalled();
  });
  it("does not execute a request twice on duplicate body-end", async () => {
    const { relay } = setup(); relay.receive(open());
    relay.receive({ type: "body-end", streamId: 1 }); relay.receive({ type: "body-end", streamId: 1 });
    expect(relay.terminate).toHaveBeenCalledOnce();
  });
  it("forwards HTTP status unchanged and strips query credentials from timing logs", async () => {
    const server = createServer((_request, response) => { response.writeHead(401); response.end("Unauthorized"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { relay, log } = setup(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      relay.receive({ ...open(), method: "GET", hasBody: false, path: "/api/v1/threads/th_1/timeline?token=secret" });
      await vi.waitFor(() => expect(relay.sent.some((frame) => frame.type === "body-end")).toBe(true));
      expect(relay.sent[0]).toMatchObject({ type: "resp-head", status: 401 });
      expect(log.info.mock.calls.flat().join(" ")).not.toContain("secret");
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
