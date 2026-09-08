// Real workerd integration: no fake WebSocketPair or status-101 Response.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { WORKER_SOURCE } from "../../plugin/worker-lifecycle/worker-source.generated";
import { decodeFrame, encodeFrame, type Frame } from "@bb-shared/tunnel-contract";

let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "relay", modules: true, script: WORKER_SOURCE, compatibilityDate: "2025-06-01", durableObjects: { TUNNEL_DO: { className: "TunnelDO", useSQLite: true } }, bindings: { TUNNEL_SECRET: "runtime-test-secret" } }] }));
  await mf.ready;
});
afterAll(async () => { await mf?.dispose(); });

describe("real relay runtime", () => {
  it("identifies the relay without requiring a guest invitation", async () => {
    const response = await mf.dispatchFetch("https://custom.example/__bb_shared/relay");
    expect(await response.json()).toMatchObject({service: "bb-shared-relay", version: 1, protocolVersion: 1, relayId: expect.any(String)});
  });
  it("reports disconnected transport as 503", async () => {
    const response = await mf.dispatchFetch("https://custom.example/__bb_shared/ready");
    expect(response.status).toBe(503);
    expect(response.headers.get("x-bb-tunnel-offline")).toBe("1");
  });
  it("rejects bad credentials and unsupported protocol before pairing", async () => {
    const bad = await mf.dispatchFetch("https://custom.example/__tunnel?v=1", {headers:{upgrade:"websocket", authorization:"Bearer wrong"}});
    expect(bad.status).toBe(401);
    const old = await mf.dispatchFetch("https://custom.example/__tunnel?v=2", {headers:{upgrade:"websocket", authorization:"Bearer runtime-test-secret"}});
    expect(old.status).toBe(426);
  });
  it("relays custom-origin requests and preserves 401 responses, cookies, and WebSocket frames", async () => {
    const paired = await mf.dispatchFetch("https://worker.example/__tunnel?v=1", {headers:{upgrade:"websocket", authorization:"Bearer runtime-test-secret"}});
    expect(paired.status).toBe(101);
    const socket = paired.webSocket!;
    socket.accept();
    const opens: Frame[] = [];
    const send = (frame: Frame) => socket.send(new Uint8Array(encodeFrame(frame)));
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") return;
      const frame = decodeFrame(event.data);
      opens.push(frame);
      if (frame.type === "open-http") {
        send({type:"resp-head",streamId:frame.streamId,status:401,headers:[["set-cookie","guest=one; Secure; HttpOnly"],["set-cookie","other=two; Secure; HttpOnly"]]});
        send({type:"body-chunk",streamId:frame.streamId,data:new TextEncoder().encode("unauthorized")});
        send({type:"body-end",streamId:frame.streamId});
      } else if (frame.type === "open-ws") {
        send({type:"ws-open-ack",streamId:frame.streamId,protocol:null});
      } else if (frame.type === "ws-data") {
        send(frame);
      }
    });
    const response = await mf.dispatchFetch("https://custom.example/__bb_shared/ready?x=1", {headers:{"x-bb-shared-public-origin":"https://forged.example"}});
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("unauthorized");
    expect(response.headers.get("set-cookie")).toContain("guest=one");
    expect(response.headers.get("set-cookie")).toContain("other=two");
    const open = opens.find(f => f.type === "open-http");
    expect(open).toMatchObject({path:"/__bb_shared/ready?x=1",headers:expect.arrayContaining([["x-bb-shared-public-origin","https://custom.example"]])});
    const upgraded = await mf.dispatchFetch("https://custom.example/ws", {headers:{upgrade:"websocket"}});
    expect(upgraded.status).toBe(101);
    const visitor = upgraded.webSocket!;
    visitor.accept();
    const message = new Promise(resolve => visitor.addEventListener("message", event => resolve(event.data), {once:true}));
    visitor.send("hello");
    expect(await message).toBe("hello");
    visitor.close();
    socket.close();
  });
});
