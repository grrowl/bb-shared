import { describe, expect, it } from "vitest";
import { WorkerLifecycle, type WorkerLifecycleDeps, type TunnelLike } from "./worker-lifecycle";
import { ConnectionRecordStore, normalizeConnectionUrl, CONNECTIONS_KEY, type ConnectionSnapshot } from "./worker-record";
import { InMemoryKeyProvider } from "../lib/device-key";
import type { SharedTunnelOptions, TunnelState } from "../lib/shared-tunnel";

function harness({wrongSecret = false, failedGateway = false, failSave = false} = {}) {
  let saved: ConnectionSnapshot = {version:1,defaultId:null,connections:[]};
  let options: SharedTunnelOptions;
  let state: TunnelState = "connecting";
  let stops = 0;
  const deps: WorkerLifecycleDeps = {
    recordStore:{load:async()=>saved,save:async s=>{if(failSave)throw Error('disk failed');saved=s;}},
    log:{warn(){}},publishStatus(){},getGatewayBaseUrl:()=>"http://127.0.0.1:9999",verifyReadiness:(_c,b)=>!!b && (b as {valid?:boolean}).valid === true,
    bundleWorker:async()=>"",readyTimeoutMs:20,probeIntervalMs:1,
    fetchImpl: (async input => String(input).includes('/relay')
      ? Response.json({service:'bb-shared-relay',version:1,protocolVersion:1,relayId:'relay-1'})
      : Response.json({valid:!failedGateway})) as typeof fetch,
    createTunnel: o => {
      options=o;
      const tunnel: TunnelLike = {start(){state=wrongSecret?'stopped':'connected';o.onStatusChange?.(state);},stop(){stops++;state='stopped';o.onStatusChange?.(state);},getStatus:()=>({state,workerUrl:o.workerUrl,remoteClients:0,lastConnectedAt:null,lastError:wrongSecret?'Pairing rejected':null})};
      return tunnel;
    },
  };
  return {lifecycle:new WorkerLifecycle(deps),get saved(){return saved;},get stops(){return stops;},transition(next:TunnelState){state=next;options.onStatusChange?.(next);}};
}

describe('verified connections',()=>{
  it('saves only after the authenticated tunnel reaches this gateway',async()=>{
    const h=harness();await h.lifecycle.registerConnection('share.example','a'.repeat(43));
    expect(h.saved.connections).toHaveLength(1);expect(h.lifecycle.listConnections()[0]).toMatchObject({state:'ready',isDefault:true,url:'https://share.example'});
    h.transition('reconnecting');expect(h.lifecycle.listConnections()[0].state).toBe('offline');h.lifecycle.stop();
  });
  it('does not save rejected pairing or unhealthy gateway',async()=>{
    for(const opts of [{wrongSecret:true},{failedGateway:true}]){
      const h=harness(opts);await expect(h.lifecycle.registerConnection('share.example','a'.repeat(43))).rejects.toThrow();
      expect(h.saved.connections).toHaveLength(0);expect(h.stops).toBe(1);h.lifecycle.stop();
    }
  });
  it('rejects aliases before opening a competing tunnel',async()=>{
    const h=harness();await h.lifecycle.registerConnection('one.example','a'.repeat(43));
    await expect(h.lifecycle.registerConnection('two.example','a'.repeat(43))).rejects.toThrow('another hostname');
    expect(h.stops).toBe(0);h.lifecycle.stop();
  });
  it('stops the candidate if durable save fails',async()=>{
    const h=harness({failSave:true});await expect(h.lifecycle.registerConnection('share.example','a'.repeat(43))).rejects.toThrow('disk failed');
    expect(h.lifecycle.listConnections()).toEqual([]);expect(h.stops).toBe(1);h.lifecycle.stop();
  });
  it('removes locally only after saving and clears default',async()=>{
    const h=harness();await h.lifecycle.registerConnection('share.example','a'.repeat(43));
    await h.lifecycle.removeConnection(h.saved.connections[0].id);expect(h.saved.defaultId).toBeNull();expect(h.stops).toBe(1);h.lifecycle.stop();
  });
});

describe('connection storage and URL boundary',()=>{
  it.each(['http://share.example','https://user:secret@share.example','https://share.example/path','https://share.example/?token=secret'])('rejects unsafe origin %s',input=>expect(()=>normalizeConnectionUrl(input)).toThrow());
  it('accepts a custom canonical HTTPS hostname',()=>expect(normalizeConnectionUrl('SHARE.example')).toBe('https://share.example'));
  it('encrypts credentials and preserves unreadable storage',async()=>{
    const map=new Map<string,unknown>();const kv={get:async<T>(key:string)=>map.get(key) as T,set:async(key:string,v:unknown)=>{map.set(key,v);}};
    const key=new InMemoryKeyProvider();const store=new ConnectionRecordStore(kv,key);
    const s:ConnectionSnapshot={version:1,defaultId:'one',connections:[{id:'one',relayId:'relay',url:'https://share.example',tunnelSecret:'a'.repeat(43),claim:null,createdAt:1}]};
    await store.save(s);expect(JSON.stringify(map.get(CONNECTIONS_KEY))).not.toContain(s.connections[0].tunnelSecret);expect(await store.load()).toEqual(s);
    const broken=new ConnectionRecordStore(kv,new InMemoryKeyProvider());await expect(broken.load()).rejects.toThrow('decrypted');await expect(broken.save(s)).rejects.toThrow('recovery');
    expect(await store.load()).toEqual(s);
  });
});
