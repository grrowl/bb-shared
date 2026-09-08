import { it, expect } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import WebSocket, { WebSocketServer } from "ws";
import { WORKER_SOURCE } from "../../plugin/worker-lifecycle/worker-source.generated";
import { SharedTunnel } from "../../plugin/lib/shared-tunnel";
import { createGuestGateway } from "../../plugin/guest-gateway/index";
import { InMemoryStore } from "../../plugin/lib/token-store";
import { InMemoryKeyProvider } from "../../plugin/lib/device-key";

it("real network: Worker → SharedTunnel → gateway → BB, including union access and revocation", async () => {
  const seen: {url?: string; origin?: string}[] = [];
  const peers = new Set<WebSocket>();
  const owner = createServer((req, res) => {
    seen.push({url:req.url, origin:req.headers.origin});
    res.setHeader("content-type", "application/json");
    if (req.url?.includes("fail=401")) {res.writeHead(401);res.end('{"error":"upstream unauthorized"}');return;}
    res.end('{"ok":true}');
  });
  const wsServer = new WebSocketServer({server: owner});
  wsServer.on("connection", peer => { peers.add(peer);peer.on("close", () => peers.delete(peer));peer.on("message", data => peer.send(data.toString() === '{"type":"ping"}' ? '{"type":"pong"}' : data.toString())); });
  owner.listen(0,"127.0.0.1");await once(owner,"listening");
  const ownerUrl = `http://127.0.0.1:${(owner.address() as {port:number}).port}`;
  const store = new InMemoryStore();const records = new Map<string, unknown>();
  const gateway = createGuestGateway({loopbackBaseUrl:ownerUrl,store,keyProvider:new InMemoryKeyProvider(Buffer.alloc(32,7)),storage:{async get<T>(key:string){return records.get(key) as T|undefined;},async set(key:string,value:unknown){records.set(key,value);}}});
  const gatewayUrl = await gateway.start();
  const mf = new Miniflare(convertV4MiniflareOptions({host:"127.0.0.1",port:0,modules:true,script:WORKER_SOURCE,compatibilityDate:"2025-06-01",durableObjects:{TUNNEL_DO:{className:"TunnelDO",useSQLite:true}},bindings:{TUNNEL_SECRET:"full-stack-secret"}}));
  let tunnel: SharedTunnel | undefined;let client:WebSocket|undefined;
  try {
    const relayUrl = (await mf.ready).origin;
    const connected = new Promise<void>((resolve) => {
      tunnel = new SharedTunnel({workerUrl:relayUrl,tunnelSecret:"full-stack-secret",loopbackBaseUrl:gatewayUrl,log:{warn(){}},onStatusChange:state=>{if(state==="connected")resolve();}});
      tunnel.start();
    });
    await connected;
    const request = (path:string, cookie?:string, method="GET") => fetch(relayUrl+path,{method,redirect:"manual",headers:{...(cookie?{cookie}:{}),origin:relayUrl,...(method === "POST" ? {"content-type":"application/json"} : {})},...(method === "POST" ? {body:JSON.stringify({input:[{type:"text",text:"Hello"}],mode:"queue-if-active"})} : {}),signal:AbortSignal.timeout(5000)});
    const ready = await request("/__bb_shared/ready?challenge=roundtrip");
    expect(ready.status).toBe(200);expect(gateway.verifyReadiness("roundtrip",await ready.json())).toBe(true);
    const a=await store.mintToken();await store.addShare(a.token.id,{thread_id:"t1",project_id:"p",perm:"read"});
    const b=await store.mintToken();await store.addShare(b.token.id,{thread_id:"t2",project_id:"p",perm:"write"});
    expect((await request("/api/v1/threads/t1")).status).toBe(401);
    const first=await request("/?token="+a.rawToken);expect(first.status).toBe(303);
    const cookie=first.headers.get("set-cookie")!.split(";")[0];
    const second=await request("/?token="+b.rawToken,cookie);expect(second.status).toBe(303);expect(second.headers.get("set-cookie")!.split(";")[0]).toBe(cookie);
    expect((await request("/api/v1/threads/t1",cookie)).status).toBe(200);
    expect((await request("/api/v1/threads/t2/send",cookie,"POST")).status).toBe(200);
    const crossOrigin = await fetch(relayUrl+"/api/v1/threads/t2/send",{method:"POST",headers:{cookie,origin:"https://unrelated.example","content-type":"application/json"},body:JSON.stringify({input:[{type:"text",text:"Hello"}],mode:"queue-if-active"})});
    expect(crossOrigin.status).toBe(403);
    expect((await request("/api/v1/threads/t1/send",cookie,"POST")).status).toBe(403);
    expect((await request("/api/v1/threads/private",cookie)).status).toBe(403);
    expect((await request("/api/v1/threads/t1?fail=401",cookie)).status).toBe(401);
    expect(seen.filter(req=>req.url?.startsWith("/api/v1/threads")).every(req=>req.origin===ownerUrl)).toBe(true);
    client = new WebSocket(relayUrl.replace("http:","ws:")+"/ws",{headers:{cookie},origin:"https://custom.example"});
    await once(client,"open");
    // Relay handshake precedes local origin acceptance; wait for BB's peer.
    if (!peers.size) await once(wsServer,"connection");
    const pong=once(client,"message");client.send('{"type":"ping"}');expect((await pong)[0].toString()).toBe('{"type":"pong"}');
    const closed=once(client,"close");await store.deleteToken(a.token.id);gateway.grantsChanged();await closed;
    expect((await request("/api/v1/threads/t1",cookie)).status).toBe(403);
    expect((await request("/api/v1/threads/t2",cookie)).status).toBe(200);
    await store.deleteToken(b.token.id);gateway.grantsChanged();expect((await request("/api/v1/threads/t2",cookie)).status).toBe(401);
  } finally {
    client?.terminate();tunnel?.stop();await mf.dispose();await gateway.stop();
    for(const peer of peers)peer.terminate();wsServer.close();owner.closeAllConnections();await new Promise<void>(resolve=>owner.close(()=>resolve()));
  }
}, 15000);
