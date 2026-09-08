import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { createGuestGateway } from "./index";
import { InMemoryStore } from "../lib/token-store";
import { InMemoryKeyProvider } from "../lib/device-key";
import { COOKIE } from "./sessions";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });
async function fixture() {
  const seen: {url?:string; headers: Record<string, unknown>; body: string}[] = [];
  const owner = createServer(async (req,res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    seen.push({ url:req.url, headers:req.headers, body: Buffer.concat(chunks).toString() });
    if(req.url === "/api/v1/threads/t1?fail=401") { res.writeHead(401); res.end("unauthorized"); return; }
    if(req.url === "/") {res.setHeader("content-type","text/html"); res.end("<html><head></head><body>BB</body></html>");return;}
    res.setHeader("content-type","application/json");res.setHeader("set-cookie","owner=secret");
    res.end(JSON.stringify(req.url?.startsWith("/api/v1/sidebar-bootstrap") ? {projects:[{id:"p",threads:[{id:"t1"},{id:"t2"},{id:"private"}]}],sections:[]} : {ok:true}));
  });
  const ws = new WebSocketServer({server:owner}); const peers: WebSocket[]=[];
  ws.on("connection", socket => { peers.push(socket); socket.on("message",data => socket.send(data.toString() === '{"type":"ping"}' ? '{"type":"pong"}' : data.toString())); });
  owner.listen(0,"127.0.0.1"); await once(owner,"listening");
  cleanup.push(async () => {for(const peer of peers)peer.terminate();owner.closeAllConnections();await new Promise<void>(resolve=>owner.close(()=>resolve()));});
  const store = new InMemoryStore(); const state = new Map<string,unknown>();
  const options = {loopbackBaseUrl:`http://127.0.0.1:${(owner.address() as {port:number}).port}`,store,keyProvider:new InMemoryKeyProvider(Buffer.alloc(32,3)),storage:{async get<T>(key:string){return state.get(key) as T|undefined;}, async set(key:string,value:unknown){state.set(key,value);}}};
  let gateway = createGuestGateway(options); let url=await gateway.start();cleanup.push(()=>gateway.stop());
  async function mint(thread:string, perm:"read"|"write"="read") {const minted=await store.mintToken();await store.addShare(minted.token.id,{thread_id:thread,project_id:"p",perm});return minted;}
  async function redeem(raw:string,cookie?:string) {const res=await fetch(`${url}/?token=${raw}`,{redirect:"manual",headers:cookie?{cookie}:{}});expect(res.status).toBe(303);expect(res.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Lax");return res.headers.get("set-cookie")!.split(";")[0];}
  return {store,state,seen,peers,mint,redeem,get url(){return url;},get gateway(){return gateway;},async restart(){await gateway.stop();gateway=createGuestGateway(options);url=await gateway.start();}};
}
describe("local guest boundary",()=>{
  it("redeems union access, applies strongest live grant and survives restart",async()=>{
    const f=await fixture();const a=await f.mint("t1");const b=await f.mint("t2");const c=await f.mint("t1","write");
    const first=await f.redeem(a.rawToken);const cookie=await f.redeem(b.rawToken,first);await f.redeem(c.rawToken,cookie);
    expect(cookie).toBe(first);
    const get=(path:string,method="GET")=>fetch(f.url+path,{method,headers:{cookie,"content-type":"application/json"},body:method==="POST"?JSON.stringify({input:[{type:"text",text:"hello"}],mode:"auto"}):undefined});
    expect((await get("/api/v1/threads/t1/send","POST")).status).toBe(200);
    expect((await get("/api/v1/threads/t2")).status).toBe(200);
    await f.restart();expect((await get("/api/v1/threads/t2")).status).toBe(200);
    await f.store.deleteToken(c.token.id);f.gateway.grantsChanged();expect((await get("/api/v1/threads/t1/send","POST")).status).toBe(403);
    await f.store.deleteToken(a.token.id);expect((await get("/api/v1/threads/t1")).status).toBe(403);
    expect((await get("/api/v1/threads/t2")).status).toBe(200);
    await f.store.deleteToken(b.token.id);expect((await get("/api/v1/threads/t2")).status).toBe(401);
    expect(JSON.stringify([...f.state.values()])).not.toContain(cookie.split("=")[1]);
  });
  it("denies private routes and malformed cookies; strips owner credentials, shapes bootstrap and preserves 401",async()=>{
    const f=await fixture();const token=await f.mint("t1");const cookie=await f.redeem(token.rawToken);
    for(const path of ["/api/v1/plugins/shared/http/authz","/api/v1/hosts/owner","/api/v1/projects/p/threads","/api/v1/threads/t1/host-files/content","/api/v1/threads/t1/thread-storage/content","/api/v1/threads/private",`/${token.rawToken}/`])expect((await fetch(f.url+path,{headers:{cookie}})).status).toBe(403);
    expect((await fetch(f.url+"/",{headers:{cookie:`${COOKIE}=%ZZ`}})).status).toBe(401);
    expect((await fetch(f.url+"/",{headers:{cookie:`${cookie}; ${cookie}`}})).status).toBe(401);
    const response=await fetch(f.url+"/api/v1/threads/t1?fail=401",{headers:{cookie:cookie+"; owner=secret",authorization:"Bearer owner",origin:"https://custom.example","x-forwarded-host":"evil","x-bb-token":"secret"}});
    expect(response.status).toBe(401);
    const headers=f.seen.at(-1)!.headers;expect(headers.cookie).toBeUndefined();expect(headers.authorization).toBeUndefined();expect(headers["x-bb-token"]).toBeUndefined();expect(headers["x-forwarded-host"]).toBeUndefined();expect(headers.origin).toMatch(/^http:\/\/127.0.0.1:/);
    const sidebar=await fetch(f.url+"/api/v1/sidebar-bootstrap",{headers:{cookie}});expect(sidebar.headers.get("set-cookie")).toBeNull();expect((await sidebar.json()).projects[0].threads).toEqual([{id:"t1"}]);
    const html=await (await fetch(f.url+"/",{headers:{cookie}})).text();expect(html).toContain("<script");
  });
  it("limits write invitations to text and preserves the owner's execution policy", async () => {
    const f = await fixture(); const grant = await f.mint("t1", "write"); const cookie = await f.redeem(grant.rawToken);
    const send = (body: unknown) => fetch(f.url + "/api/v1/threads/t1/send", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await send({ input: [{ type: "localFile", path: "/etc/passwd" }], mode: "auto" })).status).toBe(400);
    expect((await send({ input: [{ type: "text", text: "hello", mentions: [{ path: "/private" }] }], mode: "auto", permissionMode: "full", model: "expensive", senderThreadId: "private", executionInputSources: {} })).status).toBe(200);
    expect(JSON.parse(f.seen.at(-1)!.body)).toEqual({input:[{type:"text",text:"hello",mentions:[]}],mode:"auto"});
    expect((await fetch(f.url + "/api/v1/threads/t1?include=host,environment", {headers:{cookie}})).status).toBe(200);
    expect(f.seen.at(-1)!.url).toBe("/api/v1/threads/t1");
    expect((await fetch(f.url + "/api/v1/threads/t1", {method:"OPTIONS",headers:{cookie,"content-type":"application/json"}})).status).toBe(403);
  });
  it("filters real sockets and closes them when permissions change",async()=>{
    const f=await fixture();const token=await f.mint("t1");const cookie=await f.redeem(token.rawToken);
    const client=new WebSocket(f.url.replace("http:","ws:")+"/ws",{headers:{cookie}});await once(client,"open");
    const pong=once(client,"message");client.send('{"type":"ping"}');expect((await pong)[0].toString()).toBe('{"type":"pong"}');
    const message=once(client,"message");f.peers[0].send('{"type":"changed","entity":"thread","id":"private"}');f.peers[0].send('{"type":"changed","entity":"thread","id":"t1"}');expect((await message)[0].toString()).toContain('"t1"');
    const closed=once(client,"close");await f.store.deleteToken(token.token.id);f.gateway.grantsChanged();expect((await closed)[0]).toBe(1008);
  });
  it("expires sessions, rejects cross-site writes and serializes concurrent invitation additions", async () => {
    const f = await fixture(); const first = await f.mint("t1", "write"); const cookie = await f.redeem(first.rawToken);
    const second = await f.mint("t2"); const third = await f.mint("t3");
    await Promise.all([f.redeem(second.rawToken, cookie), f.redeem(third.rawToken, cookie)]);
    for (const id of ["t1", "t2", "t3"]) expect((await fetch(f.url + "/api/v1/threads/" + id, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(f.url + "/api/v1/threads/t1/send", { method: "POST", headers: { cookie, "content-type": "application/json", origin: "https://evil.example", "x-bb-shared-public-origin": "https://share.example" }, body: "{}" })).status).toBe(403);
    const now = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(now + 31 * 86400_000);
    try { expect((await fetch(f.url + "/api/v1/threads/t1", { headers: { cookie } })).status).toBe(401); } finally { clock.mockRestore(); }
  });
  it("readiness proves this gateway and a working BB upstream",async()=>{
    const f=await fixture();const body=await(await fetch(f.url+"/__bb_shared/ready?challenge=nonce")).json();expect(f.gateway.verifyReadiness("nonce",body)).toBe(true);expect(f.gateway.verifyReadiness("other",body)).toBe(false);
  });
});
